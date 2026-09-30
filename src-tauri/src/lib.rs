//! 1Boost Tauri backend.
//!
//! Architecture: React UI → Tauri IPC (commands + events) → this Rust layer
//! → the `oneboost-native` crate → Windows APIs. All Electron main-process
//! responsibilities live here now (tracking loop, storage, tray, window,
//! login item, updates); the React UI and the native monitoring logic are
//! unchanged.

mod aggregator;
mod apps;
mod icons;
mod model;
mod monitor;
mod settings;
mod storage;
mod tracker;
mod updater;
mod util;

use model::*;
use monitor::MonitorPayload;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tracker::SharedTracker;
use util::now_ms;

pub struct AppState {
    pub tracker: Arc<SharedTracker>,
    pub monitor: monitor::Monitor,
    pub tray_handle: Mutex<Option<tauri::tray::TrayIcon>>,
    /// Handle of the tray "toggle" item, so its label can be updated without
    /// rebuilding the menu (TrayIcon has no menu accessor in Tauri 2).
    pub tray_toggle: Mutex<Option<MenuItem<tauri::Wry>>>,
    quitting: AtomicBool,
}

const SAMPLE_MS: u64 = 1200;
const EVENT_POLL_MS: u64 = 500;
const MONITOR_MS: u64 = 2000;
const SAVE_TICK_MS: u64 = 250;
const STARTUP_DELAY_MS: u64 = 15_000;
const RECHECK_MS: u64 = 6 * 60 * 60_000;

const DEFAULT_WIDTH: f64 = 1360.0;
const DEFAULT_HEIGHT: f64 = 880.0;
const MIN_WIDTH: f64 = 1040.0;
const MIN_HEIGHT: f64 = 680.0;

#[cfg(windows)]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(windows)]
const DWMWCP_ROUND: u32 = 2;
#[cfg(windows)]
const DWMWA_TRANSITIONS_FORCEDISABLED: u32 = 3;

fn is_glass_theme(theme: &Theme) -> bool {
    matches!(theme, Theme::DarkGlass | Theme::WhiteGlass)
}

fn solid_backdrop(theme: &Theme) -> (u8, u8, u8) {
    match theme {
        Theme::SolidDark => (0x0a, 0x0c, 0x10),
        Theme::SolidWhite => (0xf7, 0xf8, 0xfa),
        Theme::Amoled => (0, 0, 0),
        Theme::WhiteGlass => (0xe8, 0xec, 0xf3),
        Theme::DarkGlass => (0x0a, 0x0c, 0x10),
    }
}

/// Window background behind the (partly translucent) UI, plus the Win11
/// backdrop effect for the glass themes.
///
/// Both are applied to the *existing* window on purpose: rebuilding the window
/// to change the transparency class tore down the webview that issued the
/// command, which is what made switching themes kill the app.
fn apply_theme(app: &AppHandle) {
    let theme = app.state::<AppState>().tracker.prefs().theme;
    let Some(win) = app.get_webview_window("main") else { return };
    let (r, g, b) = solid_backdrop(&theme);
    let _ = win.set_background_color(tauri::window::Color(r, g, b, 0xff));
    apply_backdrop_effect(&win, is_glass_theme(&theme));
}

#[cfg(windows)]
fn apply_backdrop_effect(win: &tauri::WebviewWindow, glass: bool) {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    // Mica is the app-window backdrop on Windows 11 and stays smooth while
    // resizing (Acrylic is documented to stutter on drag/resize). It is a
    // no-op on Windows 10, where the theme falls back to the CSS surface.
    let effects = if glass {
        EffectsBuilder::new()
            .effect(Effect::Mica)
            .state(EffectState::Active)
            .build()
    } else {
        EffectsBuilder::new().build()
    };
    let _ = win.set_effects(effects);
}

#[cfg(not(windows))]
fn apply_backdrop_effect(_win: &tauri::WebviewWindow, _glass: bool) {}

