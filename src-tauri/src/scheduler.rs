use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerTask {
    #[serde(default = "default_task_name")]
    pub name: String,
    #[serde(default = "default_cron_line")]
    pub cron_line: String,
    #[serde(default)]
    pub run: bool,
    #[serde(default)]
    pub action: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_action: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchedulerSnapshot {
    pub installed: bool,
    pub settings_exists: bool,
    pub settings_path: String,
    pub tasks: Vec<SchedulerTask>,
}

fn default_task_name() -> String { "Untitled".to_owned() }
fn default_cron_line() -> String { "0 0 22 * * ?".to_owned() }

#[cfg(windows)]
fn openrgb_config_dir() -> Result<PathBuf, String> {
    let appdata = env::var_os("APPDATA").ok_or_else(|| "APPDATAを取得できませんでした。".to_owned())?;
    Ok(PathBuf::from(appdata).join("OpenRGB"))
}

#[cfg(not(windows))]
fn openrgb_config_dir() -> Result<PathBuf, String> {
    if let Some(xdg) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(xdg).join("OpenRGB"));
    }
    let home = env::var_os("HOME").ok_or_else(|| "HOMEを取得できませんでした。".to_owned())?;
    Ok(PathBuf::from(home).join(".config").join("OpenRGB"))
}

fn plugins_dir() -> Result<PathBuf, String> { Ok(openrgb_config_dir()?.join("plugins")) }
fn settings_path() -> Result<PathBuf, String> { Ok(plugins_dir()?.join("settings").join("SchedulerSettings.json")) }

fn scheduler_plugin_file_exists(dir: &Path) -> bool {
    let entries = match fs::read_dir(dir) { Ok(entries) => entries, Err(_) => return false };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if scheduler_plugin_file_exists(&path) { return true; }
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.contains("scheduler") && (name.ends_with(".dll") || name.ends_with(".so") || name.ends_with(".dylib")) {
            return true;
        }
    }
    false
}

fn plugin_installed(path: &Path) -> bool {
    path.is_file() || plugins_dir().ok().is_some_and(|dir| scheduler_plugin_file_exists(&dir))
}

fn read_tasks(path: &Path) -> Result<Vec<SchedulerTask>, String> {
    if !path.is_file() { return Ok(Vec::new()); }
    let text = fs::read_to_string(path).map_err(|error| format!("SchedulerSettings.jsonを読み込めませんでした: {error}"))?;
    if text.trim().is_empty() { return Ok(Vec::new()); }
    serde_json::from_str::<Vec<SchedulerTask>>(&text)
        .map_err(|error| format!("SchedulerSettings.jsonの形式を解釈できませんでした: {error}"))
}

pub fn load() -> Result<SchedulerSnapshot, String> {
    let path = settings_path()?;
    let installed = plugin_installed(&path);
    let settings_exists = path.is_file();
    let tasks = read_tasks(&path)?;
    Ok(SchedulerSnapshot {
        installed,
        settings_exists,
        settings_path: path.to_string_lossy().into_owned(),
        tasks,
    })
}

fn validate(tasks: &[SchedulerTask]) -> Result<(), String> {
    for (index, task) in tasks.iter().enumerate() {
        if task.name.trim().is_empty() { return Err(format!("Scheduler {}件目の名前が空です。", index + 1)); }
        if task.cron_line.trim().is_empty() { return Err(format!("Scheduler「{}」のCron式が空です。", task.name)); }
        match task.action {
            0 => {
                if task.sub_action.as_deref().map(str::trim).unwrap_or_default().is_empty() {
                    return Err(format!("Scheduler「{}」で読み込むProfileが選択されていません。", task.name));
                }
            }
            1 | 2 => {}
            other => return Err(format!("Scheduler「{}」に未対応のaction値 {} があります。", task.name, other)),
        }
    }
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf { path.with_file_name("SchedulerSettings.json.companion-backup") }
fn temp_path(path: &Path) -> PathBuf { path.with_file_name("SchedulerSettings.json.companion-tmp") }

pub fn save_file(tasks: &[SchedulerTask]) -> Result<(), String> {
    let path = settings_path()?;
    if !plugin_installed(&path) {
        return Err("OpenRGB Scheduler Pluginを確認できませんでした。先にOpenRGBへScheduler Pluginをインストールしてください。".to_owned());
    }
    validate(tasks)?;
    let parent = path.parent().ok_or_else(|| "Scheduler設定フォルダを取得できませんでした。".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("Scheduler設定フォルダを作成できませんでした: {error}"))?;
    if path.is_file() {
        fs::copy(&path, backup_path(&path)).map_err(|error| format!("Scheduler設定のバックアップを作成できませんでした: {error}"))?;
    }
    let serialized = serde_json::to_string_pretty(tasks).map_err(|error| format!("Scheduler設定をJSON化できませんでした: {error}"))?;
    let temp = temp_path(&path);
    fs::write(&temp, serialized.as_bytes()).map_err(|error| format!("Scheduler設定の一時ファイルを書き込めませんでした: {error}"))?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("古いScheduler設定を置き換えられませんでした: {error}"))?;
    }
    fs::rename(&temp, &path).map_err(|error| format!("Scheduler設定を確定できませんでした: {error}"))?;
    Ok(())
}
