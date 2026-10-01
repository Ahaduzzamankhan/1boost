//! Usage aggregation — a faithful port of electron/main/aggregator.ts.
//! Semantics are kept 1:1 (day buckets, totals, sessions, retention,
//! trend/history assembly); pure logic, no I/O.

use crate::model::*;
use crate::util::{day_key, parse_day_key, shift_day_key, weekday_of_key};
use std::collections::BTreeMap;

pub fn ensure_day<'a>(data: &'a mut UsageData, key: &'a str, now_ms: u64) -> &'a mut DayData {
    data.days
        .entry(key.to_string())
        .or_insert_with(|| DayData::empty(key.to_string(), now_ms))
}

pub fn compute_totals(data: &UsageData) -> Totals {
    let mut t = Totals::default();
    for d in data.days.values() {
        t.pc_on_ms += d.pc_on_ms;
        t.active_ms += d.active_ms;
        t.idle_ms += d.idle_ms;
        if d.pc_on_ms > 0 || d.active_ms > 0 || !d.apps.is_empty() {
            t.days += 1;
        }
    }
    t
}

pub fn rebuild_totals(data: &mut UsageData) {
    data.totals = compute_totals(data);
}

pub fn top_apps_for_day(day: Option<&DayData>, limit: usize) -> Vec<AppAgg> {
    let Some(day) = day else { return Vec::new() };
    let mut out: Vec<AppAgg> = day
        .apps
        .iter()
        .filter(|(_, &ms)| ms > 0)
        .map(|(k, &ms)| AppAgg { key: k.clone(), name: k.clone(), ms })
        .collect();
    out.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.key.cmp(&b.key)));
    if limit > 0 {
        out.truncate(limit);
    }
    out
}

pub fn top_apps_overall(data: &UsageData, limit: usize) -> Vec<AppAgg> {
    let mut acc: BTreeMap<String, u64> = BTreeMap::new();
    let mut last: BTreeMap<String, u64> = BTreeMap::new();
    for day in data.days.values() {
        for (key, &ms) in &day.apps {
            if ms == 0 {
                continue;
            }
            *acc.entry(key.clone()).or_insert(0) += ms;
            let e = last.entry(key.clone()).or_insert(0);
            if day.last_ms > *e {
                *e = day.last_ms;
            }
        }
    }
    let mut out: Vec<AppAgg> = acc
        .into_iter()
        .map(|(key, ms)| AppAgg { name: key.clone(), key, ms })
        .collect();
    out.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| a.key.cmp(&b.key)));
    if limit > 0 {
        out.truncate(limit);
    }
    out
}

/// Daily active/on trend for the last N days (zero-filled, oldest first).
pub fn daily_trend(data: &UsageData, days: i64, now_ms: u64) -> Vec<TrendPoint> {
    let base_key = day_key(now_ms);
    let mut out = Vec::new();
    for i in (0..days).rev() {
        let key = shift_day_key(&base_key, -i).unwrap_or_else(|| base_key.clone());
        let (on, active) = data
            .days
            .get(&key)
            .map(|d| (d.pc_on_ms, d.active_ms))
            .unwrap_or((0, 0));
        out.push(TrendPoint { date: key, active_ms: active, on_ms: on });
    }
    out
}

/// Per-hour histogram of today's PC-on time.
///
/// The buckets are recorded as samples arrive, so this is real data rather
/// than a shape guessed from the day's first and last sample. Days recorded
/// before 1.3.1 have no buckets at all; those fall back to spreading the day
/// evenly across the hours it spanned, which is the best that can be said
/// about them and is what the dashboard drew before.
pub fn hour_histogram(day: Option<&DayData>) -> Vec<f64> {
    let Some(day) = day else { return vec![0.0; 24] };
    if day.pc_on_ms == 0 {
        return vec![0.0; 24];
    }
    if day.hours.iter().any(|ms| *ms > 0) {
        return day.hours.iter().map(|ms| *ms as f64).collect();
    }
    legacy_spread(day)
}

