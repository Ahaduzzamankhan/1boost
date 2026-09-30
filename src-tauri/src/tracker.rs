//! Tracker orchestrator — port of electron/main/tracking.ts. Drives the
//! native layer, applies samples to the usage store, manages sessions and
//! app-switch detection, caches icons, and persists with debounced atomic
//! writes plus critical sync saves on suspend/shutdown/lock.

use crate::aggregator::{
    accumulate_live_session, apply_sample_to_day, build_dashboard, build_live_snapshot,
    close_session, compute_totals, daily_trend, ensure_day, open_session, session_stats,
    top_apps_for_day, top_apps_overall, trim_to_retention, ApplySample, CurrentAppRef,
    DashboardOpts, SessionReason, SnapshotOpts,
};
use crate::apps::{app_display_name, app_key_from_path};
use crate::model::*;
use crate::storage::Storage;
use crate::util::{day_key, now_ms};
use oneboost_native::api as native;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WAKE_BURST_MS: u64 = 10_000;
const MAX_ACCOUNTED_GAP_MS: u64 = 60_000;
const SAVE_DEBOUNCE_MS: u64 = 3_000;
const SAVE_MAX_WAIT_MS: u64 = 60_000;
const SAFETY_SAVE_MS: u64 = 30 * 60_000;

struct CurrentApp {
    key: String,
    name: String,
    start_ms: u64,
    exe_path: String,
}

pub struct SharedTracker {
    pub storage: Mutex<Storage>,
    pub tracker: Mutex<TrackerState>,
    pub snapshot_tick: AtomicU64,
}

pub struct TrackerState {
    prev_sample: Option<native::Sample>,
    last_apply_ms: Option<u64>,
    current: Option<CurrentApp>,
    wake_burst_until: u64,
    icons: BTreeMap<String, Option<String>>,
    identity_cache: BTreeMap<String, (String, String)>,
    dirty: bool,
    last_error: Option<String>,
    stopped: bool,
    dirty_since: Option<Instant>,
    dirty_deadline: Option<Instant>,
    last_safety_save: Instant,
}

impl TrackerState {
    fn new() -> TrackerState {
        TrackerState {
            prev_sample: None,
            last_apply_ms: None,
            current: None,
            wake_burst_until: 0,
            icons: BTreeMap::new(),
            identity_cache: BTreeMap::new(),
            dirty: false,
            last_error: None,
            stopped: false,
            dirty_since: None,
            dirty_deadline: None,
            last_safety_save: Instant::now(),
        }
    }
}

impl SharedTracker {
    pub fn new(mut storage: Storage) -> SharedTracker {
        storage.load();
        SharedTracker {
            storage: Mutex::new(storage),
            tracker: Mutex::new(TrackerState::new()),
            snapshot_tick: AtomicU64::new(0),
        }
    }

    pub fn prefs(&self) -> Prefs {
        self.storage.lock().unwrap().settings.prefs.clone()
    }

    pub fn set_prefs(&self, prefs: Prefs) {
        let mut st = self.storage.lock().unwrap();
        st.settings.prefs = prefs;
        let _ = st.save_settings();
    }

    pub fn pause(&self) {
        let mut st = self.storage.lock().unwrap();
        st.settings.prefs.pause_tracking = true;
        let _ = st.save_settings();
    }

    pub fn resume(&self) {
        let mut st = self.storage.lock().unwrap();
        st.settings.prefs.pause_tracking = false;
        let _ = st.save_settings();
    }

    pub fn refresh_after_data_reset(&self) {
        let mut t = self.tracker.lock().unwrap();
        t.current = None;
        t.prev_sample = None;
        t.last_apply_ms = None;
        self.mark_dirty(&mut t);
    }

    fn mark_dirty(&self, t: &mut TrackerState) {
        t.dirty = true;
        if t.dirty_since.is_none() {
            t.dirty_since = Some(Instant::now());
            t.dirty_deadline = Some(Instant::now() + Duration::from_millis(SAVE_MAX_WAIT_MS));
        }
    }

