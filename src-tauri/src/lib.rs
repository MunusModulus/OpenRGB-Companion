mod openrgb;
mod scheduler;
mod storage;

use openrgb::{OpenRgbSnapshot, ZoneColorInput};
use scheduler::{SchedulerSnapshot, SchedulerTask};
use serde::Serialize;
use storage::SavedProfile;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
struct CaptureProfileResult {
    profile: SavedProfile,
    snapshot: OpenRgbSnapshot,
}

#[tauri::command]
async fn scan_openrgb() -> Result<OpenRgbSnapshot, String> {
    let openrgb_was_started = openrgb::ensure_openrgb_ready()?;
    let mut snapshot = openrgb::scan().await?;

    // OpenRGB opens the SDK port before hardware discovery is necessarily
    // complete.  On a cold/restarted launch, wait for controller enumeration
    // so the first Companion screen does not briefly settle at 0 controllers.
    if openrgb_was_started && snapshot.controllers.is_empty() {
        for _ in 0..24 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            snapshot = openrgb::scan().await?;
            if !snapshot.controllers.is_empty() {
                break;
            }
        }
    }

    Ok(snapshot)
}

#[tauri::command]
fn list_saved_profiles(app: AppHandle) -> Result<Vec<SavedProfile>, String> {
    storage::list(&app)
}

#[tauri::command]
async fn capture_openrgb_profile(
    app: AppHandle,
    profile_name: String,
) -> Result<CaptureProfileResult, String> {
    let _ = openrgb::ensure_openrgb_ready()?;
    let snapshot = openrgb::load_profile_and_scan(&profile_name).await?;
    let profile = storage::upsert(&app, profile_name, snapshot.controllers.clone())?;
    Ok(CaptureProfileResult { profile, snapshot })
}

#[tauri::command]
async fn preview_profile_colors(
    zone_colors: Vec<ZoneColorInput>,
    base_profile_name: Option<String>,
) -> Result<OpenRgbSnapshot, String> {
    let _ = openrgb::ensure_openrgb_ready()?;
    openrgb::preview_zone_colors(&zone_colors, base_profile_name.as_deref()).await
}

#[tauri::command]
async fn apply_live_zone_colors(zone_colors: Vec<ZoneColorInput>) -> Result<(), String> {
    let _ = openrgb::ensure_openrgb_ready()?;
    openrgb::apply_live_zone_colors(&zone_colors).await
}

#[tauri::command]
async fn save_profile_from_colors(
    app: AppHandle,
    profile_name: String,
    zone_colors: Vec<ZoneColorInput>,
    allow_overwrite: bool,
    base_profile_name: Option<String>,
) -> Result<CaptureProfileResult, String> {
    let _ = openrgb::ensure_openrgb_ready()?;
    let snapshot = openrgb::save_profile_from_zone_colors(
        &profile_name,
        &zone_colors,
        allow_overwrite,
        base_profile_name.as_deref(),
    )
    .await?;
    let profile = storage::upsert(&app, profile_name, snapshot.controllers.clone())?;
    Ok(CaptureProfileResult { profile, snapshot })
}

#[tauri::command]
fn delete_saved_profile(app: AppHandle, profile_name: String) -> Result<(), String> {
    storage::delete(&app, &profile_name)
}

#[tauri::command]
fn load_scheduler_settings() -> Result<SchedulerSnapshot, String> {
    scheduler::load()
}

#[tauri::command]
fn save_scheduler_settings(tasks: Vec<SchedulerTask>) -> Result<SchedulerSnapshot, String> {
    openrgb::restart_openrgb_around_settings_update(|| scheduler::save_file(&tasks))?;

    // Scheduler Plugin loads its JSON settings on a delayed initialization.
    std::thread::sleep(std::time::Duration::from_millis(2300));

    scheduler::load()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scan_openrgb,
            list_saved_profiles,
            capture_openrgb_profile,
            preview_profile_colors,
            apply_live_zone_colors,
            save_profile_from_colors,
            delete_saved_profile,
            load_scheduler_settings,
            save_scheduler_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenRGB Companion");
}
