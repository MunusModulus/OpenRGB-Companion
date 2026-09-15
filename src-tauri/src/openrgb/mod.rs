use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use openrgb2::{Color, OpenRgbClient};
use serde::{Deserialize, Serialize};

const OPENRGB_ADDRESS: &str = "127.0.0.1:6742";
const CLIENT_PROTOCOL_VERSION: u32 = 5;

const SDK_MAGIC: &[u8; 4] = b"ORGB";
const PACKET_REQUEST_PROTOCOL_VERSION: u32 = 40;
const PACKET_SET_CLIENT_NAME: u32 = 50;
const PACKET_GET_PROFILE_LIST: u32 = 150;
const PACKET_SAVE_PROFILE: u32 = 151;

const OPENRGB_EXE_NAME: &str = "OpenRGB.exe";
const SDK_READY_TIMEOUT: Duration = Duration::from_secs(8);
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
static OPENRGB_PREPARE_LOCK: Mutex<()> = Mutex::new(());

fn sdk_server_ready() -> bool {
    // Validate the actual OpenRGB SDK handshake, not only that something is
    // listening on port 6742. Rust allows calling the helper defined below.
    open_raw_v5_stream().is_ok()
}

#[cfg(windows)]
fn hidden_command(program: &str) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn shell_execute_openrgb(path: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::ptr::null_mut;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> *mut core::ffi::c_void;
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let operation = wide(OsStr::new("open"));
    let file = wide(path.as_os_str());
    let parameters = wide(OsStr::new("--gui --server --startminimized"));
    let directory = path
        .parent()
        .map(|parent| wide(parent.as_os_str()))
        .unwrap_or_else(|| vec![0_u16]);

    // ShellExecuteW follows the same Windows shell launch path as Explorer /
    // Start-Process. This is important for OpenRGB: direct CreateProcess from
    // the packaged GUI app could leave OpenRGB alive with no tray UI and no
    // enumerated controllers, despite the SDK port being open.
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            directory.as_ptr(),
            1, // SW_SHOWNORMAL; OpenRGB handles --startminimized itself.
        )
    };

    let code = result as isize;
    if code <= 32 {
        Err(format!(
            "Windows Shell経由でOpenRGBを起動できませんでした (ShellExecuteW={code})"
        ))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn openrgb_process_running() -> bool {
    let output = hidden_command("tasklist.exe")
        .args(["/FI", "IMAGENAME eq OpenRGB.exe", "/FO", "CSV", "/NH"])
        .output();

    output
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_ascii_lowercase())
        .is_some_and(|text| text.contains("openrgb.exe"))
}

#[cfg(windows)]
fn running_openrgb_path() -> Option<PathBuf> {
    let output = hidden_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p = Get-Process -Name OpenRGB -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Path }",
        ])
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stdout);
    let path = PathBuf::from(text.trim().trim_matches('"'));
    path.is_file().then_some(path)
}

#[cfg(windows)]
fn discover_openrgb_path() -> Option<PathBuf> {
    if let Some(path) = running_openrgb_path() {
        return Some(path);
    }

    let mut candidates = Vec::new();
    if let Some(value) = env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(value).join("OpenRGB").join(OPENRGB_EXE_NAME));
    }
    if let Some(value) = env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(value).join("OpenRGB").join(OPENRGB_EXE_NAME));
    }
    if let Some(value) = env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(value);
        candidates.push(root.join("Programs").join("OpenRGB").join(OPENRGB_EXE_NAME));
        candidates.push(root.join("OpenRGB").join(OPENRGB_EXE_NAME));
    }

    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Some(path);
    }

    let output = hidden_command("where.exe").arg(OPENRGB_EXE_NAME).output().ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn wait_for_process_exit(timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if !openrgb_process_running() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    !openrgb_process_running()
}