    // -----------------------------------------------------------------------
    // Sampling (called every SAMPLE_MS by the run loop in lib.rs)
    // -----------------------------------------------------------------------

    pub fn sample_once(&self) {
        let prefs = self.prefs();
        if prefs.pause_tracking {
            let mut t = self.tracker.lock().unwrap();
            t.prev_sample = None;
            t.last_apply_ms = None;
            return;
        }
        let idle_threshold_ms = (prefs.idle_threshold_min * 60_000) as u32;

        let burst;
        let s = {
            let mut t = self.tracker.lock().unwrap();
            burst = now_ms() < t.wake_burst_until;
            match native::collect_once(idle_threshold_ms) {
                Some(s) => {
                    if !burst {
                        t.last_error = None;
                    }
                    Some(s)
                }
                None => {
                    t.last_error = Some("Tracking sample failed.".into());
                    None
                }
            }
        };
        let Some(s) = s else { return };
        if !s.ok {
            let mut t = self.tracker.lock().unwrap();
            t.last_error = Some("Tracking sample unavailable.".into());
            return;
        }

        let now = if s.now_epoch_ms > 0 { s.now_epoch_ms } else { now_ms() };
        let key = day_key(now);

        let mut storage = self.storage.lock().unwrap();
        let mut t = self.tracker.lock().unwrap();
        if t.stopped {
            return;
        }

        let prev_day_same = storage.data.days.contains_key(&key);
        ensure_day(&mut storage.data, &key, now);
        if !prev_day_same {
            let keep = storage.settings.prefs.keep_history_days;
            trim_to_retention(&mut storage.data, keep, now_ms());
        }

        // Gap guard: never count long unaccounted gaps as usage.
        let gap = t.last_apply_ms.map(|l| now.saturating_sub(l)).unwrap_or(0);
        let account_delta = if gap > 0 && gap <= MAX_ACCOUNTED_GAP_MS { gap } else { 0 };
        if gap > MAX_ACCOUNTED_GAP_MS {
            if close_session(&mut storage.data, now, SessionReason::Sleep).is_some() {
                t.dirty = true;
            }
            open_session(&mut storage.data, now);
        } else if storage.data.pending_session.is_none() && account_delta > 0 {
            open_session(&mut storage.data, now.saturating_sub(account_delta));
        }

        // App-switch detection.
        if s.foreground_ok && !s.process_path.is_empty() {
            let (ikey, iname) = identity_for(&mut t, &mut storage.data, &s.process_path);
            let switched = t.current.as_ref().map(|c| c.key != ikey).unwrap_or(true);
            if switched {
                t.current = Some(CurrentApp {
                    key: ikey,
                    name: iname,
                    start_ms: now,
                    exe_path: s.process_path.clone(),
                });
                t.dirty = true;
            }
        } else if !s.foreground_ok {
            t.current = None;
        }

        if account_delta > 0 && t.last_apply_ms.is_some() {
            let cur = t.current.take();
            if let Some(day) = storage.data.days.get_mut(&key) {
                apply_sample_to_day(ApplySample { sample: &s, delta_ms: account_delta, day });
            }
            accumulate_live_session(&mut storage.data, account_delta, s.input_active, now.saturating_sub(account_delta));
            // Per-app usage only while actively present.
            if s.input_active {
                if let Some(c) = cur.as_ref() {
                    if let Some(day) = storage.data.days.get_mut(&key) {
                        *day.apps.entry(c.key.clone()).or_insert(0) += account_delta;
                    }
                }
            }
            t.current = cur;
            self.mark_dirty(&mut t);
        }

        t.prev_sample = Some(s.clone());
        t.last_apply_ms = Some(now);
        if s.foreground_ok {
            if let Some(c) = t.current.as_ref() {
                let k = c.key.clone();
                let exe = c.exe_path.clone();
                drop(t);
                drop(storage);
                self.ensure_icon(&k, &exe);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Native events (polled every EVENT_POLL_MS; also fed by Tauri hooks)
    // -----------------------------------------------------------------------

    pub fn pump_native_events(&self) {
        let events = native::pump_events();
        for ev in events {
            self.handle_event(&ev.kind);
        }
    }

    /// Mirror of native events (Tauri-side suspend/resume/lock hooks).
    pub fn on_power_event(&self, kind: &str) {
        self.handle_event(kind);
    }

    fn handle_event(&self, kind: &str) {
        let now = now_ms();
        let mut storage = self.storage.lock().unwrap();
        let mut t = self.tracker.lock().unwrap();
        if t.stopped {
            return;
        }
        match kind {
            "sleep" | "shutdown" => {
                if close_session(
                    &mut storage.data,
                    now,
                    if kind == "sleep" { SessionReason::Sleep } else { SessionReason::Shutdown },
                )
                .is_some()
                {
                    t.dirty = true;
                }
                t.prev_sample = None;
                t.last_apply_ms = None;
                drop(t);
                drop(storage);
                // Windows may suspend or kill the process right after these
                // events: persist synchronously.
                self.critical_save();
            }
            "resume" => {
                t.wake_burst_until = now + WAKE_BURST_MS;
                open_session(&mut storage.data, now);
                t.last_apply_ms = None;
                t.prev_sample = None;
            }
            "lock" => {
                if close_session(&mut storage.data, now, SessionReason::Lock).is_some() {
                    t.dirty = true;
                }
                drop(t);
                drop(storage);
                self.critical_save();
            }
            "unlock" => {
                open_session(&mut storage.data, now);
                t.last_apply_ms = None;
                t.prev_sample = None;
            }
            "monitor-on" | "monitor-off" => {
                t.prev_sample = None;
                t.last_apply_ms = None;
            }
            _ => {}
        }
    }

    // -----------------------------------------------------------------------
    // Snapshot / dashboard payloads
    // -----------------------------------------------------------------------

    fn battery_state(t: &TrackerState) -> BatteryState {
        match &t.prev_sample {
            Some(s) => BatteryState {
                charging: s.ac_online,
                pct: s.battery_pct,
                no_battery: (s.battery_flag & 128) != 0,
            },
            None => BatteryState { charging: false, pct: 100, no_battery: true },
        }
    }

    fn battery_remaining_min(t: &TrackerState) -> Option<i32> {
        t.prev_sample.as_ref().and_then(|s| {
            if s.battery_remaining_min < 0 {
                None
            } else {
                Some(s.battery_remaining_min)
            }
        })
    }

    fn current_ref(t: &TrackerState) -> Option<CurrentAppRef> {
        t.current.as_ref().map(|c| CurrentAppRef {
            key: c.key.clone(),
            name: c.name.clone(),
            start_ms: c.start_ms,
        })
    }

    pub fn snapshot(&self) -> LiveSnapshot {
        let now = now_ms();
        let storage = self.storage.lock().unwrap();
        let t = self.tracker.lock().unwrap();
        let key = day_key(now);
        let today = storage
            .data
            .days
            .get(&key)
            .cloned()
            .unwrap_or_else(|| DayData::empty(key.clone(), now));
        build_live_snapshot(&storage.data, &today, SnapshotOpts {
            now_ms: now,
            paused: storage.settings.prefs.pause_tracking,
            current_app: Self::current_ref(&t),
            battery: Self::battery_state(&t),
            battery_remaining_min: Self::battery_remaining_min(&t),
            last_error: t.last_error.clone(),
        })
    }

    pub fn dashboard(&self) -> DashboardData {
        let now = now_ms();
        let storage = self.storage.lock().unwrap();
        let t = self.tracker.lock().unwrap();
        build_dashboard(&storage.data, DashboardOpts {
            now_ms: now,
            paused: storage.settings.prefs.pause_tracking,
            current_app: Self::current_ref(&t),
            battery: Self::battery_state(&t),
            battery_remaining_min: Self::battery_remaining_min(&t),
            last_error: t.last_error.clone(),
            app_names: storage.data.app_names.clone(),
            icons: t.icons.clone(),
            days: storage.settings.prefs.keep_history_days.clamp(14, 90),
        })
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    /// Flush the debounced save when due; called from the run loop.
    pub fn flush_saves(&self) {
        let due = {
            let t = self.tracker.lock().unwrap();
            match (t.dirty_since, t.dirty_deadline) {
                (Some(since), _) => since.elapsed() >= Duration::from_millis(SAVE_DEBOUNCE_MS),
                (None, Some(deadline)) => Instant::now() >= deadline,
                _ => false,
            }
        };
        if due {
            self.save_now();
        }
        // Periodic safety save bounds crash loss (mirrors SAFETY_SAVE_MS).
        let safety_due = {
            let t = self.tracker.lock().unwrap();
            t.dirty && t.last_safety_save.elapsed() >= Duration::from_millis(SAFETY_SAVE_MS)
        };
        if safety_due {
            let mut t = self.tracker.lock().unwrap();
            t.last_safety_save = Instant::now();
            drop(t);
            self.critical_save();
        }
    }

    pub fn save_now(&self) {
        // Lock order is ALWAYS storage → tracker (see sample_once) to make
        // every two-lock path deadlock-free.
        let mut storage = self.storage.lock().unwrap();
        let mut t = self.tracker.lock().unwrap();
        if !t.dirty {
            t.dirty_since = None;
            t.dirty_deadline = None;
            return;
        }
        t.dirty = false;
        t.dirty_since = None;
        t.dirty_deadline = None;
        if let Err(e) = storage.save_data() {
            t.last_error = Some(format!("Failed to write usage data: {e}"));
            t.dirty = true;
            t.dirty_since = Some(Instant::now());
        }
    }

    /// Synchronous save for suspend/shutdown/lock flushes.
    pub fn critical_save(&self) {
        let mut storage = self.storage.lock().unwrap();
        let mut t = self.tracker.lock().unwrap();
        t.dirty = false;
        t.dirty_since = None;
        t.dirty_deadline = None;
        if let Err(e) = storage.save_data_sync() {
            t.last_error = Some(format!("Failed to write usage data: {e}"));
            t.dirty = true;
        }
    }

    fn finalize_before_exit(&self) {
        let now = now_ms();
        {
            let mut storage = self.storage.lock().unwrap();
            let mut t = self.tracker.lock().unwrap();
            if close_session(&mut storage.data, now, SessionReason::Quit).is_some() {
                t.dirty = true;
            }
            storage.data.updated_at = now;
        }
        self.critical_save();
    }

    /// Runs after stop(); safe no-op when already stopped.

    pub fn stop(&self) {
        {
            let mut t = self.tracker.lock().unwrap();
            t.stopped = true;
        }
        self.finalize_before_exit();
        native::shutdown();
    }

    // -----------------------------------------------------------------------
    // Icons
    // -----------------------------------------------------------------------

    fn ensure_icon(&self, key: &str, exe_path: &str) {
        let cached = self.tracker.lock().unwrap().icons.contains_key(key);
        if cached {
            return;
        }
        let url = crate::icons::extract_icon_png_data_url(exe_path);
        let mut t = self.tracker.lock().unwrap();
        t.icons.insert(key.to_string(), url);
    }

    /// Icon for an app key, extracting it on demand for apps first seen in an
    /// earlier session (their path came back with the persisted data).
    /// Returns `None` when the app has no recorded path or extraction failed.
    fn resolve_icon(&self, key: &str) -> Option<String> {
        if let Some(hit) = self.tracker.lock().unwrap().icons.get(key) {
            return hit.clone();
        }
        let exe_path = {
            let storage = self.storage.lock().unwrap();
            storage.data.app_paths.get(key).cloned()
        }?;
        let url = crate::icons::extract_icon_png_data_url(&exe_path);
        let mut t = self.tracker.lock().unwrap();
        t.icons.insert(key.to_string(), url.clone());
        url
    }

    // -----------------------------------------------------------------------
    // Queries for the renderer pages
    // -----------------------------------------------------------------------

    pub fn stats_overview(&self) -> StatsOverview {
        let storage = self.storage.lock().unwrap();
        let totals = compute_totals(&storage.data);
        let days = totals.days.max(1);
        let stats = session_stats(&storage.data);
        let overall = top_apps_overall(&storage.data, 1).into_iter().next();
        StatsOverview {
            active_days: totals.days,
            avg_day_active_ms: totals.active_ms as f64 / days as f64,
            avg_day_on_ms: totals.pc_on_ms as f64 / days as f64,
            avg_session_ms: stats.avg_session_ms,
            longest_session: stats.longest_session,
            top_app: overall.map(|a| AppAgg {
                key: a.key.clone(),
                name: storage
                    .data
                    .app_names
                    .get(&a.key)
                    .cloned()
                    .unwrap_or_else(|| app_display_name(&a.key)),
                ms: a.ms,
            }),
            totals: totals.clone(),
        }
    }

    pub fn trend(&self, days: i64) -> TrendData {
        let n = days.clamp(7, 365);
        let storage = self.storage.lock().unwrap();
        let points = daily_trend(&storage.data, n, now_ms());
        let with_data: Vec<_> = points.iter().filter(|p| p.active_ms > 0).collect();
        let avg = if with_data.is_empty() {
            0
        } else {
            with_data.iter().map(|p| p.active_ms).sum::<u64>() / with_data.len() as u64
        };
        TrendData { points, avg_baseline_ms: avg }
    }

    pub fn weekday_averages(&self) -> WeekdayAverages {
        let storage = self.storage.lock().unwrap();
        crate::aggregator::weekday_averages(&storage.data)
    }

    pub fn history_page(&self, offset: usize, limit: usize) -> HistoryPage {
        let storage = self.storage.lock().unwrap();
        let keys: Vec<String> = storage.data.days.keys().rev().cloned().collect();
        let mut items = Vec::new();
        for k in keys.iter().skip(offset).take(limit) {
            if let Some(day) = storage.data.days.get(k) {
                let top_apps = top_apps_for_day(Some(day), 6)
                    .into_iter()
                    .map(|a| AppAgg {
                        name: storage
                            .data
                            .app_names
                            .get(&a.key)
                            .cloned()
                            .unwrap_or_else(|| app_display_name(&a.key)),
                        ..a
                    })
                    .collect();
                items.push(DayDetail { day: day.clone(), top_apps });
            }
        }
        HistoryPage { has_more: offset + limit < keys.len(), items }
    }

    pub fn app_detail(&self, key: &str) -> AppDetailData {
        // Icon resolution takes the storage lock itself, so this one must be
        // released first (std::sync::Mutex is not reentrant).
        let icon_data_url = self.resolve_icon(key);
        let storage = self.storage.lock().unwrap();
        let name = storage
            .data
            .app_names
            .get(key)
            .cloned()
            .unwrap_or_else(|| app_display_name(key));
        let (total_ms, active_share, last_used_ms, per_day) =
            crate::aggregator::app_detail(&storage.data, key, &name);
        AppDetailData {
            identity: Identity { key: key.to_string(), name },
            total_ms,
            active_share,
            last_used_ms,
            per_day,
            icon_data_url,
        }
    }

    pub fn apps_list(&self) -> Vec<AppUsageItem> {
        let storage = self.storage.lock().unwrap();
        let overall = top_apps_overall(&storage.data, 0);
        let mut last_used: BTreeMap<String, u64> = BTreeMap::new();
        for day in storage.data.days.values() {
            for app_key in day.apps.keys() {
                let e = last_used.entry(app_key.clone()).or_insert(0);
                if day.last_ms > *e {
                    *e = day.last_ms;
                }
            }
        }
        let t = self.tracker.lock().unwrap();
        overall
            .into_iter()
            .map(|a| AppUsageItem {
                key: a.key.clone(),
                name: storage
                    .data
                    .app_names
                    .get(&a.key)
                    .cloned()
                    .unwrap_or_else(|| app_display_name(&a.key)),
                ms: a.ms,
                icon_data_url: t.icons.get(&a.key).cloned().flatten(),
                last_used_ms: last_used.get(&a.key).copied(),
            })
            .collect()
    }

    /// `get_apps_list` payload with icons resolved lazily.
    pub fn apps_list_with_icons(&self) -> Vec<AppUsageItem> {
        let mut items = self.apps_list();
        for item in &items {
            if item.icon_data_url.is_none() {
                item.icon_data_url = self.resolve_icon(&item.key);
            }
        }
        items
    }

    /// Newest-first day summaries for get-initial (same shape as the TS port).
    pub fn history_days(&self, limit: usize) -> Vec<HistoryDay> {
        let storage = self.storage.lock().unwrap();
        storage
            .data
            .days
            .iter()
            .rev()
            .take(limit)
            .map(|(k, day)| HistoryDay {
                date: k.clone(),
                pc_on_ms: day.pc_on_ms,
                active_ms: day.active_ms,
                idle_ms: day.idle_ms,
                screen_on_ms: day.screen_on_ms,
                first_ms: day.first_ms,
                last_ms: day.last_ms,
                battery_ms: day.battery_ms,
                ac_ms: day.ac_ms,
                focus_ms: day.focus_ms,
                top_apps: top_apps_for_day(Some(day), 5)
                    .into_iter()
                    .map(|a| AppAgg {
                        name: storage
                            .data
                            .app_names
                            .get(&a.key)
                            .cloned()
                            .unwrap_or_else(|| app_display_name(&a.key)),
                        ..a
                    })
                    .collect(),
            })
            .collect()
    }

    pub fn delete_all(&self) -> Result<(), String> {
        {
            let mut storage = self.storage.lock().unwrap();
            storage.delete_all().map_err(|e| format!("delete failed: {e}"))?;
        }
        self.refresh_after_data_reset();
        Ok(())
    }

    pub fn storage_status(&self) -> StorageStatus {
        self.storage.lock().unwrap().status()
    }

    pub fn last_error(&self) -> Option<String> {
        self.tracker.lock().unwrap().last_error.clone()
    }
}

fn identity_for(t: &mut TrackerState, data: &mut UsageData, exe_path: &str) -> (String, String) {
    if let Some(cached) = t.identity_cache.get(exe_path) {
        return cached.clone();
    }
    let key = app_key_from_path(exe_path);
    let name = app_display_name(exe_path);
    t.identity_cache.insert(exe_path.to_string(), (key.clone(), name.clone()));
    if data.app_names.get(&key).map(|n| n.as_str()) != Some(name.as_str()) {
        data.app_names.insert(key.clone(), name.clone());
        t.dirty = true;
    }
    // Remember where the app lives so its icon can be restored after a
    // restart instead of falling back to the generic glyph forever.
    if crate::icons::is_icon_candidate(exe_path)
        && data.app_paths.get(&key).map(|p| p.as_str()) != Some(exe_path)
    {
        data.app_paths.insert(key.clone(), exe_path.to_string());
        t.dirty = true;
    }
    (key, name)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDay {
    pub date: String,
    pub pc_on_ms: u64,
    pub active_ms: u64,
    pub idle_ms: u64,
    pub screen_on_ms: u64,
    pub first_ms: u64,
    pub last_ms: u64,
    pub battery_ms: u64,
    pub ac_ms: u64,
    pub focus_ms: u64,
    pub top_apps: Vec<AppAgg>,
}
