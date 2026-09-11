import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  CaptureProfileResult,
  ControllerSnapshot,
  OpenRgbSnapshot,
  RgbColor,
  SavedProfile,
  ZoneSnapshot,
} from "./types";

type EditorMode = "new" | "edit" | "duplicate";

type EditorZone = {
  controller_id: number;
  controller_name: string;
  zone_id: number;
  zone_name: string;
  zone_type: string;
  led_count: number;
  color: RgbColor;
  was_multicolor: boolean;
};

type ProfileEditorState = {
  mode: EditorMode;
  name: string;
  original_name: string | null;
  base_profile_name: string | null;
  zones: EditorZone[];
  initial_zones: EditorZone[];
};

type ZoneColorInput = {
  controller_id: number;
  zone_id: number;
  color: RgbColor;
};

type LivePreviewState = "idle" | "waiting" | "applying" | "applied" | "error";

type LiveApplyRequest = {
  session: number;
  zoneColors: ZoneColorInput[];
};

type UnifiedProfileEntry = {
  name: string;
  saved: SavedProfile | null;
  in_openrgb: boolean | null;
};

type SchedulerTask = {
  name: string;
  cron_line: string;
  run: boolean;
  action: number;
  sub_action?: string;
  next_run?: number;
  [key: string]: unknown;
};

type SchedulerSnapshot = {
  installed: boolean;
  settings_exists: boolean;
  settings_path: string;
  tasks: SchedulerTask[];
};

type SchedulerDraftTask = SchedulerTask & {
  __companion_id: string;
  __companion_origin_index: number | null;
  __companion_deleted: boolean;
};

type SchedulerRowStatus = "clean" | "new" | "changed" | "deleted";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

function isValidOpenRgbProfileName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && PROFILE_NAME_PATTERN.test(name);
}