/// Same, for time the user was actually active.
pub fn active_hour_histogram(day: Option<&DayData>) -> Vec<f64> {
    let Some(day) = day else { return vec![0.0; 24] };
    if day.active_ms == 0 {
        return vec![0.0; 24];
    }
    if day.active_hours.iter().any(|ms| *ms > 0) {
        return day.active_hours.iter().map(|ms| *ms as f64).collect();
    }
    // A legacy day: scale the PC-on estimate by the active share so the two
    // series stay in proportion.
    let on = hour_histogram(Some(day));
    let share = (day.active_ms as f64 / day.pc_on_ms as f64).clamp(0.0, 1.0);
    on.iter().map(|v| v * share).collect()
}

/// Days recorded before per-hour tracking existed: spread the observed PC-on
/// time evenly across every hour the day spanned.
fn legacy_spread(day: &DayData) -> Vec<f64> {
    let mut out = vec![0.0f64; 24];
    if day.last_ms <= day.first_ms {
        return out;
    }
    let span = (day.last_ms - day.first_ms) as f64;
    if span <= 0.0 {
        return out;
    }
    let clamped = (day.pc_on_ms as f64).min(span);
    let per_hour = clamped / span;
    let start_h = hour_of(day.first_ms);
    let end_h = hour_of(day.last_ms);
    // `last_ms` can round into the next local hour (and a stale clock can put
    // it past midnight), so walk forward rather than trusting `start <= end`.
    let mut h = start_h;
    loop {
        out[(h % 24) as usize] += per_hour;
        if h == end_h {
            break;
        }
        h += 1;
        if h > start_h + 48 {
            break; // pathological clock; stop rather than spin
        }
    }
    out
}

/// Local hour (0-23) of an epoch-ms timestamp, using the same offset the day
/// key uses so an hour can never land in a different day than its day key.
pub fn hour_of(ms: u64) -> u64 {
    let secs = (ms / 1000) as i64 + crate::util::local_offset_secs();
    (secs.rem_euclid(86_400) / 3600) as u64
}

