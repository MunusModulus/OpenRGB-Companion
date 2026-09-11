use crate::openrgb::ControllerSnapshot;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};

const STORE_SCHEMA_VERSION: u32 = 1;
const STORE_FILE_NAME: &str = "profile-ledger.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProfile {
    pub name: String,
    pub captured_at_unix_ms: u64,
    pub controllers: Vec<ControllerSnapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProfileStore {
    schema_version: u32,
    profiles: Vec<SavedProfile>,
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_SCHEMA_VERSION,
            profiles: Vec::new(),
        }
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(STORE_FILE_NAME))
}

fn read_store(app: &AppHandle) -> Result<ProfileStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(ProfileStore::default());
    }

    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return Ok(ProfileStore::default());
    }

    let store: ProfileStore = serde_json::from_str(&text)
        .map_err(|error| format!("Failed reading {}: {error}", path.display()))?;

    if store.schema_version != STORE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported profile ledger schema: {}",
            store.schema_version
        ));
    }

    Ok(store)
}

fn write_store(app: &AppHandle, store: &ProfileStore) -> Result<(), String> {
    let path = store_path(app)?;
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("Failed writing {}: {error}", path.display()))
}

fn now_unix_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    u64::try_from(millis).map_err(|_| "Current time does not fit in u64.".to_owned())
}

pub fn list(app: &AppHandle) -> Result<Vec<SavedProfile>, String> {
    let mut profiles = read_store(app)?.profiles;
    profiles.sort_by(|a, b| b.captured_at_unix_ms.cmp(&a.captured_at_unix_ms));
    Ok(profiles)
}

pub fn upsert(
    app: &AppHandle,
    name: String,
    controllers: Vec<ControllerSnapshot>,
) -> Result<SavedProfile, String> {
    let profile = SavedProfile {
        name: name.trim().to_owned(),
        captured_at_unix_ms: now_unix_ms()?,
        controllers,
    };

    if profile.name.is_empty() {
        return Err("Profile name is empty.".to_owned());
    }

    let mut store = read_store(app)?;
    if let Some(existing) = store.profiles.iter_mut().find(|item| item.name == profile.name) {
        *existing = profile.clone();
    } else {
        store.profiles.push(profile.clone());
    }
    write_store(app, &store)?;
    Ok(profile)
}

pub fn delete(app: &AppHandle, name: &str) -> Result<(), String> {
    let mut store = read_store(app)?;
    let before = store.profiles.len();
    store.profiles.retain(|item| item.name != name);

    if store.profiles.len() == before {
        return Err(format!("Saved profile not found: {name}"));
    }

    write_store(app, &store)
}
