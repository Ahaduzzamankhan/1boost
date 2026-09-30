//! Persistent JSON storage — port of electron/main/storage.ts.
//! Paths and file formats are byte-compatible with the Electron version:
//!   %APPDATA%\1Boost\usage-data.json (+ .bak0..2, .tmp)
//!   %APPDATA%\1Boost\settings.json
//! so existing users keep their history and preferences.

use crate::aggregator::rebuild_totals;
use crate::model::*;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const BACKUP_COUNT: usize = 3;
const BACKUP_MIN_INTERVAL_MS: u64 = 5 * 60_000;

pub struct Storage {
    pub data_path: PathBuf,
    pub settings_path: PathBuf,
    pub data: UsageData,
    pub settings: SettingsFile,
    pub recovered: bool,
    pub last_error: Option<String>,
    last_backup_at: u64,
}

/// Resolve the user-data base dir. Packaged Tauri apps on Windows use
/// %APPDATA%\<identifier>; we pin the legacy Electron folder name "1Boost"
/// so existing data is picked up in place.
pub fn user_data_dir() -> PathBuf {
    if let Some(dir) = dirs_next() {
        return dir;
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".1boost-user-data")
}

#[cfg(windows)]
fn dirs_next() -> Option<PathBuf> {
    // %APPDATA% (roaming) — exactly where Electron's userData lived.
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("1Boost"))
}

#[cfg(not(windows))]
fn dirs_next() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from).map(|p| p.join("1Boost"))
}