function dailyTimeFromCron(cron: string): string | null {
  const match = /^0\s+(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\?$/.exec(cron.trim());
  if (!match) return null;
  const minute = Number.parseInt(match[1], 10);
  const hour = Number.parseInt(match[2], 10);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cronFromDailyTime(value: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return `0 ${minute} ${hour} * * ?`;
}

function schedulerComparable(tasks: SchedulerTask[]): string {
  return JSON.stringify(tasks);
}

function schedulerTaskForSave(task: SchedulerDraftTask): SchedulerTask {
  const {
    __companion_id: _id,
    __companion_origin_index: _originIndex,
    __companion_deleted: _deleted,
    ...persisted
  } = task;
  return persisted;
}

function schedulerDraftsFromTasks(tasks: SchedulerTask[]): SchedulerDraftTask[] {
  return tasks.map((task, index) => ({
    ...task,
    __companion_id: `existing-${index}`,
    __companion_origin_index: index,
    __companion_deleted: false,
  }));
}

function schedulerPersistedTasks(tasks: SchedulerDraftTask[]): SchedulerTask[] {
  return tasks
    .filter((task) => !task.__companion_deleted)
    .map(schedulerTaskForSave);
}

function schedulerRowStatus(
  task: SchedulerDraftTask,
  baselineTasks: SchedulerTask[],
): SchedulerRowStatus {
  if (task.__companion_deleted) return "deleted";
  if (task.__companion_origin_index === null) return "new";

  const baseline = baselineTasks[task.__companion_origin_index];
  if (!baseline) return "changed";

  return schedulerComparable([schedulerTaskForSave(task)]) === schedulerComparable([baseline])
    ? "clean"
    : "changed";
}

function schedulerStatusLabel(status: SchedulerRowStatus): string | null {
  if (status === "new") return "新規・未反映";
  if (status === "changed") return "変更あり";
  if (status === "deleted") return "削除予定";
  return null;
}

function rgbText(color: RgbColor | null): string {
  if (!color) return "—";
  return `${color.r}, ${color.g}, ${color.b}`;
}

function hexText(color: RgbColor | null): string {
  if (!color) return "—";
  return `#${[color.r, color.g, color.b]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function colorStyle(color: RgbColor | null) {
  if (!color) return undefined;
  return {
    backgroundColor: `rgb(${color.r} ${color.g} ${color.b})`,
    backgroundImage: "none",
  };
}

function zoneSummary(zone: ZoneSnapshot) {
  if (zone.led_count === 0) return "LEDなし";
  if (zone.uniform_color) return `RGB ${rgbText(zone.uniform_color)}`;
  return `複数色 (${zone.colors.length} LEDs)`;
}

function capturedAtText(value: number): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function savedProfileStats(profile: SavedProfile) {
  const zones = profile.controllers.reduce((sum, controller) => sum + controller.zones.length, 0);
  const leds = profile.controllers.reduce((sum, controller) => sum + controller.led_count, 0);
  return { zones, leds };
}

function editorZonesFromControllers(controllers: ControllerSnapshot[]): EditorZone[] {
  return controllers.flatMap((controller) =>
    controller.zones.map((zone) => ({
      controller_id: controller.id,
      controller_name: controller.name || `Controller ${controller.id}`,
      zone_id: zone.id,
      zone_name: zone.name || `Zone ${zone.id}`,
      zone_type: zone.zone_type,
      led_count: zone.led_count,
      color: zone.uniform_color ?? zone.colors[0] ?? { r: 0, g: 0, b: 0 },
      was_multicolor: !zone.uniform_color && zone.colors.length > 1,
    })),
  );
}

function cloneEditorZones(zones: EditorZone[]): EditorZone[] {
  return zones.map((zone) => ({
    ...zone,
    color: { ...zone.color },
  }));
}

function clampRgb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function editorDraftKey(zoneIndex: number, channel: keyof RgbColor): string {
  return `${zoneIndex}:${channel}`;
}

function makeEditorDrafts(zones: EditorZone[]): Record<string, string> {
  const drafts: Record<string, string> = {};
  zones.forEach((zone, zoneIndex) => {
    (["r", "g", "b"] as const).forEach((channel) => {
      drafts[editorDraftKey(zoneIndex, channel)] = String(zone.color[channel]);
    });
  });
  return drafts;
}

function savedProfileZonePayload(profile: SavedProfile): ZoneColorInput[] {
  return profile.controllers.flatMap((controller) =>
    controller.zones.map((zone) => ({
      controller_id: controller.id,
      zone_id: zone.id,
      color: zone.uniform_color ?? zone.colors[0] ?? { r: 0, g: 0, b: 0 },
    })),
  );
}

function editorZonesPayload(zones: EditorZone[]): ZoneColorInput[] {
  return zones.map((zone) => ({
    controller_id: zone.controller_id,
    zone_id: zone.zone_id,
    color: zone.color,
  }));
}

function livePreviewLabel(enabled: boolean, state: LivePreviewState): string {
  if (!enabled) return "OFF";
  if (state === "waiting") return "待機中";
  if (state === "applying") return "反映中…";
  if (state === "applied") return "反映済み";
  if (state === "error") return "エラー";
  return "ON";
}

function hexToRgb(value: string): RgbColor | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const raw = match[1];
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function ControllerView({ controller, compact = false }: { controller: ControllerSnapshot; compact?: boolean }) {
  return (
    <article className={compact ? "controller-card compact" : "controller-card"}>
      <div className="controller-header">
        <div>
          <span className="device-type">{controller.device_type}</span>
          <h3>{controller.name || "Unnamed controller"}</h3>
          <p>{[controller.vendor, controller.description].filter(Boolean).join(" · ") || "詳細情報なし"}</p>
        </div>
        <div className="controller-meta">
          <span>ID {controller.id}</span>
          <span>{controller.led_count} LEDs</span>
          <span>{controller.active_mode}</span>
        </div>
      </div>

      <div className="zone-list">
        {controller.zones.length === 0 ? (
          <div className="zone-row empty">Zone情報なし</div>
        ) : (
          controller.zones.map((zone) => (
            <div className="zone-block" key={`${controller.id}-${zone.id}`}>
              <div className="zone-row">
                <div
                  className={zone.uniform_color ? "color-swatch has-color" : "color-swatch"}
                  style={colorStyle(zone.uniform_color)}
                  title={zone.uniform_color ? `${rgbText(zone.uniform_color)} / ${hexText(zone.uniform_color)}` : "複数色または色不明"}
                />
                <div className="zone-name">
                  <strong>{zone.name || `Zone ${zone.id}`}</strong>
                  <span>{zone.zone_type} · {zone.led_count} LEDs</span>
                </div>
                <div className="zone-value">
                  <strong>{zoneSummary(zone)}</strong>
                  <span>{zone.uniform_color ? hexText(zone.uniform_color) : "LEDごとの値を保存済み"}</span>
                </div>
              </div>

              {!zone.uniform_color && zone.colors.length > 0 && (
                <details className="led-details">
                  <summary>LEDごとのRGB値を表示 ({zone.colors.length})</summary>
                  <div className="led-value-grid">
                    {zone.colors.map((color, index) => (
                      <span key={index}>
                        <i style={colorStyle(color)} />
                        LED {index + 1}: {rgbText(color)}
                      </span>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))
        )}
      </div>

      {!compact && (controller.serial || controller.location || controller.version) && (
        <details className="details">
          <summary>識別情報</summary>
          <dl>
            <div><dt>Serial</dt><dd>{controller.serial || "—"}</dd></div>
            <div><dt>Location</dt><dd>{controller.location || "—"}</dd></div>
            <div><dt>Version</dt><dd>{controller.version || "—"}</dd></div>
          </dl>
        </details>
      )}
    </article>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<OpenRgbSnapshot | null>(null);
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [capturingProfile, setCapturingProfile] = useState<string | null>(null);
  const [openRgbError, setOpenRgbError] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [editor, setEditor] = useState<ProfileEditorState | null>(null);
  const [editorBusy, setEditorBusy] = useState<"preview" | "save" | "discard" | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const [editorDrafts, setEditorDrafts] = useState<Record<string, string>>({});
  const [applyingSavedProfile, setApplyingSavedProfile] = useState<string | null>(null);
  const [savingSavedProfile, setSavingSavedProfile] = useState<string | null>(null);
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [livePreviewState, setLivePreviewState] = useState<LivePreviewState>("idle");
  const [pendingEditSave, setPendingEditSave] = useState(false);
  const [pendingDiscardChanges, setPendingDiscardChanges] = useState(false);
  const [schedulerSnapshot, setSchedulerSnapshot] = useState<SchedulerSnapshot | null>(null);
  const [schedulerTasks, setSchedulerTasks] = useState<SchedulerDraftTask[]>([]);
  const [schedulerBaselineTasks, setSchedulerBaselineTasks] = useState<SchedulerTask[]>([]);
  const [schedulerLoading, setSchedulerLoading] = useState(true);
  const [schedulerSaving, setSchedulerSaving] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [schedulerMessage, setSchedulerMessage] = useState<string | null>(null);
  const [pendingSchedulerReload, setPendingSchedulerReload] = useState(false);
  const editorSessionRef = useRef(0);
  const liveApplyInFlightRef = useRef(false);
  const liveApplyPendingRef = useRef<LiveApplyRequest | null>(null);
  const livePreviewDebounceTimerRef = useRef<number | null>(null);
  const liveApplySuspendedRef = useRef(false);
  const editorTouchedHardwareRef = useRef(false);
  const schedulerNewIdRef = useRef(0);

  const totalZones = useMemo(
    () => snapshot?.controllers.reduce((sum, c) => sum + c.zones.length, 0) ?? 0,
    [snapshot],
  );

  const schedulerDirty = useMemo(
    () => schedulerComparable(schedulerPersistedTasks(schedulerTasks)) !== schedulerComparable(schedulerBaselineTasks),
    [schedulerTasks, schedulerBaselineTasks],
  );

  const unifiedProfiles = useMemo<UnifiedProfileEntry[]>(() => {
    const savedByName = new Map(savedProfiles.map((profile) => [profile.name, profile]));

    if (!snapshot) {
      return savedProfiles.map((profile) => ({
        name: profile.name,
        saved: profile,
        in_openrgb: null,
      }));
    }

    const openRgbNames = new Set(snapshot.profiles);
    const entries: UnifiedProfileEntry[] = snapshot.profiles.map((name) => ({
      name,
      saved: savedByName.get(name) ?? null,
      in_openrgb: true,
    }));

    for (const profile of savedProfiles) {
      if (!openRgbNames.has(profile.name)) {
        entries.push({
          name: profile.name,
          saved: profile,
          in_openrgb: false,
        });
      }
    }

    return entries;
  }, [snapshot, savedProfiles]);

  const knownProfileNames = useMemo(() => {
    const names = new Set<string>(snapshot?.profiles ?? []);
    for (const profile of savedProfiles) names.add(profile.name);
    return names;
  }, [snapshot, savedProfiles]);

  const editorNameConflict = useMemo(() => {
    if (!editor) return false;
    const name = editor.name.trim();
    if (!name) return false;
    if (editor.mode === "edit" && name === editor.original_name) return false;
    return knownProfileNames.has(name);
  }, [editor, knownProfileNames]);

  const editorNameInvalid = useMemo(() => {
    if (!editor) return false;
    const name = editor.name.trim();
    if (!name) return false;
    return !isValidOpenRgbProfileName(name);
  }, [editor]);

  const editorHasColorChanges = useMemo(() => {
    if (!editor) return false;

    return editor.zones.some((zone, zoneIndex) => {
      const initial = editor.initial_zones[zoneIndex];
      if (!initial) return true;
      if (
        zone.controller_id !== initial.controller_id ||
        zone.zone_id !== initial.zone_id
      ) return true;

      return (["r", "g", "b"] as const).some((channel) => {
        const rawValue =
          editorDrafts[editorDraftKey(zoneIndex, channel)] ??
          String(zone.color[channel]);
        const currentValue = clampRgb(
          rawValue.trim() === "" ? 0 : Number(rawValue),
        );
        return currentValue !== initial.color[channel];
      });
    });
  }, [editor, editorDrafts]);

  async function loadSchedulerSettings() {
    setSchedulerLoading(true);
    setSchedulerError(null);
    try {
      const result = await invoke<SchedulerSnapshot>("load_scheduler_settings");
      setSchedulerSnapshot(result);
      setSchedulerBaselineTasks(result.tasks);
      setSchedulerTasks(schedulerDraftsFromTasks(result.tasks));
      setPendingSchedulerReload(false);
    } catch (e) {
      setSchedulerSnapshot(null);
      setSchedulerTasks([]);
      setSchedulerBaselineTasks([]);
      setSchedulerError(String(e));
    } finally {
      setSchedulerLoading(false);
    }
  }

  function updateSchedulerTask(index: number, patch: Partial<SchedulerTask>) {
    setSchedulerTasks((current) =>
      current.map((task, taskIndex) => (taskIndex === index ? { ...task, ...patch } : task)),
    );
    setSchedulerMessage(null);
  }

  function addSchedulerTask() {
    const firstProfile = snapshot?.profiles[0] ?? "";
    const activeCount = schedulerTasks.filter((task) => !task.__companion_deleted).length;
    const nextNumber = activeCount + 1;
    schedulerNewIdRef.current += 1;

    setSchedulerTasks((current) => [
      ...current,
      {
        name: `Schedule ${nextNumber}`,
        cron_line: "0 0 22 * * ?",
        run: true,
        action: 0,
        sub_action: firstProfile,
        __companion_id: `new-${schedulerNewIdRef.current}`,
        __companion_origin_index: null,
        __companion_deleted: false,
      },
    ]);
    setSchedulerMessage(null);
  }

  function removeSchedulerTask(index: number) {
    setSchedulerTasks((current) => {
      const target = current[index];
      if (!target) return current;

      if (target.__companion_origin_index === null) {
        return current.filter((_, taskIndex) => taskIndex !== index);
      }

      return current.map((task, taskIndex) =>
        taskIndex === index ? { ...task, __companion_deleted: true } : task,
      );
    });
    setSchedulerMessage(null);
  }

  function restoreSchedulerTask(index: number) {
    setSchedulerTasks((current) =>
      current.map((task, taskIndex) =>
        taskIndex === index ? { ...task, __companion_deleted: false } : task,
      ),
    );
    setSchedulerMessage(null);
  }

  function requestReloadSchedulerSettings() {
    if (schedulerSaving || schedulerLoading) return;
    if (schedulerDirty) {
      setPendingSchedulerReload(true);
      return;
    }
    void loadSchedulerSettings();
  }

  async function confirmReloadSchedulerSettings() {
    setPendingSchedulerReload(false);
    await loadSchedulerSettings();
  }

  async function saveSchedulerSettings() {
    if (!schedulerSnapshot?.installed || schedulerSaving) return;

    setSchedulerSaving(true);
    setSchedulerError(null);
    setSchedulerMessage(null);

    try {
      const tasksToSave = schedulerPersistedTasks(schedulerTasks);
      const result = await invoke<SchedulerSnapshot>("save_scheduler_settings", {
        tasks: tasksToSave,
      });
      setSchedulerSnapshot(result);
      setSchedulerBaselineTasks(result.tasks);
      setSchedulerTasks(schedulerDraftsFromTasks(result.tasks));
      setPendingSchedulerReload(false);
      setSchedulerMessage("Scheduler設定を保存し、OpenRGBへ反映しました。");
      await scan();
    } catch (e) {
      setSchedulerError(String(e));
    } finally {
      setSchedulerSaving(false);
    }
  }

  async function loadSavedProfiles() {
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const result = await invoke<SavedProfile[]>("list_saved_profiles");
      setSavedProfiles(result);
    } catch (e) {
      setLedgerError(String(e));
    } finally {
      setLedgerLoading(false);
    }
  }

  async function scan() {
    setLoading(true);
    setOpenRgbError(null);
    setMessage(null);
    try {
      const result = await invoke<OpenRgbSnapshot>("scan_openrgb");
      setSnapshot(result);
    } catch (e) {
      setSnapshot(null);
      setOpenRgbError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshSnapshotSilently(): Promise<OpenRgbSnapshot | null> {
    try {
      const result = await invoke<OpenRgbSnapshot>("scan_openrgb");
      setSnapshot(result);
      return result;
    } catch {
      return null;
    }
  }

  async function captureProfile(profileName: string) {
    setCapturingProfile(profileName);
    setOpenRgbError(null);
    setLedgerError(null);
    setMessage(null);
    try {
      const result = await invoke<CaptureProfileResult>("capture_openrgb_profile", {
        profileName,
      });
      setSnapshot(result.snapshot);
      await loadSavedProfiles();
      setMessage(`「${result.profile.name}」をCompanionへ記録しました。`);
    } catch (e) {
      setOpenRgbError(String(e));
    } finally {
      setCapturingProfile(null);
    }
  }

  async function confirmDeleteSavedProfile() {
    if (!pendingDelete) return;

    const profileName = pendingDelete;
    setPendingDelete(null);
    setLedgerError(null);
    setMessage(null);
    try {
      await invoke("delete_saved_profile", { profileName });
      await loadSavedProfiles();
      setMessage(`Companion側の「${profileName}」の記録を削除しました。`);
    } catch (e) {
      setLedgerError(String(e));
    }
  }

  function suggestDuplicateName(baseName: string): string {
    const first = `${baseName}-copy`;
    if (!knownProfileNames.has(first)) return first;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${baseName}-copy${index}`;
      if (!knownProfileNames.has(candidate)) return candidate;
    }
    return `${baseName}-${Date.now()}`;
  }

  function clearLivePreviewDebounce() {
    if (livePreviewDebounceTimerRef.current !== null) {
      window.clearTimeout(livePreviewDebounceTimerRef.current);
      livePreviewDebounceTimerRef.current = null;
    }
  }

  function beginEditorSession() {
    editorSessionRef.current += 1;
    liveApplySuspendedRef.current = false;
    liveApplyPendingRef.current = null;
    clearLivePreviewDebounce();
    editorTouchedHardwareRef.current = false;
    setLivePreviewState("idle");
  }

  function markEditorColorChanged() {
    setEditorStatus(null);
    setEditorError(null);
  }

  function queueLivePreview(zoneColors: ZoneColorInput[]) {
    if (!livePreviewEnabled || liveApplySuspendedRef.current || editorBusy !== null) return;

    clearLivePreviewDebounce();
    const session = editorSessionRef.current;
    setLivePreviewState("waiting");

    livePreviewDebounceTimerRef.current = window.setTimeout(() => {
      livePreviewDebounceTimerRef.current = null;
      if (
        session !== editorSessionRef.current ||
        !livePreviewEnabled ||
        liveApplySuspendedRef.current
      ) return;

      liveApplyPendingRef.current = {
        session,
        zoneColors,
      };
      void flushLivePreviewQueue();
    }, 180);
  }

  async function flushLivePreviewQueue() {
    if (liveApplyInFlightRef.current) return;
    liveApplyInFlightRef.current = true;

    try {
      while (liveApplyPendingRef.current) {
        const request = liveApplyPendingRef.current;
        liveApplyPendingRef.current = null;

        if (
          request.session !== editorSessionRef.current ||
          !livePreviewEnabled ||
          liveApplySuspendedRef.current
        ) continue;

        setLivePreviewState("applying");
        try {
          await invoke("apply_live_zone_colors", { zoneColors: request.zoneColors });
          if (request.session === editorSessionRef.current) {
            editorTouchedHardwareRef.current = true;
            setLivePreviewState("applied");
            setEditorError(null);
          }
        } catch (e) {
          if (request.session === editorSessionRef.current) {
            setLivePreviewState("error");
            setEditorError(`ライブ反映に失敗しました: ${String(e)}`);
          }
          liveApplyPendingRef.current = null;
        }
      }
    } finally {
      liveApplyInFlightRef.current = false;
      if (liveApplyPendingRef.current) void flushLivePreviewQueue();
    }
  }

  async function waitForLiveApplyIdle() {
    const deadline = Date.now() + 12_000;
    while (liveApplyInFlightRef.current && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
    }
    if (liveApplyInFlightRef.current) {
      throw new Error("ライブ反映処理の完了待ちがタイムアウトしました。");
    }
  }

  function openNewEditor() {
    if (!snapshot) return;
    beginEditorSession();
    const zones = editorZonesFromControllers(snapshot.controllers);
    setEditor({
      mode: "new",
      name: "",
      original_name: null,
      base_profile_name: null,
      zones,
      initial_zones: cloneEditorZones(zones),
    });
    setEditorDrafts(makeEditorDrafts(zones));
    setEditorError(null);
    setEditorStatus(null);
  }

  function openEditEditor(profile: SavedProfile) {
    beginEditorSession();
    const zones = editorZonesFromControllers(profile.controllers);
    const openRgbHasProfile = snapshot?.profiles.includes(profile.name) ?? false;
    setEditor({
      mode: "edit",
      name: profile.name,
      original_name: profile.name,
      base_profile_name: openRgbHasProfile ? profile.name : null,
      zones,
      initial_zones: cloneEditorZones(zones),
    });
    setEditorDrafts(makeEditorDrafts(zones));
    setEditorError(null);
    setEditorStatus(null);
  }

  function openDuplicateEditor(profile: SavedProfile) {
    beginEditorSession();
    const zones = editorZonesFromControllers(profile.controllers);
    const openRgbHasProfile = snapshot?.profiles.includes(profile.name) ?? false;
    setEditor({
      mode: "duplicate",
      name: suggestDuplicateName(profile.name),
      original_name: null,
      base_profile_name: openRgbHasProfile ? profile.name : null,
      zones,
      initial_zones: cloneEditorZones(zones),
    });
    setEditorDrafts(makeEditorDrafts(zones));
    setEditorError(null);
    setEditorStatus(null);
  }

  function resetAndCloseEditor() {
    liveApplySuspendedRef.current = true;
    editorSessionRef.current += 1;
    liveApplyPendingRef.current = null;
    clearLivePreviewDebounce();
    editorTouchedHardwareRef.current = false;
    setLivePreviewState("idle");
    setPendingEditSave(false);
    setPendingDiscardChanges(false);
    setEditor(null);
    setEditorDrafts({});
    setEditorError(null);
    setEditorStatus(null);
  }

  function closeEditorNow() {
    if (editorBusy) return;
    resetAndCloseEditor();
  }

  async function discardEditorChanges() {
    if (!editor || editorBusy) return;

    const editorToDiscard = editor;
    const shouldRestoreHardware = editorTouchedHardwareRef.current;

    liveApplySuspendedRef.current = true;
    liveApplyPendingRef.current = null;
    clearLivePreviewDebounce();
    setEditorBusy("discard");
    setPendingEditSave(false);
    setPendingDiscardChanges(false);
    setEditorError(null);
    setEditorStatus(null);

    try {
      // A live-apply request may already be inside the SDK call.  Let it finish
      // first, then restore the exact RGB state from when this editor opened.
      await waitForLiveApplyIdle();

      if (shouldRestoreHardware) {
        const result = await invoke<OpenRgbSnapshot>("preview_profile_colors", {
          zoneColors: editorZonesPayload(editorToDiscard.initial_zones),
          baseProfileName: editorToDiscard.base_profile_name,
        });
        setSnapshot(result);
      }

      resetAndCloseEditor();
      if (shouldRestoreHardware) {
        setMessage("変更を破棄し、実機のRGB値も編集開始時の状態へ戻しました。");
      }
    } catch (e) {
      // Do not close on restore failure: keeping the editor open is safer than
      // making the user lose sight of values that may still be active on hardware.
      liveApplySuspendedRef.current = false;
      setEditorError(`変更前のRGB値へ戻せませんでした: ${String(e)}`);
    } finally {
      setEditorBusy(null);
    }
  }

  function requestCloseEditor() {
    if (!editor || editorBusy) return;
    if (editorHasColorChanges) {
      setPendingEditSave(false);
      setPendingDiscardChanges(true);
      return;
    }
    closeEditorNow();
  }

  function continueAsNewProfile() {
    if (!editor || editor.mode !== "edit") return;
    const sourceName = editor.original_name ?? editor.name;
    setPendingEditSave(false);
    setEditor({
      ...editor,
      mode: "duplicate",
      name: suggestDuplicateName(sourceName),
      original_name: null,
      base_profile_name: snapshot?.profiles.includes(sourceName) ? sourceName : editor.base_profile_name,
    });
    setEditorStatus(`元の「${sourceName}」は変更しません。新しいProfile名を確認して保存してください。`);
    setEditorError(null);
  }

  function updateEditorName(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setEditor((current) => current ? { ...current, name: value } : current);
  }

  function updateEditorChannel(zoneIndex: number, channel: keyof RgbColor, rawValue: string) {
    const key = editorDraftKey(zoneIndex, channel);
    setEditorDrafts((current) => ({ ...current, [key]: rawValue }));

    if (rawValue.trim() === "") {
      markEditorColorChanged();
      return;
    }

    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;

    const value = clampRgb(numeric);
    const nextZones = editor?.zones.map((zone, index) =>
      index === zoneIndex
        ? { ...zone, color: { ...zone.color, [channel]: value } }
        : zone,
    );

    setEditor((current) => {
      if (!current) return current;
      const zones = current.zones.map((zone, index) =>
        index === zoneIndex
          ? { ...zone, color: { ...zone.color, [channel]: value } }
          : zone,
      );
      return { ...current, zones };
    });

    markEditorColorChanged();
    if (nextZones) queueLivePreview(editorZonesPayload(nextZones));
  }

  function commitEditorChannel(zoneIndex: number, channel: keyof RgbColor) {
    const key = editorDraftKey(zoneIndex, channel);
    const currentZoneValue = editor?.zones[zoneIndex]?.color[channel] ?? 0;
    const rawValue = editorDrafts[key] ?? String(currentZoneValue);
    const value = clampRgb(rawValue.trim() === "" ? 0 : Number(rawValue));
    const nextZones = editor?.zones.map((zone, index) =>
      index === zoneIndex
        ? { ...zone, color: { ...zone.color, [channel]: value } }
        : zone,
    );

    setEditorDrafts((current) => ({ ...current, [key]: String(value) }));
    setEditor((current) => {
      if (!current) return current;
      const zones = current.zones.map((zone, index) =>
        index === zoneIndex
          ? { ...zone, color: { ...zone.color, [channel]: value } }
          : zone,
      );
      return { ...current, zones };
    });

    markEditorColorChanged();
    if (nextZones) queueLivePreview(editorZonesPayload(nextZones));
  }

  function updateEditorPicker(zoneIndex: number, rawValue: string) {
    const color = hexToRgb(rawValue);
    if (!color) return;

    const nextZones = editor?.zones.map((zone, index) =>
      index === zoneIndex ? { ...zone, color } : zone,
    );

    setEditorDrafts((current) => ({
      ...current,
      [editorDraftKey(zoneIndex, "r")]: String(color.r),
      [editorDraftKey(zoneIndex, "g")]: String(color.g),
      [editorDraftKey(zoneIndex, "b")]: String(color.b),
    }));
    setEditor((current) => {
      if (!current) return current;
      const zones = current.zones.map((zone, index) =>
        index === zoneIndex ? { ...zone, color } : zone,
      );
      return { ...current, zones };
    });

    markEditorColorChanged();
    if (nextZones) queueLivePreview(editorZonesPayload(nextZones));
  }

  function editorZonePayload(): ZoneColorInput[] {
    if (!editor) return [];
    return editor.zones.map((zone, zoneIndex) => {
      const color = (["r", "g", "b"] as const).reduce<RgbColor>(
        (result, channel) => {
          const rawValue = editorDrafts[editorDraftKey(zoneIndex, channel)] ?? String(zone.color[channel]);
          result[channel] = clampRgb(rawValue.trim() === "" ? 0 : Number(rawValue));
          return result;
        },
        { r: 0, g: 0, b: 0 },
      );

      return {
        controller_id: zone.controller_id,
        zone_id: zone.zone_id,
        color,
      };
    });
  }

  async function applySavedProfile(profile: SavedProfile) {
    if (!snapshot || applyingSavedProfile) return;
    setApplyingSavedProfile(profile.name);
    setOpenRgbError(null);
    setMessage(null);
    try {
      const result = await invoke<OpenRgbSnapshot>("preview_profile_colors", {
        zoneColors: savedProfileZonePayload(profile),
        baseProfileName: null,
      });
      setSnapshot(result);
      setMessage(`「${profile.name}」の記録済みRGB値を実機へ反映しました。OpenRGB側のProfileは変更していません。`);
    } catch (e) {
      setOpenRgbError(String(e));
    } finally {
      setApplyingSavedProfile(null);
    }
  }

  async function saveSavedProfileToOpenRgb(profile: SavedProfile) {
    if (!snapshot || savingSavedProfile) return;
    setSavingSavedProfile(profile.name);
    setOpenRgbError(null);
    setLedgerError(null);
    setMessage(null);
    try {
      // The OpenRGB Profile list can lag briefly behind SDK/controller readiness.
      // Refresh immediately before deciding that a Companion-only Profile must be created.
      const freshSnapshot = await invoke<OpenRgbSnapshot>("scan_openrgb");
      setSnapshot(freshSnapshot);

      if (freshSnapshot.profiles.includes(profile.name)) {
        setMessage(`「${profile.name}」はOpenRGB側にも存在していたため、Profile状態を更新しました。`);
        return;
      }

      const result = await invoke<CaptureProfileResult>("save_profile_from_colors", {
        profileName: profile.name,
        zoneColors: savedProfileZonePayload(profile),
        allowOverwrite: false,
        baseProfileName: null,
      });
      setSnapshot(result.snapshot);
      await loadSavedProfiles();
      setMessage(`「${result.profile.name}」をOpenRGBへ保存しました。Companionの記録も維持されています。`);
    } catch (e) {
      const errorText = String(e);

      // Race-safe fallback: if OpenRGB reports that the name already exists,
      // refresh once more and treat it as a state-sync issue rather than a save failure.
      if (errorText.includes("OpenRGB profile already exists:")) {
        const refreshed = await refreshSnapshotSilently();
        if (refreshed?.profiles.includes(profile.name)) {
          setMessage(`「${profile.name}」はOpenRGB側にも存在していたため、Profile状態を更新しました。`);
          return;
        }
      }

      setOpenRgbError(errorText);
    } finally {
      setSavingSavedProfile(null);
    }
  }

  async function previewEditor() {
    if (!editor) return;
    liveApplySuspendedRef.current = true;
    liveApplyPendingRef.current = null;
    clearLivePreviewDebounce();
    setEditorBusy("preview");
    setEditorError(null);
    setEditorStatus(null);
    try {
      await waitForLiveApplyIdle();
      const result = await invoke<OpenRgbSnapshot>("preview_profile_colors", {
        zoneColors: editorZonePayload(),
        baseProfileName: editor.base_profile_name,
      });
      editorTouchedHardwareRef.current = true;
      setSnapshot(result);
      if (livePreviewEnabled) setLivePreviewState("applied");
      setEditorStatus("実機にプレビューしました。Profileにはまだ保存していません。");
    } catch (e) {
      setEditorError(String(e));
    } finally {
      liveApplySuspendedRef.current = false;
      setEditorBusy(null);
    }
  }

  async function performEditorSave(allowOverwrite: boolean) {
    if (!editor) return;
    const profileName = editor.name.trim();

    liveApplySuspendedRef.current = true;
    liveApplyPendingRef.current = null;
    clearLivePreviewDebounce();
    setEditorBusy("save");
    setEditorError(null);
    setEditorStatus(null);
    setPendingEditSave(false);
    try {
      await waitForLiveApplyIdle();
      const result = await invoke<CaptureProfileResult>("save_profile_from_colors", {
        profileName,
        zoneColors: editorZonePayload(),
        allowOverwrite,
        baseProfileName: editor.base_profile_name,
      });
      setSnapshot(result.snapshot);
      await loadSavedProfiles();
      closeEditorNow();
      setMessage(
        allowOverwrite
          ? `「${result.profile.name}」を上書き保存しました。`
          : `「${result.profile.name}」をOpenRGBとCompanionへ保存しました。`,
      );
    } catch (e) {
      setEditorError(String(e));
    } finally {
      liveApplySuspendedRef.current = false;
      setEditorBusy(null);
    }
  }

  async function saveEditor() {
    if (!editor) return;
    const profileName = editor.name.trim();
    if (!profileName) {
      setEditorError("Profile名を入力してください。");
      return;
    }
    if (!isValidOpenRgbProfileName(profileName)) {
      setEditorError("OpenRGBとの互換性のため、Profile名には半角英数字・半角スペース・「-」「_」だけを使用してください。");
      return;
    }
    if (editorNameConflict) {
      setEditorError("同名のProfileが既にあります。別の名前を指定してください。");
      return;
    }

    if (editor.mode === "edit") {
      if (!editorHasColorChanges) {
        setEditorStatus("RGB値は変更されていません。");
        setEditorError(null);
        return;
      }
      setPendingDiscardChanges(false);
      setPendingEditSave(true);
      return;
    }

    await performEditorSave(false);
  }

  useEffect(() => {
    void loadSavedProfiles();
    void loadSchedulerSettings();
    void scan();

    const profileSettleTimer = window.setTimeout(() => {
      void refreshSnapshotSilently();
    }, 1200);

    return () => window.clearTimeout(profileSettleTimer);
  }, []);

  useEffect(() => {
    if (livePreviewEnabled) return;
    clearLivePreviewDebounce();
    liveApplyPendingRef.current = null;
    setLivePreviewState("idle");
  }, [livePreviewEnabled]);

  useEffect(() => {
    if (!pendingDelete && !editor && !pendingEditSave && !pendingDiscardChanges && !pendingSchedulerReload) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingEditSave) {
        setPendingEditSave(false);
        return;
      }
      if (pendingDiscardChanges) {
        setPendingDiscardChanges(false);
        return;
      }
      if (pendingSchedulerReload) {
        setPendingSchedulerReload(false);
        return;
      }
      if (pendingDelete) {
        setPendingDelete(null);
        return;
      }
      if (editor && !editorBusy) requestCloseEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingDelete, editor, editorBusy, pendingEditSave, pendingDiscardChanges, pendingSchedulerReload, editorHasColorChanges]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <h1>OpenRGB Companion</h1>
        </div>
        <button className="primary" onClick={() => void scan()} disabled={loading || capturingProfile !== null || savingSavedProfile !== null || applyingSavedProfile !== null || editorBusy !== null}>
          {loading ? "読込中…" : "現在状態を再読込"}
        </button>
      </header>

      {snapshot && (
        <section className="status-strip" aria-label="OpenRGB status">
          <div className="status-pill connected"><span className="status-dot" />Connected</div>
          <div className="status-pill"><small>SDK</small><strong>{snapshot.protocol_version}</strong></div>
          <div className="status-pill"><small>Controllers</small><strong>{snapshot.controllers.length}</strong><span>{totalZones} zones</span></div>
          <div className="status-pill ledger"><small>Profiles</small><strong>{unifiedProfiles.length}</strong><span>{savedProfiles.length} 記録済み</span></div>
          <div className="status-address">{snapshot.address}</div>
        </section>
      )}

      {openRgbError && (
        <section className={!snapshot && savedProfiles.length > 0 ? "notice warning" : "notice error"}>
          <strong>
            {!snapshot && savedProfiles.length > 0
              ? "OpenRGB Serverは現在オフラインです。"
              : "OpenRGB Serverとの処理に失敗しました。"}
          </strong>
          {!snapshot && savedProfiles.length > 0 ? (
            <>
              <span>保存済みProfileはこのまま閲覧できます。OpenRGBが必要な操作だけ利用できません。</span>
              <small>{openRgbError}</small>
            </>
          ) : (
            <>
              <span>{openRgbError}</span>
              <small>OpenRGBをSDK Server付きで起動し、127.0.0.1:6742で待受しているか確認してください。保存済みProfileの閲覧だけならオフラインでも可能です。</small>
            </>
          )}
        </section>
      )}

      {ledgerError && (
        <section className="notice error">
          <strong>Companionの記録ファイルを処理できませんでした。</strong>
          <span>{ledgerError}</span>
        </section>
      )}

      {message && <section className="notice success"><strong>{message}</strong></section>}

      <section className="section-heading unified-heading">
        <div>
          <p className="section-kicker pink">PROFILES</p>
          <h2>Profiles</h2>
          <p>記録済みProfileはRGB値の確認・編集・実機反映ができます。</p>
        </div>
        <div className="section-heading-actions unified-heading-actions">
          <span className="count-badge">{unifiedProfiles.length} Profiles</span>
          <button
            className="new-profile-button"
            onClick={openNewEditor}
            disabled={!snapshot || loading || capturingProfile !== null || savingSavedProfile !== null}
            title={!snapshot ? "新規Profile作成にはOpenRGB Serverへの接続が必要です" : undefined}
          >
            ＋ 新規Profile
          </button>
        </div>
      </section>

      {ledgerLoading ? (
        <section className="notice muted">Profile情報を読み込んでいます…</section>
      ) : unifiedProfiles.length === 0 ? (
        <section className="empty-state">
          <span className="empty-symbol">＋</span>
          <strong>Profileがありません。</strong>
          <p>{snapshot ? "「＋ 新規Profile」から作成できます。" : "OpenRGBへ接続するとProfileを作成・取得できます。"}</p>
        </section>
      ) : (
        <div className="saved-profile-list unified-profile-list">
          {unifiedProfiles.map((entry) => {
            const profile = entry.saved;
            const stats = profile ? savedProfileStats(profile) : null;
            const inOpenRgb = entry.in_openrgb;
            const captureBusy = capturingProfile === entry.name;
            const applyBusy = applyingSavedProfile === entry.name;
            const saveBusy = savingSavedProfile === entry.name;

            return (
              <details
                className={profile ? "saved-profile-card unified-profile-card" : "saved-profile-card unified-profile-card openrgb-only"}
                key={entry.name}
              >
                <summary>
                  <div className="saved-profile-summary-main">
                    <span className="profile-chevron" aria-hidden="true" />
                    <div className="saved-profile-title">
                      <strong>{entry.name}</strong>
                      <span>
                        {profile && stats
                          ? `${profile.controllers.length} controllers · ${stats.zones} zones · ${stats.leds} LEDs`
                          : "OpenRGB側にのみ存在 · RGB値は未記録"}
                      </span>
                      <div className="profile-source-badges" aria-label="Profile保存先">
                        <span className={inOpenRgb === true ? "profile-status openrgb" : inOpenRgb === false ? "profile-status missing" : "profile-status unknown"}>
                          {inOpenRgb === true ? "OpenRGB ✓" : inOpenRgb === false ? "OpenRGB ―" : "OpenRGB 不明"}
                        </span>
                        <span className={profile ? "profile-status companion" : "profile-status unsaved"}>
                          {profile ? "Companion ✓" : "Companion 未記録"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="saved-profile-summary-side">
                    {profile && inOpenRgb === true && (
                      <button
                        className="apply-saved-button profile-apply-button"
                        disabled={!snapshot || applyingSavedProfile !== null || savingSavedProfile !== null || editorBusy !== null || capturingProfile !== null}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void applySavedProfile(profile);
                        }}
                        title="Companionに記録してあるRGB値を実機へ反映します。OpenRGB側のProfileは変更しません。"
                      >
                        {applyBusy ? "反映中…" : "実機に反映"}
                      </button>
                    )}
                    {!profile && inOpenRgb === true && (
                      <button
                        className="secondary"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void captureProfile(entry.name);
                        }}
                        disabled={capturingProfile !== null || savingSavedProfile !== null || loading || editorBusy !== null}
                      >
                        {captureBusy ? "取得中…" : "Companionに記録"}
                      </button>
                    )}
                    {profile && inOpenRgb === false && (
                      <button
                        className="editor-save-button profile-inline-save"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void saveSavedProfileToOpenRgb(profile);
                        }}
                        disabled={!snapshot || savingSavedProfile !== null || capturingProfile !== null || applyingSavedProfile !== null || editorBusy !== null}
                      >
                        {saveBusy ? "保存中…" : "OpenRGBに保存"}
                      </button>
                    )}
                    {profile ? <span>{capturedAtText(profile.captured_at_unix_ms)}</span> : <span>OpenRGB Profile</span>}
                  </div>
                </summary>

                <div className="saved-profile-body">
                  {profile ? (
                    <>
                      <div className="saved-actions">
                        <span>
                          {inOpenRgb === true
                            ? "OpenRGB / Companionの両方に存在します"
                            : inOpenRgb === false
                              ? "Companion側にのみ保存されています"
                              : "OpenRGBはオフラインです。Companionの記録を表示しています"}
                        </span>
                        <div className="profile-action-buttons">
                          <button
                            className="action-ghost"
                            onClick={() => openEditEditor(profile)}
                            disabled={!snapshot}
                            title={!snapshot ? "編集にはOpenRGB Serverへの接続が必要です" : undefined}
                          >編集</button>
                          <button
                            className="action-ghost"
                            onClick={() => openDuplicateEditor(profile)}
                            disabled={!snapshot}
                            title={!snapshot ? "複製にはOpenRGB Serverへの接続が必要です" : undefined}
                          >複製</button>
                          {inOpenRgb === true && (
                            <button
                              className="action-ghost"
                              onClick={() => void captureProfile(entry.name)}
                              disabled={capturingProfile !== null || savingSavedProfile !== null || loading || editorBusy !== null}
                            >
                              {captureBusy ? "取得中…" : "OpenRGBから再取得"}
                            </button>
                          )}
                          {inOpenRgb === false && (
                            <button
                              className="action-ghost save-to-openrgb"
                              onClick={() => void saveSavedProfileToOpenRgb(profile)}
                              disabled={!snapshot || savingSavedProfile !== null || capturingProfile !== null || applyingSavedProfile !== null || editorBusy !== null}
                            >
                              {saveBusy ? "保存中…" : "OpenRGBに保存"}
                            </button>
                          )}
                          <button className="danger-ghost" onClick={() => setPendingDelete(profile.name)}>記録だけ削除</button>
                        </div>
                      </div>
                      <div className="controller-list compact-list">
                        {profile.controllers.map((controller) => (
                          <ControllerView
                            controller={controller}
                            compact
                            key={`${profile.name}-${controller.id}-${controller.location}-${controller.name}`}
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="unrecorded-profile-body">
                      <div>
                        <strong>CompanionにはまだRGB値が記録されていません。</strong>
                        <span>OpenRGBからこのProfileを読み込み、その時点のRGB値をCompanionへ記録すると編集・数値確認ができるようになります。</span>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => void captureProfile(entry.name)}
                        disabled={capturingProfile !== null || savingSavedProfile !== null || loading || editorBusy !== null}
                      >
                        {captureBusy ? "取得中…" : "Companionに記録"}
                      </button>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {schedulerSnapshot?.installed && (
        <>
          <section className="section-heading plugins-heading">
        <div>
          <p className="section-kicker cyan">PLUGINS</p>
          <h2>Plugins</h2>
          <p>OpenRGB Pluginの設定を編集します。</p>
        </div>
      </section>

      <details className="plugin-card scheduler-plugin-card">
        <summary>
          <div className="plugin-summary-main">
            <span className="profile-chevron" aria-hidden="true" />
            <div>
              <strong>Scheduler</strong>
              <span>OpenRGB Scheduler Plugin · Profileの時間指定切替</span>
            </div>
          </div>
          <div className="plugin-summary-side">
            {schedulerLoading ? (
              <span className="plugin-status neutral">確認中…</span>
            ) : schedulerSnapshot?.installed ? (
              <span className="plugin-status installed">検出済み</span>
            ) : (
              <span className="plugin-status missing">未検出</span>
            )}
            {schedulerSnapshot?.installed && (
              <span className={schedulerDirty ? "plugin-status dirty" : "plugin-status neutral"}>
                {schedulerDirty
                  ? "未保存の変更"
                  : `${schedulerTasks.filter((task) => !task.__companion_deleted).length} schedules`}
              </span>
            )}
          </div>
        </summary>

        <div className="plugin-card-body">
          {schedulerError && <div className="plugin-message error">{schedulerError}</div>}
          {schedulerMessage && <div className="plugin-message success">{schedulerMessage}</div>}

          {schedulerLoading ? (
            <div className="plugin-empty">Scheduler設定を確認しています…</div>
          ) : !schedulerSnapshot?.installed ? (
            <div className="plugin-empty">
              <strong>Scheduler Pluginを確認できませんでした。</strong>
              <span>OpenRGBの Settings → Plugins からScheduler Pluginをインストールすると、ここで設定できます。</span>
            </div>
          ) : (
            <>
              <div className="scheduler-toolbar">
                <div>
                  <strong>Schedules</strong>
                  <span>未反映の追加・変更・削除は各行に表示されます。「変更を反映」でOpenRGB側へ確定します。</span>
                </div>
                <button className="new-profile-button scheduler-add-button" onClick={addSchedulerTask} disabled={schedulerSaving}>
                  ＋ スケジュールを追加
                </button>
              </div>

              {schedulerTasks.length === 0 ? (
                <div className="plugin-empty scheduler-empty">
                  <strong>スケジュールはまだありません。</strong>
                  <span>「＋ スケジュールを追加」からProfileの自動切替を作成できます。</span>
                </div>
              ) : (
                <div className="scheduler-list">
                  {schedulerTasks.map((task, index) => {
                    const dailyTime = dailyTimeFromCron(task.cron_line);
                    const unsupportedAction = task.action !== 0 && task.action !== 1 && task.action !== 2;
                    const profileMissing =
                      task.action === 0 &&
                      Boolean(task.sub_action) &&
                      !snapshot?.profiles.includes(task.sub_action ?? "");
                    const rowStatus = schedulerRowStatus(task, schedulerBaselineTasks);
                    const rowStatusLabel = schedulerStatusLabel(rowStatus);
                    const rowDisabled = schedulerSaving || task.__companion_deleted;

                    return (
                      <div
                        className={`scheduler-row scheduler-row-${rowStatus}`}
                        key={task.__companion_id}
                      >
                        <button
                          type="button"
                          className={task.run ? "scheduler-toggle enabled" : "scheduler-toggle"}
                          role="switch"
                          aria-checked={task.run}
                          onClick={() => updateSchedulerTask(index, { run: !task.run })}
                          disabled={rowDisabled}
                        >
                          <i><b /></i>
                          <span>{task.run ? "ON" : "OFF"}</span>
                        </button>

                        <label className="scheduler-field scheduler-name-field">
                          <span>名前</span>
                          <input
                            value={task.name}
                            onChange={(event) => updateSchedulerTask(index, { name: event.target.value })}
                            disabled={rowDisabled}
                            autoComplete="off"
                          />
                        </label>

                        {dailyTime ? (
                          <label className="scheduler-field scheduler-time-field">
                            <span>毎日</span>
                            <input
                              type="time"
                              value={dailyTime}
                              onChange={(event) => {
                                const cron = cronFromDailyTime(event.target.value);
                                if (cron) updateSchedulerTask(index, { cron_line: cron });
                              }}
                              disabled={rowDisabled}
                            />
                          </label>
                        ) : (
                          <label className="scheduler-field scheduler-cron-field">
                            <span>カスタムCron</span>
                            <input
                              value={task.cron_line}
                              onChange={(event) => updateSchedulerTask(index, { cron_line: event.target.value })}
                              disabled={rowDisabled}
                              spellCheck={false}
                            />
                          </label>
                        )}

                        <label className="scheduler-field scheduler-action-field">
                          <span>動作</span>
                          <select
                            value={task.action}
                            onChange={(event) => {
                              const action = Number(event.target.value);
                              updateSchedulerTask(index, {
                                action,
                                sub_action: action === 0 ? (task.sub_action || snapshot?.profiles[0] || "") : task.sub_action,
                              });
                            }}
                            disabled={rowDisabled || unsupportedAction}
                          >
                            <option value={0}>Profileを読み込む</option>
                            <option value={1}>消灯</option>
                            {task.action === 2 && <option value={2}>Effects Plugin action</option>}
                          </select>
                        </label>

                        {task.action === 0 ? (
                          <label className="scheduler-field scheduler-profile-field">
                            <span>Profile</span>
                            <select
                              value={task.sub_action ?? ""}
                              onChange={(event) => updateSchedulerTask(index, { sub_action: event.target.value })}
                              disabled={rowDisabled}
                            >
                              {!task.sub_action && <option value="">Profileを選択</option>}
                              {profileMissing && task.sub_action && (
                                <option value={task.sub_action}>{task.sub_action}（OpenRGBに見つかりません）</option>
                              )}
                              {(snapshot?.profiles ?? []).map((profileName) => (
                                <option value={profileName} key={profileName}>{profileName}</option>
                              ))}
                            </select>
                          </label>
                        ) : task.action === 2 ? (
                          <div className="scheduler-field scheduler-profile-field readonly">
                            <span>Effects action</span>
                            <strong>{task.sub_action || "—"}</strong>
                          </div>
                        ) : (
                          <div className="scheduler-field scheduler-profile-field readonly">
                            <span>Profile</span>
                            <strong>—</strong>
                          </div>
                        )}

                        <div className="scheduler-row-actions">
                          {rowStatusLabel && (
                            <span className={`scheduler-row-badge ${rowStatus}`}>{rowStatusLabel}</span>
                          )}
                          {task.__companion_deleted ? (
                            <button
                              className="scheduler-undo-button"
                              onClick={() => restoreSchedulerTask(index)}
                              disabled={schedulerSaving}
                              title="削除予定を取り消す"
                            >
                              元に戻す
                            </button>
                          ) : (
                            <button
                              className="scheduler-delete-button"
                              onClick={() => removeSchedulerTask(index)}
                              disabled={schedulerSaving}
                              title={rowStatus === "new" ? "未反映のスケジュールを破棄" : "このスケジュールを削除予定にする"}
                            >
                              削除
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="scheduler-footer">
                <span className="scheduler-path" title={schedulerSnapshot.settings_path}>SchedulerSettings.json</span>
                <div>
                  <button
                    className="action-ghost"
                    onClick={requestReloadSchedulerSettings}
                    disabled={schedulerSaving || schedulerLoading}
                  >
                    再読込
                  </button>
                  <button
                    className="editor-save-button scheduler-save-button"
                    onClick={() => void saveSchedulerSettings()}
                    disabled={!schedulerDirty || schedulerSaving || schedulerTasks.some((task) => !task.__companion_deleted && task.action === 0 && !task.sub_action)}
                  >
                    {schedulerSaving ? "反映中…" : "変更を反映"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </details>

        </>
      )}

      {snapshot && (
        <>
          <details className="live-panel">
            <summary>
              <div>
                <p className="section-kicker green">LIVE STATE</p>
                <strong>現在のOpenRGB状態</strong>
                <span>{snapshot.controllers.length} controllers · {totalZones} zones</span>
              </div>
              <span className="live-chevron" aria-hidden="true" />
            </summary>
            <div className="live-panel-body">
              <p className="live-note">マザーボード型番に依存せず、OpenRGBが返した情報だけを表示しています。</p>
              <div className="controller-list">
                {snapshot.controllers.map((controller) => (
                  <ControllerView
                    controller={controller}
                    key={`${controller.id}-${controller.location}-${controller.name}`}
                  />
                ))}
              </div>
            </div>
          </details>
        </>
      )}

      {!snapshot && !openRgbError && !loading && (
        <section className="notice muted">OpenRGBを検索してください。</section>
      )}

      {editor && (
        <div className="modal-backdrop editor-backdrop" role="presentation" onMouseDown={requestCloseEditor}>
          <section
            className="profile-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-editor-title"
            onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          >
            <div className="dialog-accent" aria-hidden="true" />
            <div className="editor-header">
              <div>
                <p className="dialog-kicker">
                  {editor.mode === "new" ? "NEW PROFILE" : editor.mode === "duplicate" ? "DUPLICATE PROFILE" : "EDIT PROFILE"}
                </p>
                <h2 id="profile-editor-title">
                  {editor.mode === "new" ? "新しいProfileを作成" : editor.mode === "duplicate" ? "Profileを複製" : `「${editor.name}」を編集`}
                </h2>
              </div>
              <button className="editor-close" onClick={requestCloseEditor} disabled={editorBusy !== null} aria-label="閉じる">×</button>
            </div>

            <div className="editor-name-row">
              <label htmlFor="profile-name">Profile名</label>
              <input
                id="profile-name"
                className="profile-name-input"
                value={editor.name}
                onChange={updateEditorName}
                disabled={editor.mode === "edit" || editorBusy !== null}
                placeholder="例: Night03"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                autoFocus={editor.mode !== "edit"}
              />
              {editor.mode === "edit" ? (
                <span>名前を変える場合は「複製」を使ってください。</span>
              ) : editorNameInvalid ? (
                <span className="field-error">半角英数字・スペース・「-」「_」のみ使用できます。</span>
              ) : (
                <span className="field-hint">半角英数字・スペース・「-」「_」</span>
              )}
              {editorNameConflict && <span className="field-error">同名のProfileが既にあります。</span>}
            </div>

            <div className="editor-info-row">
              <span>{editor.zones.length} zones</span>
              <span>RGB 0–255</span>
              <span>保存時にOpenRGB ProfileとCompanion台帳の両方へ反映</span>
              {editor.mode === "edit" && (
                <span className={editorHasColorChanges ? "editor-dirty-badge dirty" : "editor-dirty-badge"}>
                  {editorHasColorChanges ? "未保存の変更" : "変更なし"}
                </span>
              )}
              <button
                type="button"
                className={livePreviewEnabled ? "live-preview-toggle enabled" : "live-preview-toggle"}
                role="switch"
                aria-checked={livePreviewEnabled}
                onClick={() => setLivePreviewEnabled((current) => !current)}
                disabled={editorBusy === "save"}
                title="RGB変更を約180ms待って実機へ自動反映します。Profileへの保存は行いません。"
              >
                <i aria-hidden="true"><b /></i>
                <strong>ライブ反映</strong>
                <em>{livePreviewLabel(livePreviewEnabled, livePreviewState)}</em>
              </button>
            </div>

            <div className="editor-zone-scroll">
              {Array.from(new Set(editor.zones.map((zone) => zone.controller_id))).map((controllerId) => {
                const zones = editor.zones
                  .map((zone, index) => ({ zone, index }))
                  .filter(({ zone }) => zone.controller_id === controllerId);
                const controllerName = zones[0]?.zone.controller_name ?? `Controller ${controllerId}`;
                return (
                  <section className="editor-controller" key={controllerId}>
                    <div className="editor-controller-heading">
                      <strong>{controllerName}</strong>
                      <span>ID {controllerId} · {zones.length} zones</span>
                    </div>
                    <div className="editor-zone-list">
                      {zones.map(({ zone, index }) => (
                        <div className="editor-zone-row" key={`${zone.controller_id}-${zone.zone_id}`}>
                          <input
                            className="editor-color-picker"
                            type="color"
                            value={hexText(zone.color)}
                            onChange={(event) => updateEditorPicker(index, event.target.value)}
                            disabled={editorBusy !== null}
                            aria-label={`${zone.zone_name} color`}
                          />
                          <div className="editor-zone-name">
                            <strong>{zone.zone_name}</strong>
                            <span>{zone.zone_type} · {zone.led_count} LEDs{zone.was_multicolor ? " · 複数色→単色編集" : ""}</span>
                          </div>
                          <div className="rgb-inputs">
                            {(["r", "g", "b"] as const).map((channel) => (
                              <label key={channel}>
                                <span>{channel.toUpperCase()}</span>
                                <input
                                  type="number"
                                  min="0"
                                  max="255"
                                  inputMode="numeric"
                                  value={editorDrafts[editorDraftKey(index, channel)] ?? String(zone.color[channel])}
                                  onChange={(event) => updateEditorChannel(index, channel, event.target.value)}
                                  onBlur={() => commitEditorChannel(index, channel)}
                                  onFocus={(event) => event.currentTarget.select()}
                                  disabled={editorBusy !== null}
                                />
                              </label>
                            ))}
                          </div>
                          <code>{hexText(zone.color)}</code>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>

            {editorError && <div className="editor-message error">{editorError}</div>}
            {editorStatus && <div className="editor-message success">{editorStatus}</div>}

            <div className="editor-footer">
              <p>ライブ反映 / プレビューは実機の色だけを変更します。保存しない限りProfileは作成・更新されません。</p>
              <div>
                <button className="dialog-cancel" onClick={requestCloseEditor} disabled={editorBusy !== null}>キャンセル</button>
                <button className="preview-button" onClick={() => void previewEditor()} disabled={editorBusy !== null}>
                  {editorBusy === "preview" ? "適用中…" : "実機にプレビュー"}
                </button>
                <button
                  className="editor-save-button"
                  onClick={() => void saveEditor()}
                  disabled={editorBusy !== null || !editor.name.trim() || editorNameInvalid || editorNameConflict}
                >
                  {editorBusy === "save" ? "保存中…" : "OpenRGBに保存"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {pendingEditSave && editor?.mode === "edit" && (
        <div className="modal-backdrop elevated-modal" role="presentation" onMouseDown={() => setPendingEditSave(false)}>
          <section
            className="confirm-dialog save-choice-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-choice-title"
            onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          >
            <div className="dialog-accent" aria-hidden="true" />
            <p className="dialog-kicker">SAVE PROFILE</p>
            <h2 id="save-choice-title">「{editor.name}」の変更をどう保存しますか？</h2>
            <p><>
                  変更前のRGB値を残す場合は［名前を付けて保存］でこのProfileを別名保存してください。
                  <br />
                  ［上書き保存］すると、現在のRGB値で既存Profileを更新します。
                </></p>
            <div className="dialog-actions save-choice-actions">
              <button className="dialog-cancel" onClick={() => setPendingEditSave(false)}>キャンセル</button>
              <button className="save-as-button" onClick={continueAsNewProfile}>名前を付けて保存</button>
              <button className="overwrite-button" onClick={() => void performEditorSave(true)}>上書き保存</button>
            </div>
          </section>
        </div>
      )}

      {pendingDiscardChanges && editor && (
        <div className="modal-backdrop elevated-modal" role="presentation" onMouseDown={() => setPendingDiscardChanges(false)}>
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-dialog-title"
            onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          >
            <div className="dialog-accent" aria-hidden="true" />
            <p className="dialog-kicker">UNSAVED CHANGES</p>
            <h2 id="discard-dialog-title">変更を破棄しますか？</h2>
            <p>変更を破棄すると、Profileには保存せず、ライブ反映・プレビューで変更した実機のRGB値も編集開始時の状態へ戻します。</p>
            <div className="dialog-actions">
              <button className="dialog-cancel" onClick={() => setPendingDiscardChanges(false)}>編集を続ける</button>
              <button className="dialog-delete" onClick={() => void discardEditorChanges()} disabled={editorBusy !== null}>{editorBusy === "discard" ? "戻しています…" : "変更を破棄"}</button>
            </div>
          </section>
        </div>
      )}

      {pendingSchedulerReload && (
        <div className="modal-backdrop elevated-modal" role="presentation" onMouseDown={() => setPendingSchedulerReload(false)}>
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scheduler-reload-dialog-title"
            onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          >
            <div className="dialog-accent" aria-hidden="true" />
            <p className="dialog-kicker">SCHEDULER CHANGES</p>
            <h2 id="scheduler-reload-dialog-title">未反映の変更を破棄して再読込しますか？</h2>
            <p>新規追加・編集・削除予定の内容はOpenRGB側へ反映されず、現在のScheduler設定から読み直します。</p>
            <div className="dialog-actions">
              <button className="dialog-cancel" onClick={() => setPendingSchedulerReload(false)}>編集を続ける</button>
              <button className="dialog-delete" onClick={() => void confirmReloadSchedulerSettings()}>変更を破棄して再読込</button>
            </div>
          </section>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setPendingDelete(null)}>
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          >
            <div className="dialog-accent" aria-hidden="true" />
            <p className="dialog-kicker">COMPANION LEDGER</p>
            <h2 id="delete-dialog-title">「{pendingDelete}」の記録を削除しますか？</h2>
            <p>Companion側の台帳だけを削除します。OpenRGB側のProfileは削除・変更しません。</p>
            <div className="dialog-actions">
              <button className="dialog-cancel" onClick={() => setPendingDelete(null)}>キャンセル</button>
              <button className="dialog-delete" onClick={() => void confirmDeleteSavedProfile()}>記録だけ削除</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