#[cfg(windows)]
fn stop_openrgb_processes() -> Result<(), String> {
    if !openrgb_process_running() {
        return Ok(());
    }

    // First ask Windows to close OpenRGB without /F.  This gives OpenRGB and
    // its plugins a chance to shut down cleanly.  Only force-close if needed.
    let _ = hidden_command("taskkill.exe")
        .args(["/IM", OPENRGB_EXE_NAME, "/T"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if wait_for_process_exit(PROCESS_EXIT_TIMEOUT) {
        return Ok(());
    }

    let _ = hidden_command("taskkill.exe")
        .args(["/F", "/IM", OPENRGB_EXE_NAME, "/T"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if wait_for_process_exit(Duration::from_secs(2)) {
        Ok(())
    } else {
        Err("OpenRGBを終了できませんでした。OpenRGBとCompanionを同じ権限で起動しているか確認してください。".to_owned())
    }
}

#[cfg(windows)]
fn start_openrgb_with_server(path: &Path) -> Result<(), String> {
    shell_execute_openrgb(path)
        .map_err(|error| format!(
            "OpenRGBを --gui --server --startminimized で起動できませんでした: {error}"
        ))
}

#[cfg(windows)]
pub fn ensure_openrgb_ready() -> Result<bool, String> {
    if sdk_server_ready() {
        return Ok(false);
    }

    let _guard = OPENRGB_PREPARE_LOCK
        .lock()
        .map_err(|_| "OpenRGB自動準備ロックの取得に失敗しました。".to_owned())?;

    // Another request may have prepared it while we were waiting for the lock.
    if sdk_server_ready() {
        return Ok(false);
    }

    let was_running = openrgb_process_running();
    let path = discover_openrgb_path().ok_or_else(|| {
        "OpenRGB.exeが見つかりません。OpenRGBを通常インストールするか、一度OpenRGBを手動起動してからCompanionを再読込してください。".to_owned()
    })?;

    if was_running {
        stop_openrgb_processes()?;
        thread::sleep(Duration::from_millis(180));
    }

    start_openrgb_with_server(&path)?;

    let started = std::time::Instant::now();
    while started.elapsed() < SDK_READY_TIMEOUT {
        if sdk_server_ready() {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(120));
    }

    Err(format!(
        "OpenRGBを --gui --server --startminimized で起動しましたが、{} のSDK Serverを確認できませんでした。",
        OPENRGB_ADDRESS
    ))
}

#[cfg(not(windows))]
pub fn ensure_openrgb_ready() -> Result<bool, String> {
    if sdk_server_ready() {
        Ok(false)
    } else {
        Err(format!(
            "OpenRGB SDK Serverが {} で待受していません。OpenRGBを --gui --server で起動してください。",
            OPENRGB_ADDRESS
        ))
    }
}

#[cfg(windows)]
pub fn restart_openrgb_around_settings_update<F>(update: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let _guard = OPENRGB_PREPARE_LOCK
        .lock()
        .map_err(|_| "OpenRGB設定更新ロックの取得に失敗しました。".to_owned())?;

    let path = discover_openrgb_path().ok_or_else(|| {
        "OpenRGB.exeが見つかりません。OpenRGBを通常インストールしてから再試行してください。".to_owned()
    })?;

    if openrgb_process_running() {
        stop_openrgb_processes()?;
        thread::sleep(Duration::from_millis(180));
    }

    let update_result = update();

    let start_result = start_openrgb_with_server(&path).and_then(|_| {
        let started = std::time::Instant::now();
        while started.elapsed() < SDK_READY_TIMEOUT {
            if sdk_server_ready() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(120));
        }
        Err(format!(
            "OpenRGBを再起動しましたが、{} のSDK Serverを確認できませんでした。",
            OPENRGB_ADDRESS
        ))
    });

    match (update_result, start_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(update_error), Ok(())) => Err(format!(
            "設定変更に失敗しました。OpenRGBは再起動済みです: {update_error}"
        )),
        (Ok(()), Err(start_error)) => Err(format!(
            "設定は保存しましたが、OpenRGBの再起動に失敗しました: {start_error}"
        )),
        (Err(update_error), Err(start_error)) => Err(format!(
            "設定変更に失敗し、OpenRGBの再起動にも失敗しました。設定エラー: {update_error} / 再起動エラー: {start_error}"
        )),
    }
}

#[cfg(not(windows))]
pub fn restart_openrgb_around_settings_update<F>(update: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    update()?;
    Err("Scheduler設定は保存しましたが、このOSではOpenRGBの自動再起動にまだ対応していません。".to_owned())
}

fn write_sdk_packet(
    stream: &mut TcpStream,
    device_id: u32,
    packet_id: u32,
    payload: &[u8],
) -> Result<(), String> {
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| "OpenRGB SDK payload is too large.".to_owned())?;

    let mut header = [0_u8; 16];
    header[0..4].copy_from_slice(SDK_MAGIC);
    header[4..8].copy_from_slice(&device_id.to_le_bytes());
    header[8..12].copy_from_slice(&packet_id.to_le_bytes());
    header[12..16].copy_from_slice(&payload_len.to_le_bytes());

    stream.write_all(&header).map_err(|error| error.to_string())?;
    if !payload.is_empty() {
        stream.write_all(payload).map_err(|error| error.to_string())?;
    }
    stream.flush().map_err(|error| error.to_string())?;
    Ok(())
}

fn read_sdk_packet(stream: &mut TcpStream) -> Result<(u32, u32, Vec<u8>), String> {
    let mut header = [0_u8; 16];
    stream.read_exact(&mut header).map_err(|error| error.to_string())?;

    if &header[0..4] != SDK_MAGIC {
        return Err("OpenRGB SDK returned an invalid packet header.".to_owned());
    }

    let device_id = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let packet_id = u32::from_le_bytes(header[8..12].try_into().unwrap());
    let payload_len = u32::from_le_bytes(header[12..16].try_into().unwrap()) as usize;

    if payload_len > 16 * 1024 * 1024 {
        return Err(format!(
            "OpenRGB SDK returned an unexpectedly large packet: {payload_len} bytes."
        ));
    }

    let mut payload = vec![0_u8; payload_len];
    if payload_len > 0 {
        stream
            .read_exact(&mut payload)
            .map_err(|error| error.to_string())?;
    }

    Ok((device_id, packet_id, payload))
}

#[cfg(windows)]
fn decode_openrgb_profile_name(bytes: &[u8]) -> Result<String, String> {
    if let Ok(value) = std::str::from_utf8(bytes) {
        return Ok(value.to_owned());
    }

    // OpenRGB SDK Protocol 5 enumerates profile filenames using
    // filesystem::path::string() on Windows.  That yields the system ANSI
    // code page (e.g. CP932 on Japanese Windows), not necessarily UTF-8.
    // Decode that fallback via Win32 so non-ASCII profile names survive.
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte: *const i8,
            multi_byte_len: i32,
            wide_char: *mut u16,
            wide_char_len: i32,
        ) -> i32;
    }

    const CP_ACP: u32 = 0;
    let input_len = i32::try_from(bytes.len())
        .map_err(|_| "OpenRGB profile name is too long.".to_owned())?;

    let required = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr() as *const i8,
            input_len,
            std::ptr::null_mut(),
            0,
        )
    };

    if required <= 0 {
        return Err("Failed decoding OpenRGB profile name using the Windows ANSI code page.".to_owned());
    }

    let mut wide = vec![0_u16; required as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr() as *const i8,
            input_len,
            wide.as_mut_ptr(),
            required,
        )
    };

    if written <= 0 {
        return Err("Failed decoding OpenRGB profile name using the Windows ANSI code page.".to_owned());
    }

    String::from_utf16(&wide[..written as usize])
        .map_err(|error| format!("Failed decoding OpenRGB profile name as UTF-16: {error}"))
}