#[cfg(windows)]
fn apply_native_window_chrome(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    if let Ok(hwnd) = window.hwnd() {
        let hwnd = hwnd.0 as isize;
        unsafe {
            let round: u32 = DWMWCP_ROUND;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &round as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            // 0 = do NOT force-disable transitions → native min/restore animations.
            let enabled: u32 = 0;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &enabled as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(not(windows))]
fn apply_native_window_chrome(_window: &tauri::WebviewWindow) {}

/// Needs the DWM feature in windows-sys; declared in Cargo.toml features.
#[cfg(windows)]
#[allow(dead_code)]
fn enable_windows10_corner_fallback(_window: &tauri::WebviewWindow) {}

fn create_main_window(app: &AppHandle, theme: Theme) -> tauri::Result<tauri::WebviewWindow> {
    let (r, g, b) = solid_backdrop(&theme);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("1Boost")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .resizable(true)
        // Native Windows title bar (min/max/close + snap layouts).
        .decorations(true)
        .transparent(false)
        .background_color(tauri::window::Color(r, g, b, 0xff))
        .shadow(true)
        .visible(false)
        .center()
        .build()
}

fn push_window_state(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let maximized = win.is_maximized().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        let _ = win.emit(
            "oneboost://window-state",
            serde_json::json!({ "maximized": maximized, "focused": focused }),
        );
    }
}

pub fn show_main(app: &AppHandle, page: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(p) = page {
            let _ = win.emit("oneboost://page-changed", p);
        }
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn update_tray_state(app: &AppHandle, paused: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let tip = if paused {
            "1Boost — tracking paused"
        } else {
            "1Boost — tracking your PC usage"
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    if let Some(toggle) = app.state::<AppState>().tray_toggle.lock().unwrap().as_ref() {
        let label = if paused { "Resume Tracking" } else { "Pause Tracking" };
        let _ = toggle.set_text(label);
    }
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<(tauri::menu::Menu<tauri::Wry>, MenuItem<tauri::Wry>)> {
    let paused = app.state::<AppState>().tracker.prefs().pause_tracking;
    let brand = MenuItem::with_id(app, "brand", "1Boost", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let toggle =
        MenuItem::with_id(app, "toggle", if paused { "Resume Tracking" } else { "Pause Tracking" }, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit 1Boost", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&brand, &open, &toggle, &settings, &exit])?;
    Ok((menu, toggle))
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id("main-tray").is_some() {
        if let Some(t) = app.tray_by_id("main-tray") {
            let _ = t.set_visible(true);
        }
        return Ok(());
    }
    let (menu, toggle) = build_tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("1Boost — tracking your PC usage")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app, Some("dashboard")),
            "toggle" => {
                let st = app.state::<AppState>();
                let paused = st.tracker.prefs().pause_tracking;
                if paused {
                    st.tracker.resume();
                } else {
                    st.tracker.pause();
                }
                let next = st.tracker.prefs().pause_tracking;
                update_tray_state(app, next);
                let _ = app.emit("oneboost://prefs-changed", st.tracker.prefs());
            }
            "settings" => show_main(app, Some("settings")),
            "exit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                app.state::<AppState>().tracker.stop();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle(), None);
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    {
        let st = app.state::<AppState>();
        *st.tray_handle.lock().unwrap() = Some(tray);
        *st.tray_toggle.lock().unwrap() = Some(toggle);
    }
    Ok(())
}

fn hide_tray(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_visible(false);
    }
}

/// Rebuild the window shell when the glass/solid theme class flips
/// (Windows assigns transparency at creation).

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DaySummary {
    date: String,
    active_ms: u64,
    on_ms: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InitialPayload {
    prefs: Prefs,
    dashboard: DashboardData,
    storage: StorageStatus,
    version: String,
    platform: String,
    history_days: Vec<DaySummary>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPayload {
    prefs: Prefs,
    storage: StorageStatus,
    version: String,
    platform: String,
    launch: LaunchState,
    days: Vec<DaySummary>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    ok: bool,
    path: Option<String>,
    canceled: bool,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands (one per preload bridge method — nothing dropped)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_initial(app: AppHandle) -> InitialPayload {
    let st = app.state::<AppState>();
    let tracker = &st.tracker;
    InitialPayload {
        prefs: tracker.prefs(),
        dashboard: tracker.dashboard(),
        storage: tracker.storage_status(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        history_days: tracker
            .history_days(60)
            .into_iter()
            .map(|d| DaySummary { date: d.date, active_ms: d.active_ms, on_ms: d.pc_on_ms })
            .collect(),
    }
}

#[tauri::command]
fn get_dashboard(app: AppHandle) -> DashboardData {
    app.state::<AppState>().tracker.dashboard()
}

#[tauri::command]
fn get_monitor_sample(app: AppHandle) -> Option<MonitorPayload> {
    let st = app.state::<AppState>();
    st.monitor.current()
}

#[tauri::command]
fn get_settings_data(app: AppHandle) -> SettingsPayload {
    let st = app.state::<AppState>();
    let tracker = &st.tracker;
    let prefs = tracker.prefs();
    SettingsPayload {
        prefs: prefs.clone(),
        storage: tracker.storage_status(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        launch: settings::get_launch_at_login_state(&prefs),
        days: tracker
            .history_days(90)
            .into_iter()
            .map(|d| DaySummary { date: d.date, active_ms: d.active_ms, on_ms: d.pc_on_ms })
            .collect(),
    }
}

#[tauri::command]
fn set_pref(app: AppHandle, key: String, value: serde_json::Value) -> Result<Prefs, String> {
    let st = app.state::<AppState>();
    let mut prefs = st.tracker.prefs();
    let old_theme = prefs.theme;
    apply_pref_value(app.clone(), &mut prefs, &key, &value)?;
    prefs = prefs.sanitized();
    st.tracker.set_prefs(prefs.clone());

    if old_theme != prefs.theme {
        // Repaint the existing window. Never rebuild it: destroying the window
        // destroys the webview that is running this very command.
        apply_theme(&app);
    }
    let _ = app.emit("oneboost://prefs-changed", prefs.clone());
    Ok(prefs)
}

fn apply_pref_value(
    app: AppHandle,
    prefs: &mut Prefs,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    match key {
        "theme" => {
            let s = value.as_str().ok_or("theme must be a string")?;
            prefs.theme = match s {
                "white-glass" => Theme::WhiteGlass,
                "solid-dark" => Theme::SolidDark,
                "solid-white" => Theme::SolidWhite,
                "amoled" => Theme::Amoled,
                "dark-glass" => Theme::DarkGlass,
                other => return Err(format!("unknown theme: {other}")),
            };
        }
        "accent" => {
            let s = value.as_str().ok_or("accent must be a string")?;
            prefs.accent = match s {
                "violet" => Accent::Violet,
                "teal" => Accent::Teal,
                "green" => Accent::Green,
                "amber" => Accent::Amber,
                "rose" => Accent::Rose,
                "sky" => Accent::Sky,
                "crimson" => Accent::Crimson,
                "blue" => Accent::Blue,
                other => return Err(format!("unknown accent: {other}")),
            };
        }
        "transparency" => {
            prefs.transparency = value.as_f64().ok_or("transparency must be a number")?;
        }
        "reducedMotion" => prefs.reduced_motion = value.as_bool().ok_or("bool required")?,
        "launchAtLogin" => {
            let enable = value.as_bool().ok_or("bool required")?;
            prefs.launch_at_login = enable;
            settings::set_launch_at_login(enable, prefs.start_minimized);
        }
        "startMinimized" => {
            let enable = value.as_bool().ok_or("bool required")?;
            prefs.start_minimized = enable;
            if prefs.launch_at_login {
                settings::set_launch_at_login(true, enable);
            }
        }
        "pauseTracking" => {
            prefs.pause_tracking = value.as_bool().ok_or("bool required")?;
            let paused = prefs.pause_tracking;
            update_tray_state(&app, paused);
        }
        "idleThresholdMin" => {
            prefs.idle_threshold_min = value.as_i64().ok_or("number required")?;
        }
        "keepHistoryDays" => {
            prefs.keep_history_days = value.as_i64().ok_or("number required")?;
        }
        "showTray" => {
            prefs.show_tray = value.as_bool().ok_or("bool required")?;
            if prefs.show_tray {
                let _ = setup_tray(&app);
            } else {
                hide_tray(&app);
            }
        }
        other => return Err(format!("Unknown setting: {other}")),
    }
    Ok(())
}

#[tauri::command]
fn repair_launch(app: AppHandle) -> LaunchState {
    let st = app.state::<AppState>();
    let prefs = st.tracker.prefs();
    settings::set_launch_at_login(prefs.launch_at_login, prefs.start_minimized);
    settings::get_launch_at_login_state(&prefs)
}

#[tauri::command]
fn get_stats_overview(app: AppHandle) -> StatsOverview {
    app.state::<AppState>().tracker.stats_overview()
}

#[tauri::command]
fn get_trend(app: AppHandle, days: i64) -> TrendData {
    app.state::<AppState>().tracker.trend(days)
}

#[tauri::command]
fn get_weekday_averages(app: AppHandle) -> WeekdayAverages {
    app.state::<AppState>().tracker.weekday_averages()
}

#[tauri::command]
fn get_history_page(app: AppHandle, offset: usize, limit: usize) -> HistoryPage {
    app.state::<AppState>().tracker.history_page(offset, limit)
}

#[tauri::command]
async fn get_app_detail(app: AppHandle, key: String) -> AppDetailData {
    app.state::<AppState>().tracker.app_detail(&key)
}

#[tauri::command]
async fn get_apps_list(app: AppHandle) -> Vec<AppUsageItem> {
    app.state::<AppState>().tracker.apps_list_with_icons()
}

#[tauri::command]
fn clear_data(app: AppHandle) -> Result<bool, String> {
    app.state::<AppState>().tracker.delete_all()?;
    Ok(true)
}

#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let path = storage::user_data_dir();
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn export_json(app: AppHandle) -> ExportResult {
    let st = app.state::<AppState>();
    let storage = st.tracker.storage.lock().unwrap();
    let path = storage::user_data_dir().join(format!("1Boost-usage-export-{}.json", util::day_key(now_ms())));
    match serde_json::to_string_pretty(&storage.data) {
        Ok(payload) => match std::fs::write(&path, payload) {
            Ok(_) => ExportResult {
                ok: true,
                path: Some(path.display().to_string()),
                canceled: false,
                error: None,
            },
            Err(e) => ExportResult { ok: false, path: None, canceled: false, error: Some(e.to_string()) },
        },
        Err(e) => ExportResult { ok: false, path: None, canceled: false, error: Some(e.to_string()) },
    }
}

// Window controls -------------------------------------------------------------

#[tauri::command]
fn minimize_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.minimize();
    }
}

#[tauri::command]
fn toggle_maximize(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_maximized().unwrap_or(false) {
            let _ = win.unmaximize();
        } else {
            let _ = win.maximize();
        }
    }
}

#[tauri::command]
fn close_window(app: AppHandle) {
    // Hide to tray on close; real exit lives in the tray menu.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn is_maximized(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_maximized().unwrap_or(false))
        .unwrap_or(false)
}

#[tauri::command]
fn start_titlebar_drag(app: AppHandle) {
    // WebView2 has no -webkit-app-region; this is the frameless equivalent.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.start_dragging();
    }
}

#[tauri::command]
fn notify_theme_class(app: AppHandle, _glass: bool) {
    apply_theme(&app);
}

// Updates ---------------------------------------------------------------------

#[tauri::command]
async fn get_update_state(app: AppHandle) -> updater::UpdateStatePayload {
    updater::update_state(&app).await
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> updater::UpdateStatePayload {
    updater::check_updates(&app).await
}

#[tauri::command]
async fn install_update(app: AppHandle) -> bool {
    updater::install_update(&app).await
}

// ---------------------------------------------------------------------------

// Monitor subscribe/unsubscribe (renderer pushes are event-based; the run
// loop always samples, matching the v1.1.5+ always-on monitor model).
#[tauri::command]
fn monitor_subscribe(app: AppHandle) {
    if let Some(s) = monitor::sample_once() {
        let _ = app.emit("oneboost://monitor", &s);
    }
}

#[tauri::command]
fn monitor_unsubscribe() {}

#[tauri::command]
fn navigate(app: AppHandle, page: String) {
    let _ = app.emit("oneboost://page-changed", page);
}

#[tauri::command]
fn open_app_detail(app: AppHandle, key: String) {
    let _ = app.emit("oneboost://app-detail", key);
}

static RUN_LOOP_STOP: OnceLock<AtomicBool> = OnceLock::new();

fn run_loop(app: AppHandle) {
    let stop_flag = RUN_LOOP_STOP.get_or_init(|| AtomicBool::new(false));
    let mut last_sample = std::time::Instant::now();
    let mut last_event = std::time::Instant::now();
    let mut last_monitor = std::time::Instant::now();
    let mut last_push = std::time::Instant::now();
    let mut last_save = std::time::Instant::now();
    let mut last_snapshot_push = 0u64;
    let mut last_dashboard_push = 0u64;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }
        let Some(st) = app.try_state::<AppState>() else { return };
        if last_event.elapsed().as_millis() as u64 >= EVENT_POLL_MS {
            last_event = std::time::Instant::now();
            st.tracker.pump_native_events();
        }
        if last_sample.elapsed().as_millis() as u64 >= SAMPLE_MS {
            last_sample = std::time::Instant::now();
            st.tracker.sample_once();
        }
        if last_monitor.elapsed().as_millis() as u64 >= MONITOR_MS {
            last_monitor = std::time::Instant::now();
            if let Some(sample) = monitor::sample_once() {
                st.monitor.set_last(sample.clone());
                let _ = app.emit("oneboost://monitor", &sample);
            }
        }
        if last_push.elapsed().as_millis() as u64 >= 500 {
            last_push = std::time::Instant::now();
            if let Some(win) = app.get_webview_window("main") {
                let now = now_ms();
                if now.saturating_sub(last_snapshot_push) >= 1_000 {
                    last_snapshot_push = now;
                    let _ = win.emit("oneboost://snapshot", st.tracker.snapshot());
                }
                if now.saturating_sub(last_dashboard_push) >= 2_000 {
                    last_dashboard_push = now;
                    let _ = win.emit("oneboost://usage-updated", st.tracker.dashboard());
                }
            }
        }
        if last_save.elapsed().as_millis() as u64 >= SAVE_TICK_MS {
            last_save = std::time::Instant::now();
            st.tracker.flush_saves();
        }
    }
}

pub fn run() {
    let storage = storage::Storage::new();
    let tracker = Arc::new(SharedTracker::new(storage));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app, None);
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_initial,
            get_dashboard,
            get_monitor_sample,
            get_settings_data,
            set_pref,
            repair_launch,
            get_stats_overview,
            get_trend,
            get_weekday_averages,
            get_history_page,
            get_app_detail,
            get_apps_list,
            clear_data,
            open_data_folder,
            export_json,
            monitor_subscribe,
            monitor_unsubscribe,
            navigate,
            open_app_detail,
            minimize_window,
            toggle_maximize,
            close_window,
            is_maximized,
            start_titlebar_drag,
            notify_theme_class,
            get_update_state,
            check_for_updates,
            install_update,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(AppState {
                tracker: tracker.clone(),
                monitor: monitor::Monitor::new(),
                tray_handle: Mutex::new(None),
                tray_toggle: Mutex::new(None),
                quitting: AtomicBool::new(false),
            });

            // Login item: re-assert saved pref (repairs stale Electron paths).
            {
                let st = app.state::<AppState>();
                let prefs = st.tracker.prefs();
                let _ = settings::sync_launch_at_login(&prefs);
            }

            // Window: one shell for every theme (native title bar).
            let theme = app.state::<AppState>().tracker.prefs().theme;
            let win = create_main_window(&handle, theme)?;
            apply_native_window_chrome(&win);
            apply_theme(&handle);

            let h = handle.clone();
            win.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // Hide to tray; exit goes through the tray menu.
                    api.prevent_close();
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                    push_window_state(&h);
                }
                _ => {}
            });

            // Tray (respect showTray pref).
            if app.state::<AppState>().tracker.prefs().show_tray {
                setup_tray(&handle)?;
            }

            // Start the native tracking layer + background run loop.
            if !oneboost_native::api::start() {
                log::warn!("[1boost] native tracking layer failed to start");
            }
            let loop_handle = handle.clone();
            std::thread::spawn(move || run_loop(loop_handle));

            // Updater background checks (packaged builds only, inside module).
            updater::init_background(handle.clone());

            // Show after first paint, unless launched hidden.
            let start_hidden =
                std::env::args().any(|a| a == "--hidden" || a == "--start-minimized");
            if !start_hidden {
                let h2 = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(350));
                    if let Some(w) = h2.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let st = app.state::<AppState>();
                if !st.quitting.load(Ordering::SeqCst) {
                    // Keep running in the tray (window-all-closed behavior).
                }
            }
        });
}
