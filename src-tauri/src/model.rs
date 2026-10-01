//! 1Boost usage model — mirrors shared/types.ts and the Electron storage
//! schema exactly (usage-data.json / settings.json in %APPDATA%\1Boost).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DATA_VERSION: u32 = 1;
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Theme {
    #[serde(rename = "dark-glass")]
    DarkGlass,
    #[serde(rename = "white-glass")]
    WhiteGlass,
    #[serde(rename = "solid-dark")]
    SolidDark,
    #[serde(rename = "solid-white")]
    SolidWhite,
    #[serde(rename = "amoled")]
    Amoled,
}

impl Default for Theme {
    fn default() -> Self {
        Theme::DarkGlass
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Accent {
    #[serde(rename = "blue")]
    Blue,
    #[serde(rename = "violet")]
    Violet,
    #[serde(rename = "teal")]
    Teal,
    #[serde(rename = "green")]
    Green,
    #[serde(rename = "amber")]
    Amber,
    #[serde(rename = "rose")]
    Rose,
    #[serde(rename = "sky")]
    Sky,
    #[serde(rename = "crimson")]
    Crimson,
}

impl Default for Accent {
    fn default() -> Self {
        Accent::Blue
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub theme: Theme,
    pub accent: Accent,
    pub transparency: f64,
    pub reduced_motion: bool,
    pub launch_at_login: bool,
    pub start_minimized: bool,
    pub pause_tracking: bool,
    pub idle_threshold_min: i64,
    pub keep_history_days: i64,
    pub show_tray: bool,
    /// User opt-in for the experimental AI assistant (1.3.2). Defaults to off,
    /// and `serde(default)` keeps settings files written before it intact.
    #[serde(default)]
    pub experimental_ai: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            theme: Theme::DarkGlass,
            accent: Accent::Blue,
            transparency: 0.4,
            reduced_motion: false,
            launch_at_login: false,
            start_minimized: false,
            pause_tracking: false,
            idle_threshold_min: 1,
            keep_history_days: 365,
            show_tray: true,
            experimental_ai: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayData {
    pub date: String,
    pub pc_on_ms: u64,
    pub active_ms: u64,
    pub idle_ms: u64,
    pub screen_on_ms: u64,
    pub first_ms: u64,
    pub last_ms: u64,
    pub battery_ms: u64,
    pub ac_ms: u64,
    #[serde(default)]
    pub focus_ms: u64,
    /// PC-on milliseconds per local hour of this day (index = local hour).
    /// Added in 1.3.1: without it the dashboard's "Today" view had to guess a
    /// shape from the day's first/last sample, which drew a flat block that
    /// never matched what the user was actually doing. Days recorded before
    /// this field existed deserialize as all zeroes and fall back to the old
    /// estimate, so old data files keep loading untouched.
    #[serde(default)]
    pub hours: [u64; 24],
    /// Same buckets, counting only time the user was actually active.
    #[serde(default)]
    pub active_hours: [u64; 24],
    #[serde(default)]
    pub apps: BTreeMap<String, u64>,
}

impl DayData {
    pub fn empty(date: String, now_ms: u64) -> Self {
        DayData {
            date,
            pc_on_ms: 0,
            active_ms: 0,
            idle_ms: 0,
            screen_on_ms: 0,
            first_ms: now_ms,
            last_ms: now_ms,
            battery_ms: 0,
            ac_ms: 0,
            focus_ms: 0,
            hours: [0; 24],
            active_hours: [0; 24],
            apps: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub active_ms: u64,
    pub on_ms: u64,
    pub idle_ms: u64,
    pub sleep: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSession {
    pub start_ms: u64,
    pub active_ms: u64,
    pub on_ms: u64,
    pub idle_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub pc_on_ms: u64,
    pub active_ms: u64,
    pub idle_ms: u64,
    pub days: u64,
}

/// Whole usage store. Day keys are sorted (BTreeMap) exactly like the JS
/// implementation's sortedDayKeys().
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub version: u32,
    pub created_at: u64,
    pub updated_at: u64,
    pub days: BTreeMap<String, DayData>,
    pub sessions: Vec<Session>,
    pub totals: Totals,
    #[serde(default)]
    pub pending_session: Option<PendingSession>,
    #[serde(default)]
    pub app_names: BTreeMap<String, String>,
    /// App key → executable path. Added in 1.2.1: without it the shell icon
    /// of an app could only be read in the session that first used it, so
    /// every previously seen app fell back to the generic glyph. Optional and
    /// ignored by older builds, so existing data files keep loading.
    #[serde(default)]
    pub app_paths: BTreeMap<String, String>,
}

impl UsageData {
    pub fn empty() -> Self {
        let now = crate::util::now_ms();
        UsageData {
            version: DATA_VERSION,
            created_at: now,
            updated_at: now,
            days: BTreeMap::new(),
            sessions: Vec::new(),
            totals: Totals::default(),
            pending_session: None,
            app_names: BTreeMap::new(),
            app_paths: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub version: u32,
    pub prefs: Prefs,
}

impl Default for SettingsFile {
    fn default() -> Self {
        SettingsFile { version: SETTINGS_VERSION, prefs: Prefs::default() }
    }
}

// ---------------------------------------------------------------------------
// Live payload types (camelCase for the renderer)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub version: u32,
    pub now_ms: u64,
    pub started_at: u64,
    pub day: String,
    pub pc_on_ms: u64,
    pub active_ms: u64,
    pub idle_ms: u64,
    pub screen_on_ms: u64,
    pub paused: bool,
    pub app_key: String,
    pub app_name: String,
    pub app_start_ms: u64,
    pub app_elapsed_ms: u64,
    pub battery: BatteryState,
    pub battery_remaining_min: Option<i32>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryState {
    pub charging: bool,
    pub pct: u8,
    pub no_battery: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAgg {
    pub key: String,
    pub name: String,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageItem {
    pub key: String,
    pub name: String,
    pub ms: u64,
    pub icon_data_url: Option<String>,
    pub last_used_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub today: DayData,
    pub apps: Vec<AppUsageItem>,
    pub hourly: Vec<f64>,
    /// Same 24 buckets, active time only.
    pub hourly_active: Vec<f64>,
    pub snapshot: LiveSnapshot,
    pub totals: Totals,
    pub daily: Vec<TrendPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub date: String,
    pub active_ms: u64,
    pub on_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendData {
    pub points: Vec<TrendPoint>,
    pub avg_baseline_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekdayAverages {
    pub buckets: Vec<WeekdayBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekdayBucket {
    pub weekday: u32,
    pub active_ms: u64,
    pub days: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayDetail {
    pub day: DayData,
    pub top_apps: Vec<AppAgg>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<DayDetail>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDetailData {
    pub identity: Identity,
    pub total_ms: u64,
    pub active_share: f64,
    pub last_used_ms: Option<u64>,
    pub per_day: Vec<PerDayUse>,
    pub icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerDayUse {
    pub date: String,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsOverview {
    pub totals: Totals,
    pub avg_day_active_ms: f64,
    pub avg_day_on_ms: f64,
    pub avg_session_ms: f64,
    pub longest_session: Option<Session>,
    pub top_app: Option<AppAgg>,
    pub active_days: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub file: String,
    pub bytes: u64,
    pub recovered: bool,
    pub healthy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchState {
    pub enabled: bool,
    pub registered: bool,
    pub path_matches: bool,
    pub needs_repair: bool,
    pub registered_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Prefs clamping (mirrors storage.ts sanitizePrefs)
// ---------------------------------------------------------------------------

impl Prefs {
    pub fn sanitized(mut self) -> Self {
        self.transparency = self.transparency.clamp(0.0, 1.0);
        if !self.transparency.is_finite() {
            self.transparency = 0.4;
        }
        self.idle_threshold_min = self.idle_threshold_min.clamp(1, 120);
        self.keep_history_days = self.keep_history_days.clamp(7, 3650);
        self
    }
}