#[cfg(not(windows))]
fn decode_openrgb_profile_name(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|error| format!("Failed decoding OpenRGB profile name as UTF-8: {error}"))
}

fn open_raw_v5_stream() -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect(OPENRGB_ADDRESS).map_err(|error| {
        format!(
            "Failed opening connection to OpenRGB server at {OPENRGB_ADDRESS}: {error}"
        )
    })?;

    let timeout = Some(Duration::from_secs(2));
    stream
        .set_read_timeout(timeout)
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(timeout)
        .map_err(|error| error.to_string())?;
    let _ = stream.set_nodelay(true);

    write_sdk_packet(
        &mut stream,
        0,
        PACKET_REQUEST_PROTOCOL_VERSION,
        &CLIENT_PROTOCOL_VERSION.to_le_bytes(),
    )?;

    let (_, response_id, response_payload) = read_sdk_packet(&mut stream)?;
    if response_id != PACKET_REQUEST_PROTOCOL_VERSION || response_payload.len() != 4 {
        return Err("OpenRGB SDK protocol negotiation returned an unexpected response.".to_owned());
    }

    let server_protocol = u32::from_le_bytes(response_payload[0..4].try_into().unwrap());
    let negotiated = CLIENT_PROTOCOL_VERSION.min(server_protocol);
    if negotiated < 2 {
        return Err(format!(
            "OpenRGB SDK protocol {negotiated} does not support Profiles."
        ));
    }

    let mut client_name = b"OpenRGB Companion".to_vec();
    client_name.push(0);
    write_sdk_packet(&mut stream, 0, PACKET_SET_CLIENT_NAME, &client_name)?;

    Ok(stream)
}