pub fn close_session(
    data: &mut UsageData,
    now_ms: u64,
    reason: SessionReason,
) -> Option<Session> {
    let s = data.pending_session.take()?;
    if s.start_ms >= now_ms {
        return None;
    }
    let session = Session {
        id: format!("s-{}", s.start_ms),
        start_ms: s.start_ms,
        end_ms: now_ms,
        active_ms: s.active_ms,
        on_ms: s.on_ms,
        idle_ms: s.idle_ms,
        sleep: reason == SessionReason::Sleep,
    };
    data.sessions.push(session.clone());
    Some(session)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionReason {
    Sleep,
    Lock,
    Shutdown,
    Quit,
    Manual,
}

pub fn open_session(data: &mut UsageData, now_ms: u64) {
    if data.pending_session.is_none() {
        data.pending_session = Some(PendingSession {
            start_ms: now_ms,
            active_ms: 0,
            on_ms: 0,
            idle_ms: 0,
        });
    }
}

pub struct SessionStats {
    pub avg_session_ms: f64,
    pub longest_session: Option<Session>,
}

pub fn session_stats(data: &UsageData) -> SessionStats {
    if data.sessions.is_empty() {
        return SessionStats { avg_session_ms: 0.0, longest_session: None };
    }
    let mut total: u64 = 0;
    let mut longest: Option<&Session> = None;
    for s in &data.sessions {
        total += s.on_ms;
        if longest.is_none() || s.on_ms > longest.unwrap().on_ms {
            longest = Some(s);
        }
    }
    SessionStats {
        avg_session_ms: total as f64 / data.sessions.len() as f64,
        longest_session: longest.cloned(),
    }
}

pub fn trim_to_retention(data: &mut UsageData, keep_days: i64, now_ms: u64) {
    if keep_days <= 0 {
        return; // unlimited
    }
    let base = parse_day_key(&day_key(now_ms)).unwrap_or(0);
    let cutoff = base - (keep_days - 1) * 86_400;
    let stale: Vec<String> = data
        .days
        .keys()
        .filter(|k| parse_day_key(k).unwrap_or(i64::MAX) < cutoff)
        .cloned()
        .collect();
    for k in stale {
        data.days.remove(&k);
    }
    data.sessions.retain(|s| (s.end_ms as i64) >= cutoff);
}

pub fn build_live_snapshot(
    data: &UsageData,
    today: &DayData,
    opts: SnapshotOpts,
) -> LiveSnapshot {
    LiveSnapshot {
        version: 1,
        now_ms: opts.now_ms,
        started_at: data.created_at,
        day: today.date.clone(),
        pc_on_ms: today.pc_on_ms,
        active_ms: today.active_ms,
        idle_ms: today.idle_ms,
        screen_on_ms: today.screen_on_ms,
        paused: opts.paused,
        app_key: opts.current_app.as_ref().map(|a| a.key.clone()).unwrap_or_default(),
        app_name: opts.current_app.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        app_start_ms: opts.current_app.as_ref().map(|a| a.start_ms).unwrap_or(0),
        app_elapsed_ms: opts
            .current_app
            .as_ref()
            .map(|a| opts.now_ms.saturating_sub(a.start_ms))
            .unwrap_or(0),
        battery: opts.battery,
        battery_remaining_min: opts.battery_remaining_min,
        last_error: opts.last_error,
    }
}

pub struct SnapshotOpts {
    pub now_ms: u64,
    pub paused: bool,
    pub current_app: Option<CurrentAppRef>,
    pub battery: BatteryState,
    pub battery_remaining_min: Option<i32>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct CurrentAppRef {
    pub key: String,
    pub name: String,
    pub start_ms: u64,
}

pub fn build_dashboard(
    data: &UsageData,
    opts: DashboardOpts,
) -> DashboardData {
    let key = day_key(opts.now_ms);
    let today = data.days.get(&key).cloned().unwrap_or_else(|| DayData::empty(key.clone(), opts.now_ms));

    // Per-app last-used across all history.
    let mut last_used: BTreeMap<String, u64> = BTreeMap::new();
    for day in data.days.values() {
        for app_key in day.apps.keys() {
            let e = last_used.entry(app_key.clone()).or_insert(0);
            if day.last_ms > *e {
                *e = day.last_ms;
            }
        }
    }

    let apps: Vec<AppUsageItem> = top_apps_for_day(Some(&today), 0)
        .into_iter()
        .take(6)
        .map(|a| {
            let name = opts.app_names.get(&a.key).cloned().unwrap_or_else(|| a.key.clone());
            AppUsageItem {
                key: a.key.clone(),
                name,
                ms: a.ms,
                icon_data_url: opts.icons.get(&a.key).cloned().flatten(),
                last_used_ms: last_used.get(&a.key).copied(),
            }
        })
        .collect();

    DashboardData {
        hourly: hour_histogram(Some(&today)),
        hourly_active: active_hour_histogram(Some(&today)),
        today,
        apps,
        snapshot: build_live_snapshot(
            data,
            data.days.get(&day_key(opts.now_ms)).unwrap_or(&DayData::empty(day_key(opts.now_ms), opts.now_ms)),
            SnapshotOpts {
                now_ms: opts.now_ms,
                paused: opts.paused,
                current_app: opts.current_app,
                battery: opts.battery,
                battery_remaining_min: opts.battery_remaining_min,
                last_error: opts.last_error,
            },
        ),
        totals: compute_totals(data),
        daily: daily_trend(data, opts.days, opts.now_ms),
    }
}

pub struct DashboardOpts {
    pub now_ms: u64,
    pub paused: bool,
    pub current_app: Option<CurrentAppRef>,
    pub battery: BatteryState,
    pub battery_remaining_min: Option<i32>,
    pub last_error: Option<String>,
    pub app_names: BTreeMap<String, String>,
    pub icons: BTreeMap<String, Option<String>>,
    pub days: i64,
}

pub fn app_detail(data: &UsageData, key: &str, _name: &str) -> (u64, f64, Option<u64>, Vec<PerDayUse>) {
    let mut total_ms: u64 = 0;
    let mut per_day = Vec::new();
    let mut last_used_ms: Option<u64> = None;
    let mut active_ms: u64 = 0;
    for (k, day) in &data.days {
        let ms = day.apps.get(key).copied().unwrap_or(0);
        if ms > 0 {
            total_ms += ms;
            per_day.push(PerDayUse { date: k.clone(), ms });
            if day.last_ms > last_used_ms.unwrap_or(0) {
                last_used_ms = Some(day.last_ms);
            }
        }
        active_ms += day.active_ms;
    }
    (total_ms, if active_ms > 0 { total_ms as f64 / active_ms as f64 } else { 0.0 }, last_used_ms, per_day)
}

/// Delta accumulation for one sample (mirrors applySampleToDay).
pub struct ApplySample<'a> {
    pub sample: &'a oneboost_native::api::Sample,
    pub delta_ms: u64,
    pub day: &'a mut DayData,
    /// Fallback timestamp for bucketing when the sample carries none.
    pub now_ms: u64,
}

pub fn apply_sample_to_day(o: ApplySample) {
    if o.delta_ms == 0 {
        return;
    }
    let s = o.sample;
    let day = o.day;
    day.pc_on_ms += o.delta_ms;
    if s.input_active {
        day.active_ms += o.delta_ms;
    } else {
        day.idle_ms += o.delta_ms;
    }
    // Per-hour buckets, so "today" on the dashboard is the day as it actually
    // happened rather than a flat block spread over the observed window. The
    // bucket is chosen from the sample's own timestamp so it lines up with the
    // day key the sample was filed under.
    let hour = hour_of(if s.now_epoch_ms > 0 { s.now_epoch_ms } else { o.now_ms }) as usize;
    if let Some(bucket) = day.hours.get_mut(hour) {
        *bucket += o.delta_ms;
    }
    if s.input_active {
        if let Some(bucket) = day.active_hours.get_mut(hour) {
            *bucket += o.delta_ms;
        }
    }
    if s.screen_on {
        day.screen_on_ms += o.delta_ms;
    }
    if s.ac_online {
        day.ac_ms += o.delta_ms;
    } else if s.battery_flag & 128 == 0 {
        day.battery_ms += o.delta_ms;
    }
    if s.input_active && s.is_fullscreen {
        day.focus_ms += o.delta_ms;
    }
    if s.now_epoch_ms < day.first_ms {
        day.first_ms = s.now_epoch_ms;
    }
    if s.now_epoch_ms > day.last_ms {
        day.last_ms = s.now_epoch_ms;
    }
}
pub fn accumulate_live_session(data: &mut UsageData, delta_ms: u64, active: bool, now_ms: u64) {
    if delta_ms == 0 {
        return;
    }
    if data.pending_session.is_none() {
        open_session(data, now_ms);
    }
    if let Some(p) = data.pending_session.as_mut() {
        p.on_ms += delta_ms;
        if active {
            p.active_ms += delta_ms;
        } else {
            p.idle_ms += delta_ms;
        }
    }
}

pub fn weekday_averages(data: &UsageData) -> WeekdayAverages {
    let mut buckets: BTreeMap<u32, (u64, u64)> = BTreeMap::new(); // wd -> (ms, days)
    for (k, day) in &data.days {
        if day.pc_on_ms == 0 && day.apps.is_empty() {
            continue;
        }
        let wd = weekday_of_key(k);
        let e = buckets.entry(wd).or_insert((0, 0));
        e.0 += day.active_ms;
        e.1 += 1;
    }
    WeekdayAverages {
        buckets: buckets
            .into_iter()
            .map(|(weekday, (ms, days))| WeekdayBucket {
                weekday,
                active_ms: if days > 0 { ms / days } else { 0 },
                days,
            })
            .collect(),
    }
}

/// App-detail per-day series helper used by commands (kept here so command
/// code stays thin).
pub fn per_day_uses(data: &UsageData, key: &str) -> Vec<PerDayUse> {
    data.days
        .iter()
        .filter_map(|(k, d)| {
            let ms = d.apps.get(key).copied().unwrap_or(0);
            if ms > 0 {
                Some(PerDayUse { date: k.clone(), ms })
            } else {
                None
            }
        })
        .collect()
}

// (day_key_from_ymd lives in util; no re-export needed)

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a day from a list of (local hour, ms) buckets.
    fn day_with_buckets(date: &str, buckets: &[(usize, u64, u64)]) -> DayData {
        let mut day = DayData::empty(date.to_string(), 0);
        for (hour, on, active) in buckets {
            day.hours[*hour] = *on;
            day.active_hours[*hour] = *active;
            day.pc_on_ms += on;
            day.active_ms += active;
        }
        day.idle_ms = day.pc_on_ms.saturating_sub(day.active_ms);
        day
    }

    #[test]
    fn the_today_histogram_uses_recorded_buckets() {
        // The bug this fixes: a real day with a quiet morning and a busy
        // afternoon drew as one flat block across every hour it touched.
        let day = day_with_buckets(
            "2026-09-30",
            &[(9, 600_000, 600_000), (10, 1_800_000, 900_000), (11, 3_600_000, 1_800_000)],
        );
        let hist = hour_histogram(Some(&day));
        assert_eq!(hist.len(), 24);
        assert_eq!(hist[9], 600_000.0);
        assert_eq!(hist[10], 1_800_000.0);
        assert_eq!(hist[11], 3_600_000.0);
        assert_eq!(hist[8], 0.0);
        assert_eq!(hist[12], 0.0);
        // Not flat any more: this is the shape the day actually had.
        assert!(hist[11] > hist[10] && hist[10] > hist[9]);
    }

    #[test]
    fn the_active_histogram_tracks_active_time_only() {
        let day = day_with_buckets("2026-09-30", &[(9, 600_000, 0), (10, 600_000, 300_000)]);
        let on = hour_histogram(Some(&day));
        let active = active_hour_histogram(Some(&day));
        assert_eq!(on[9], 600_000.0);
        assert_eq!(active[9], 0.0);
        assert_eq!(on[10], 600_000.0);
        assert_eq!(active[10], 300_000.0);
    }

    #[test]
    fn an_empty_day_is_all_zeroes_not_a_guess() {
        let day = DayData::empty("2026-09-30".into(), 0);
        assert!(hour_histogram(Some(&day)).iter().all(|v| *v == 0.0));
        assert!(active_hour_histogram(Some(&day)).iter().all(|v| *v == 0.0));
        // A day with no data at all must not crash the fallback either.
        assert!(hour_histogram(None).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn days_recorded_before_1_3_1_still_render() {
        // No buckets, but real totals — an upgrade must not blank the chart of
        // every day already on disk.
        let mut day = DayData::empty("2026-09-20".into(), 0);
        day.pc_on_ms = 3 * 3_600_000;
        day.active_ms = 2 * 3_600_000;
        day.first_ms = 1_789_000_000_000;
        day.last_ms = day.first_ms + 10 * 3_600_000;
        let hist = hour_histogram(Some(&day));
        assert_eq!(hist.len(), 24);
        assert!(hist.iter().sum::<f64>() > 0.0, "legacy days still show something");
        // The active series stays in proportion to the day's active share.
        let active = active_hour_histogram(Some(&day));
        assert_eq!(active.len(), 24);
        assert!((active.iter().sum::<f64>() - hist.iter().sum::<f64>() * (2.0 / 3.0)).abs() < 1.0);
    }

    #[test]
    fn a_broken_clock_cannot_hang_the_histogram() {
        // last_ms far past a day boundary would loop from 23 to 24... forever
        // if the walk were written naively.
        let mut day = DayData::empty("2026-09-20".into(), 0);
        day.pc_on_ms = 3_600_000;
        day.first_ms = 1_789_000_000_000;
        day.last_ms = day.first_ms + 400 * 86_400_000;
        let hist = legacy_spread(&day);
        assert_eq!(hist.len(), 24);
        assert!(hist.iter().sum::<f64>() > 0.0);
    }

    #[test]
    fn hour_of_stays_inside_the_day() {
        for ms in [0u64, 1_000, 3_600_000, 86_399_000, 1_700_000_000_000] {
            assert!(hour_of(ms) < 24, "hour_of({ms}) escaped the day");
        }
    }

    #[test]
    fn the_trend_window_is_zero_filled_and_ends_today() {
        let mut data = UsageData::empty();
        let now = 1_788_000_000_000u64;
        let today = day_key(now);
        data.days.insert(today.clone(), day_with_buckets(&today, &[(10, 3_600_000, 3_600_000)]));
        let trend = daily_trend(&data, 7, now);
        assert_eq!(trend.len(), 7);
        assert_eq!(trend[6].date, today, "the last point is always today");
        assert_eq!(trend[6].on_ms, 3_600_000);
        // The six days before today have no data and must still be present.
        assert!(trend[..6].iter().all(|p| p.on_ms == 0 && p.active_ms == 0));
    }
}