fn num_u64(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

/// Normalize + validate a parsed UsageData to survive schema drift / hand
/// edits (port of normalizeUsageData).
pub fn normalize_usage_data(v: serde_json::Value) -> UsageData {
    let mut days = BTreeMap::new();
    if let Some(obj) = v.get("days").and_then(|d| d.as_object()) {
        for (k, d) in obj {
            if k.len() != 10 || !d.is_object() {
                continue;
            }
            if !(k.as_bytes().len() == 10
                && k.as_bytes()[4] == b'-'
                && k.as_bytes()[7] == b'-'
                && k.chars().all(|c| c.is_ascii_digit() || c == '-'))
            {
                continue;
            }
            let apps = d
                .get("apps")
                .and_then(|a| a.as_object())
                .map(|a| {
                    a.iter()
                        .filter(|(k, _)| !k.is_empty() && k.len() <= 64)
                        .filter_map(|(k, v)| v.as_u64().map(|ms| (k.clone(), ms)))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            days.insert(
                k.clone(),
                DayData {
                    date: k.clone(),
                    pc_on_ms: num_u64(d.get("pcOnMs")),
                    active_ms: num_u64(d.get("activeMs")),
                    idle_ms: num_u64(d.get("idleMs")),
                    screen_on_ms: num_u64(d.get("screenOnMs")),
                    first_ms: num_u64(d.get("firstMs")),
                    last_ms: num_u64(d.get("lastMs")),
                    battery_ms: num_u64(d.get("batteryMs")),
                    ac_ms: num_u64(d.get("acMs")),
                    focus_ms: num_u64(d.get("focusMs")),
                    apps,
                },
            );
        }
    }

    let sessions = v
        .get("sessions")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let start = s.get("startMs")?.as_u64()?;
                    Some(Session {
                        id: s.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                        start_ms: start,
                        end_ms: s.get("endMs").and_then(|e| e.as_u64()).unwrap_or(start),
                        active_ms: s.get("activeMs").and_then(|e| e.as_u64()).unwrap_or(0),
                        on_ms: s.get("onMs").and_then(|e| e.as_u64()).unwrap_or(0),
                        idle_ms: s.get("idleMs").and_then(|e| e.as_u64()).unwrap_or(0),
                        sleep: s.get("sleep").and_then(|e| e.as_bool()).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let pending = v.get("pendingSession").and_then(|p| {
        let start = p.get("startMs")?.as_u64()?;
        Some(PendingSession {
            start_ms: start,
            active_ms: p.get("activeMs").and_then(|e| e.as_u64()).unwrap_or(0),
            on_ms: p.get("onMs").and_then(|e| e.as_u64()).unwrap_or(0),
            idle_ms: p.get("idleMs").and_then(|e| e.as_u64()).unwrap_or(0),
        })
    });

    let app_names = v
        .get("appNames")
        .and_then(|a| a.as_object())
        .map(|a| {
            a.iter()
                .filter(|(k, n)| !k.is_empty() && k.len() <= 64 && n.as_str().map(|s| s.len() <= 64).unwrap_or(false))
                .filter_map(|(k, n)| n.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();

    let now = crate::util::now_ms();
    let mut data = UsageData {
        version: DATA_VERSION,
        created_at: v.get("createdAt").and_then(|c| c.as_u64()).unwrap_or(now),
        updated_at: v.get("updatedAt").and_then(|c| c.as_u64()).unwrap_or(now),
        days,
        sessions,
        totals: Totals::default(),
        pending_session: pending,
        app_names,
    };
    rebuild_totals(&mut data);
    data
}

pub fn sanitize_prefs(p: serde_json::Value) -> Prefs {
    let parsed: Result<Prefs, _> = serde_json::from_value(p.clone());
    match parsed {
        Ok(mut prefs) => {
            // Rebuild from defaults + recognized fields (mirror of sanitizePrefs).
            let mut out = Prefs::default();
            if let Some(t) = p.get("theme").and_then(|t| t.as_str()) {
                out.theme = match t {
                    "white-glass" => Theme::WhiteGlass,
                    "solid-dark" => Theme::SolidDark,
                    "solid-white" => Theme::SolidWhite,
                    "amoled" => Theme::Amoled,
                    _ => Theme::DarkGlass,
                };
            }
            if let Some(a) = p.get("accent").and_then(|a| a.as_str()) {
                out.accent = match a {
                    "violet" => Accent::Violet,
                    "teal" => Accent::Teal,
                    "green" => Accent::Green,
                    "amber" => Accent::Amber,
                    "rose" => Accent::Rose,
                    "sky" => Accent::Sky,
                    "crimson" => Accent::Crimson,
                    _ => Accent::Blue,
                };
            }
            if let Some(t) = p.get("transparency").and_then(|t| t.as_f64()) {
                out.transparency = t.clamp(0.0, 1.0);
            }
            for (key, target) in [
                ("reducedMotion", &mut out.reduced_motion as *mut bool),
            ] {
                let _ = key;
                if let Some(b) = p.get(key).and_then(|b| b.as_bool()) {
                    unsafe { *target = b };
                }
            }
            if let Some(b) = p.get("launchAtLogin").and_then(|b| b.as_bool()) {
                out.launch_at_login = b;
            }
            if let Some(b) = p.get("startMinimized").and_then(|b| b.as_bool()) {
                out.start_minimized = b;
            }
            if let Some(b) = p.get("pauseTracking").and_then(|b| b.as_bool()) {
                out.pause_tracking = b;
            }
            if let Some(n) = p.get("idleThresholdMin").and_then(|n| n.as_f64()) {
                out.idle_threshold_min = (n.round() as i64).clamp(1, 120);
            }
            if let Some(n) = p.get("keepHistoryDays").and_then(|n| n.as_f64()) {
                out.keep_history_days = (n.round() as i64).clamp(7, 3650);
            }
            if let Some(b) = p.get("showTray").and_then(|b| b.as_bool()) {
                out.show_tray = b;
            }
            let _ = &mut prefs;
            out
        }
        Err(_) => Prefs::default(),
    }
}

impl Storage {
    pub fn new() -> Storage {
        let base = user_data_dir();
        let data_path = base.join("usage-data.json");
        let settings_path = base.join("settings.json");
        Storage {
            data_path,
            settings_path,
            data: UsageData::empty(),
            settings: SettingsFile::default(),
            recovered: false,
            last_error: None,
            last_backup_at: 0,
        }
    }

    pub fn load(&mut self) {
        let _ = fs::create_dir_all(self.data_path.parent().unwrap_or(Path::new(".")));
        let _ = fs::create_dir_all(self.settings_path.parent().unwrap_or(Path::new(".")));
        self.load_data();
        self.load_settings();
        if !self.recovered {
            self.write_backup(0);
        }
    }

    fn backup_path(&self, slot: usize) -> PathBuf {
        PathBuf::from(format!("{}.bak{}", self.data_path.display(), slot))
    }

    fn write_backup(&self, slot: usize) {
        if !self.data_path.exists() {
            return;
        }
        let _ = fs::copy(&self.data_path, self.backup_path(slot));
    }

    fn rotate_backups(&mut self) {
        for i in (1..BACKUP_COUNT).rev() {
            let older = self.backup_path(i - 1);
            if older.exists() {
                let _ = fs::copy(&older, self.backup_path(i));
            }
        }
        self.write_backup(0);
    }

    fn schedule_backup(&mut self) {
        let now = crate::util::now_ms();
        if now.saturating_sub(self.last_backup_at) < BACKUP_MIN_INTERVAL_MS {
            return;
        }
        self.last_backup_at = now;
        self.rotate_backups();
    }

    fn try_recover_from_backups(&mut self) -> bool {
        for slot in 0..BACKUP_COUNT {
            let p = self.backup_path(slot);
            if !p.exists() {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if v.get("days").map(|d| d.is_object()).unwrap_or(false) {
                        let _ = fs::copy(&p, &self.data_path);
                        self.data = normalize_usage_data(v);
                        self.recovered = true;
                        self.last_error = Some(
                            "Your usage file was damaged; 1Boost restored the most recent backup.".into(),
                        );
                        return true;
                    }
                }
            }
        }
        false
    }

    fn load_data(&mut self) {
        match fs::read_to_string(&self.data_path) {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(v) => {
                    if v.get("days").map(|d| d.is_object()).unwrap_or(false) {
                        self.data = normalize_usage_data(v);
                        return;
                    }
                    if self.try_recover_from_backups() {
                        return;
                    }
                    self.recovered = true;
                    self.last_error = Some("Unrecognized data file format; starting fresh.".into());
                }
                Err(_) => {
                    if self.try_recover_from_backups() {
                        return;
                    }
                    self.recovered = true;
                    self.last_error = Some(
                        "Your usage file could not be read and no backup was usable. 1Boost will rebuild it automatically."
                            .into(),
                    );
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                if self.try_recover_from_backups() {
                    return;
                }
                self.recovered = true;
                self.last_error = Some(
                    "Your usage file could not be read and no backup was usable. 1Boost will rebuild it automatically."
                        .into(),
                );
            }
        }
    }

    fn load_settings(&mut self) {
        match fs::read_to_string(&self.settings_path) {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(v) => {
                    if let Some(p) = v.get("prefs") {
                        self.settings = SettingsFile { version: SETTINGS_VERSION, prefs: sanitize_prefs(p.clone()) };
                        return;
                    }
                    self.recovered = true;
                }
                Err(_) => {
                    self.recovered = true;
                    self.last_error = Some(
                        self.last_error.clone().unwrap_or_else(|| {
                            "Your settings file could not be read; defaults were restored.".into()
                        }),
                    );
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                self.recovered = true;
                self.last_error = Some(
                    self.last_error.clone().unwrap_or_else(|| {
                        "Your settings file could not be read; defaults were restored.".into()
                    }),
                );
            }
        }
    }

    fn atomic_write(&self, path: &Path, payload: &str) -> std::io::Result<()> {
        let tmp = PathBuf::from(format!("{}.tmp", path.display()));
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(payload.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp, path)
    }

    pub fn save_settings(&mut self) -> std::io::Result<()> {
        self.settings.version = SETTINGS_VERSION;
        let payload = serde_json::to_string_pretty(&self.settings)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        self.atomic_write(&self.settings_path, &payload)
    }

    pub fn save_data(&mut self) -> std::io::Result<()> {
        self.data.updated_at = crate::util::now_ms();
        let payload = serde_json::to_string(&self.data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        self.atomic_write(&self.data_path, &payload)?;
        self.schedule_backup();
        Ok(())
    }

    /// Synchronous save for suspend/shutdown/lock flushes.
    pub fn save_data_sync(&mut self) -> std::io::Result<()> {
        self.data.updated_at = crate::util::now_ms();
        let payload = serde_json::to_string(&self.data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        self.atomic_write(&self.data_path, &payload)
    }

    pub fn delete_all(&mut self) -> std::io::Result<()> {
        self.data = UsageData::empty();
        let _ = fs::remove_file(&self.data_path);
        self.save_data()?;
        for slot in 0..BACKUP_COUNT {
            let _ = fs::remove_file(self.backup_path(slot));
        }
        Ok(())
    }

    pub fn status(&self) -> StorageStatus {
        let bytes = fs::metadata(&self.data_path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|_| fs::metadata(&self.data_path).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        let _ = SystemTime::UNIX_EPOCH + Duration::from_secs(0); // keep import used
        StorageStatus {
            file: self.data_path.display().to_string(),
            bytes,
            recovered: self.recovered,
            healthy: !self.recovered,
        }
    }
}