fn get_profiles_raw_v5() -> Result<Vec<String>, String> {
    let mut stream = open_raw_v5_stream()?;
    write_sdk_packet(&mut stream, 0, PACKET_GET_PROFILE_LIST, &[])?;

    let (_, response_id, payload) = read_sdk_packet(&mut stream)?;
    if response_id != PACKET_GET_PROFILE_LIST {
        return Err(format!(
            "OpenRGB SDK returned unexpected packet {response_id} while requesting Profiles."
        ));
    }

    if payload.len() < 6 {
        return Err("OpenRGB SDK returned a truncated Profile list.".to_owned());
    }

    let declared_size = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
    if declared_size > payload.len() {
        return Err(format!(
            "OpenRGB SDK Profile list size is invalid: declared {declared_size}, received {}.",
            payload.len()
        ));
    }

    let num_profiles = u16::from_le_bytes(payload[4..6].try_into().unwrap()) as usize;
    let mut offset = 6usize;
    let mut profiles = Vec::with_capacity(num_profiles);

    for _ in 0..num_profiles {
        if offset + 2 > payload.len() {
            return Err("OpenRGB SDK Profile list ended before a name length field.".to_owned());
        }

        let name_len =
            u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;

        if name_len == 0 || offset + name_len > payload.len() {
            return Err("OpenRGB SDK Profile list contains an invalid name length.".to_owned());
        }

        let raw_name = &payload[offset..offset + name_len];
        offset += name_len;

        let raw_name = raw_name.strip_suffix(&[0]).unwrap_or(raw_name);
        profiles.push(decode_openrgb_profile_name(raw_name)?);
    }

    Ok(profiles)
}

/// openrgb2 0.3.x serializes SAVE_PROFILE differently from LOAD_PROFILE,
/// even though OpenRGB protocol 2-5 expects the profile name as one raw,
/// NUL-terminated string.  Use a tiny protocol-v5 packet writer for this
/// command only; all other SDK traffic stays on openrgb2.
fn save_profile_raw_v5(profile_name: &str) -> Result<(), String> {
    let mut stream = open_raw_v5_stream()?;

    let mut profile_payload = profile_name.as_bytes().to_vec();
    profile_payload.push(0);
    write_sdk_packet(&mut stream, 0, PACKET_SAVE_PROFILE, &profile_payload)?;

    // SAVE_PROFILE has no response in protocol 2-5.  Verification is done
    // immediately afterwards through a fresh Profile-list request and reload.
    Ok(())
}


fn existing_profile_file_path(profile_name: &str) -> Result<PathBuf, String> {
    let appdata = env::var_os("APPDATA")
        .ok_or_else(|| "APPDATAを取得できないため、OpenRGB Profileの場所を確認できませんでした。".to_owned())?;
    Ok(PathBuf::from(appdata)
        .join("OpenRGB")
        .join(format!("{profile_name}.orp")))
}

fn backup_existing_profile_file(profile_name: &str) -> Result<PathBuf, String> {
    let source = existing_profile_file_path(profile_name)?;
    if !source.is_file() {
        return Err(format!(
            "既存Profile「{profile_name}」の .orp ファイルを見つけられないため、安全のため上書きを中止しました: {}",
            source.display()
        ));
    }

    let backup_root = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .ok_or_else(|| "Profileバックアップ先を決定できませんでした。".to_owned())?;
    let backup_dir = PathBuf::from(backup_root)
        .join("OpenRGB Companion")
        .join("profile-backups");
    fs::create_dir_all(&backup_dir).map_err(|error| {
        format!(
            "Profileバックアップ用フォルダを作成できませんでした ({}): {error}",
            backup_dir.display()
        )
    })?;

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let destination = backup_dir.join(format!("{profile_name}_{timestamp_ms}.orp"));

    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "既存Profile「{profile_name}」のバックアップに失敗したため上書きを中止しました ({} -> {}): {error}",
            source.display(),
            destination.display()
        )
    })?;

    Ok(destination)
}

fn backup_hint(backup_path: Option<&Path>) -> String {
    backup_path
        .map(|path| format!(" 変更前のProfileは {} にバックアップ済みです。", path.display()))
        .unwrap_or_default()
}

async fn wait_for_applied_zone_colors(
    zone_colors: &[ZoneColorInput],
) -> Result<OpenRgbSnapshot, String> {
    const VERIFY_ATTEMPTS: usize = 6;
    const VERIFY_INTERVAL: Duration = Duration::from_millis(80);

    let mut last_mismatch = "RGB状態を確認できませんでした。".to_owned();

    for attempt in 0..VERIFY_ATTEMPTS {
        if attempt > 0 {
            thread::sleep(VERIFY_INTERVAL);
        }

        let snapshot = scan().await?;
        match snapshot_matches_zone_colors(&snapshot, zone_colors) {
            Ok(()) => return Ok(snapshot),
            Err(error) => last_mismatch = error,
        }
    }

    Err(format!(
        "OpenRGBの現在状態が保存予定のRGB値と一致しないため、Profile保存を中止しました。SAVE_PROFILEは送信していません。{last_mismatch}"
    ))
}

#[derive(Debug)]
pub struct SaveProfileOutcome {
    pub snapshot: OpenRgbSnapshot,
    pub backup_path: Option<PathBuf>,
}

fn snapshot_matches_zone_colors(
    snapshot: &OpenRgbSnapshot,
    zone_colors: &[ZoneColorInput],
) -> Result<(), String> {
    for input in zone_colors {
        let controller = snapshot
            .controllers
            .iter()
            .find(|controller| controller.id == input.controller_id)
            .ok_or_else(|| {
                format!(
                    "RGB verification failed: controller {} was not found.",
                    input.controller_id
                )
            })?;

        let zone = controller
            .zones
            .iter()
            .find(|zone| zone.id == input.zone_id)
            .ok_or_else(|| {
                format!(
                    "RGB verification failed: zone {} on controller {} was not found.",
                    input.zone_id, input.controller_id
                )
            })?;

        if zone.uniform_color != Some(input.color) {
            return Err(format!(
                "RGB verification failed at \"{}\": expected RGB {}, {}, {}, but read back {}.",
                zone.name,
                input.color.r,
                input.color.g,
                input.color.b,
                zone.uniform_color
                    .map(|color| format!("RGB {}, {}, {}", color.r, color.g, color.b))
                    .unwrap_or_else(|| "multiple/unknown colors".to_owned())
            ));
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneSnapshot {
    pub id: usize,
    pub name: String,
    pub zone_type: String,
    pub led_count: usize,
    pub colors: Vec<RgbColor>,
    pub uniform_color: Option<RgbColor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControllerSnapshot {
    pub id: usize,
    pub name: String,
    pub vendor: String,
    pub description: String,
    pub version: String,
    pub serial: String,
    pub location: String,
    pub device_type: String,
    pub led_count: usize,
    pub active_mode: String,
    pub zones: Vec<ZoneSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenRgbSnapshot {
    pub connected: bool,
    pub address: String,
    pub protocol_version: u32,
    pub profiles: Vec<String>,
    pub controllers: Vec<ControllerSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneColorInput {
    pub controller_id: usize,
    pub zone_id: usize,
    pub color: RgbColor,
}

async fn connect() -> Result<OpenRgbClient, String> {
    let mut client = OpenRgbClient::connect_to(OPENRGB_ADDRESS, CLIENT_PROTOCOL_VERSION)
        .await
        .map_err(|error| error.to_string())?;
    client
        .set_name("OpenRGB Companion")
        .await
        .map_err(|error| error.to_string())?;
    Ok(client)
}

async fn snapshot_from_client(client: &mut OpenRgbClient) -> Result<OpenRgbSnapshot, String> {
    let protocol_version = client.get_protocol_version();
    let profiles = get_profiles_raw_v5().unwrap_or_default();
    let group = client
        .get_all_controllers()
        .await
        .map_err(|error| error.to_string())?;

    let controllers = group
        .iter()
        .map(|controller| {
            let controller_colors = controller.colors();

            let zones = controller
                .get_all_zones()
                .map(|zone| {
                    let start = zone.offset().min(controller_colors.len());
                    let end = start
                        .saturating_add(zone.num_leds())
                        .min(controller_colors.len());

                    let colors: Vec<RgbColor> = controller_colors[start..end]
                        .iter()
                        .map(|color| RgbColor {
                            r: color.r,
                            g: color.g,
                            b: color.b,
                        })
                        .collect();

                    let uniform_color = colors
                        .first()
                        .copied()
                        .filter(|first| colors.iter().all(|color| color == first));

                    ZoneSnapshot {
                        id: zone.id(),
                        name: zone.name().to_owned(),
                        zone_type: format!("{:?}", zone.zone_type()),
                        led_count: zone.num_leds(),
                        colors,
                        uniform_color,
                    }
                })
                .collect();

            ControllerSnapshot {
                id: controller.id(),
                name: controller.name().to_owned(),
                vendor: controller.vendor().to_owned(),
                description: controller.description().to_owned(),
                version: controller.version().to_owned(),
                serial: controller.serial().to_owned(),
                location: controller.location().to_owned(),
                device_type: format!("{:?}", controller.device_type()),
                led_count: controller.num_leds(),
                active_mode: controller.active_mode().name().to_owned(),
                zones,
            }
        })
        .collect();

    Ok(OpenRgbSnapshot {
        connected: true,
        address: OPENRGB_ADDRESS.to_owned(),
        protocol_version,
        profiles,
        controllers,
    })
}

async fn apply_zone_colors_with_client(
    client: &OpenRgbClient,
    zone_colors: &[ZoneColorInput],
) -> Result<(), String> {
    let group = client
        .get_all_controllers()
        .await
        .map_err(|error| error.to_string())?;

    // Validate every requested controller/zone before touching hardware.
    for input in zone_colors {
        let controller = group
            .iter()
            .find(|controller| controller.id() == input.controller_id)
            .ok_or_else(|| format!("Controller not found: {}", input.controller_id))?;

        controller
            .get_zone(input.zone_id)
            .map_err(|error| error.to_string())?;
    }

    // Apply one controller-wide LED buffer per controller.
    //
    // v0.11.14 tried to build that buffer through Command::set_zone_leds(), but
    // openrgb2 0.3.0 rejects the full-zone form for this controller (including
    // the 1-LED RGB headers).  Build the complete color vector ourselves using
    // each zone's controller offset, then send exactly one UPDATE_LEDS request.
    //
    // This keeps unrelated zones separate while avoiding rapid consecutive
    // UPDATE_ZONE_LEDS requests on motherboard controllers.
    for controller in group.iter() {
        let controller_inputs: Vec<&ZoneColorInput> = zone_colors
            .iter()
            .filter(|input| input.controller_id == controller.id())
            .collect();

        if controller_inputs.is_empty() {
            continue;
        }

        let mut colors = controller.colors().to_vec();

        if colors.len() != controller.num_leds() {
            return Err(format!(
                "Controller {} color buffer mismatch: {} colors for {} LEDs.",
                controller.id(),
                colors.len(),
                controller.num_leds()
            ));
        }

        for input in controller_inputs {
            let zone = controller
                .get_zone(input.zone_id)
                .map_err(|error| error.to_string())?;

            let start = zone.offset();
            let end = start
                .checked_add(zone.num_leds())
                .ok_or_else(|| format!(
                    "Zone {} on controller {} has an invalid LED range.",
                    input.zone_id, input.controller_id
                ))?;

            if end > colors.len() {
                return Err(format!(
                    "Zone {} on controller {} exceeds the controller LED buffer ({}..{} of {}).",
                    input.zone_id,
                    input.controller_id,
                    start,
                    end,
                    colors.len()
                ));
            }

            let color = Color::new(input.color.r, input.color.g, input.color.b);
            for led_color in &mut colors[start..end] {
                *led_color = color;
            }
        }

        controller
            .set_leds(colors)
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub async fn scan() -> Result<OpenRgbSnapshot, String> {
    // Keep OpenRGB-specific code inside this module so the transport can be
    // swapped when SDK Protocol 6 support becomes necessary.
    let mut client = connect().await?;
    snapshot_from_client(&mut client).await
}

pub async fn load_profile_and_scan(profile_name: &str) -> Result<OpenRgbSnapshot, String> {
    let profile_name = profile_name.trim();
    if profile_name.is_empty() {
        return Err("Profile name is empty.".to_owned());
    }

    let client = connect().await?;
    let profiles = get_profiles_raw_v5()?;

    if !profiles.iter().any(|name| name == profile_name) {
        return Err(format!("OpenRGB profile not found: {profile_name}"));
    }

    client
        .load_profile(profile_name.to_owned())
        .await
        .map_err(|error| error.to_string())?;

    // A fresh SDK scan is intentional after profile load. OpenRGB updates its
    // server-side controller state when a profile is loaded, and the client
    // must re-request controller data to see that state.
    drop(client);
    scan().await
}

pub async fn preview_zone_colors(
    zone_colors: &[ZoneColorInput],
    base_profile_name: Option<&str>,
) -> Result<OpenRgbSnapshot, String> {
    if zone_colors.is_empty() {
        return Err("No zone colors were supplied.".to_owned());
    }

    let mut client = connect().await?;

    if let Some(base_profile_name) = base_profile_name.map(str::trim).filter(|name| !name.is_empty()) {
        let profiles = get_profiles_raw_v5()?;
        if !profiles.iter().any(|name| name == base_profile_name) {
            return Err(format!("OpenRGB base profile not found: {base_profile_name}"));
        }
        client
            .load_profile(base_profile_name.to_owned())
            .await
            .map_err(|error| error.to_string())?;
        // Profile load changes server-side state. Reconnect before applying the
        // edited RGB values so controller metadata/modes come from that base.
        drop(client);
        client = connect().await?;
    }

    apply_zone_colors_with_client(&client, zone_colors).await?;
    drop(client);
    scan().await
}

pub async fn apply_live_zone_colors(zone_colors: &[ZoneColorInput]) -> Result<(), String> {
    if zone_colors.is_empty() {
        return Err("No zone colors were supplied.".to_owned());
    }

    let client = connect().await?;
    apply_zone_colors_with_client(&client, zone_colors).await
}

pub async fn save_profile_from_zone_colors(
    profile_name: &str,
    zone_colors: &[ZoneColorInput],
    allow_overwrite: bool,
    base_profile_name: Option<&str>,
) -> Result<SaveProfileOutcome, String> {
    let profile_name = profile_name.trim();
    if profile_name.is_empty() {
        return Err("Profile name is empty.".to_owned());
    }
    if !profile_name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-' || ch == '_')
    {
        return Err(
            "OpenRGBとの互換性のため、Profile名には半角英数字・半角スペース・「-」「_」だけを使用してください。"
                .to_owned(),
        );
    }
    if zone_colors.is_empty() {
        return Err("No zone colors were supplied.".to_owned());
    }

    let mut client = connect().await?;
    let existing_profiles = get_profiles_raw_v5()?;

    if !allow_overwrite && existing_profiles.iter().any(|name| name == profile_name) {
        return Err(format!(
            "OpenRGB profile already exists: {profile_name}. Choose a different name."
        ));
    }

    if let Some(base_profile_name) = base_profile_name.map(str::trim).filter(|name| !name.is_empty()) {
        if !existing_profiles.iter().any(|name| name == base_profile_name) {
            return Err(format!("OpenRGB base profile not found: {base_profile_name}"));
        }
        client
            .load_profile(base_profile_name.to_owned())
            .await
            .map_err(|error| error.to_string())?;
        // Reconnect after loading the base profile so we preserve its mode and
        // other profile-side state, then only replace the requested RGB colors.
        drop(client);
        client = connect().await?;
    }

    apply_zone_colors_with_client(&client, zone_colors).await?;
    drop(client);

    // SAVE_PROFILE stores OpenRGB's current server-side state.  Never send it
    // until a fresh SDK read-back confirms that every requested zone really
    // contains the RGB values we intend to persist.
    let _pre_save_verified = wait_for_applied_zone_colors(zone_colors).await?;

    let profile_already_exists = existing_profiles.iter().any(|name| name == profile_name);
    let backup_path = if allow_overwrite && profile_already_exists {
        Some(backup_existing_profile_file(profile_name)?)
    } else {
        None
    };

    save_profile_raw_v5(profile_name)
        .map_err(|error| format!("{error}{}", backup_hint(backup_path.as_deref())))?;

    // OpenRGB's SAVE_PROFILE packet has no success response, so never report
    // success merely because the packet was written.  Re-query the profile list
    // and then load/read the saved profile back to verify both existence and RGB.
    std::thread::sleep(Duration::from_millis(120));

    let verified_profiles = get_profiles_raw_v5()
        .map_err(|error| format!("{error}{}", backup_hint(backup_path.as_deref())))?;

    if !verified_profiles.iter().any(|name| name == profile_name) {
        return Err(format!(
            "OpenRGBへ保存要求を送信しましたが、Profile一覧に「{profile_name}」を確認できませんでした。OpenRGBは --gui --server で起動してください。{}",
            backup_hint(backup_path.as_deref())
        ));
    }

    let verified_snapshot = load_profile_and_scan(profile_name)
        .await
        .map_err(|error| format!("{error}{}", backup_hint(backup_path.as_deref())))?;
    snapshot_matches_zone_colors(&verified_snapshot, zone_colors).map_err(|error| {
        format!(
            "OpenRGB保存後のRGB検証に失敗しました。{error}{}",
            backup_hint(backup_path.as_deref())
        )
    })?;

    Ok(SaveProfileOutcome {
        snapshot: verified_snapshot,
        backup_path,
    })
}
