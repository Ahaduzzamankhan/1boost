//! Small shared helpers.

use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// Locks that survive a poisoning panic.
///
/// `Mutex::lock().unwrap()` turns one panic in a thread that held the lock
/// into a permanently broken feature: every later call panics too, Tauri
/// turns that into a rejected command, and the renderer — which cannot tell
/// a poisoned mutex from anything else — shows a button that quietly does
/// nothing. The data behind a `Mutex` here is plain vectors and strings that
/// are always left in a consistent state, so recovering the guard is safe
/// and keeps one bad frame from killing a whole subsystem.
pub trait LockOk<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}

impl<T> LockOk<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Local-time day key "YYYY-MM-DD" (mirrors aggregator.ts dayKey).
pub fn day_key(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    // Local offset: Windows exposes no cheap CRT-free TZ query in std; use
    // the chrono-free approach of reading the offset from the CRT via
    // `localtime`-equivalent through the `windows`-free route: std only has
    // UTC, so compute the offset once from the environment (TZ is normally
    // unset) — instead we derive local time from the Win32 file time of the
    // local calendar via SystemTime → local offset using GetTimeZoneInfo?
    // Simplest reliable approach without extra deps: offset from
    // `offset_seconds()` below (cached).
    let off = local_utc_offset_secs();
    let local = secs + off;
    format_epoch_as_day(local)
}

pub fn parse_day_key(key: &str) -> Option<i64> {
    // Returns UTC-seconds of local midnight (approximation is fine: used only
    // for day arithmetic / weekday of that local date).
    let mut it = key.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    Some(days_from_civil(y, m, d) * 86_400)
}

pub fn day_key_from_ymd(y: i64, m: i64, d: i64) -> String {
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Weekday (0=Sunday..6=Saturday) of a local day key.
pub fn weekday_of_key(key: &str) -> u32 {
    match parse_day_key(key) {
        Some(secs) => {
            let days = secs.div_euclid(86_400);
            // 1970-01-01 was a Thursday (4).
            (days + 4).rem_euclid(7) as u32
        }
        None => 0,
    }
}

/// Add `days` to a day key (local civil arithmetic, no DST pitfalls).
pub fn shift_day_key(key: &str, days: i64) -> Option<String> {
    let secs = parse_day_key(key)?;
    let total = secs + days * 86_400;
    let (y, m, d) = civil_from_days(total.div_euclid(86_400));
    Some(day_key_from_ymd(y, m, d))
}

/// Local weekday (0 = Sunday) of an epoch-ms instant.
pub fn local_weekday(ms: u64) -> u32 {
    weekday_of_key(&day_key(ms))
}

/// Add calendar months to an epoch-ms instant, in local time.
///
/// Month arithmetic cannot be done in milliseconds: "the 31st" has no
/// February, so clamping to the last day of the target month is the only
/// sensible answer, and adding 86_400_000 * 30 would drift a recurring task
/// by a day every time it rolled over.
pub fn add_local_month(ms: u64, months: i64) -> u64 {
    let day = day_key(ms);
    let Some(secs) = parse_day_key(&day) else { return ms };
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    // Zero-based month so negative months work as subtraction.
    let total = (y * 12 + (m - 1)) + months;
    let ny = total.div_euclid(12);
    let nm = total.rem_euclid(12) + 1;
    let last = days_in_month(ny, nm);
    let nd = d.min(last);
    let next = days_from_civil(ny, nm, nd) * 86_400;
    // Keep the instant's time-of-day; only the date moves.
    let time_of_day = ms - days.saturating_mul(86_400) * 1000;
    (next * 1000).saturating_add(time_of_day)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 30,
    }
}

// ---------------------------------------------------------------------------
// Local timezone offset
// ---------------------------------------------------------------------------
//
// Cached, but not forever: a laptop that crosses a DST boundary or whose user
// changes the timezone in Windows would otherwise keep filing samples under
// yesterday's day key, and the day would silently split in two. The clock read
// is cheap, so it is refreshed on a timer instead of once per process.

use std::time::Instant;

/// How long a cached offset is trusted. Comfortably under the shortest DST
/// transition, so a boundary is never crossed with a stale offset.
const OFFSET_TTL: std::time::Duration = std::time::Duration::from_secs(60);

static OFFSET: Mutex<Option<(Instant, i64)>> = Mutex::new(None);

fn local_utc_offset_secs() -> i64 {
    let mut guard = OFFSET.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((taken, offset)) = *guard {
        if taken.elapsed() < OFFSET_TTL {
            return offset;
        }
    }
    let offset = unsafe { compute_local_offset_secs() };
    *guard = Some((Instant::now(), offset));
    offset
}

/// Public read-only accessor (used by the hourly histogram).
pub fn local_offset_secs() -> i64 {
    local_utc_offset_secs()
}

#[cfg(windows)]
unsafe fn compute_local_offset_secs() -> i64 {
    #[repr(C)]
    struct TimezoneInformation {
        bias: i32,
        standard_name: [u16; 32],
        standard_date: [u32; 8],
        standard_bias: i32,
        daylight_name: [u16; 32],
        daylight_date: [u32; 8],
        daylight_bias: i32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTimeZoneInformation(tz: *mut TimezoneInformation) -> u32;
    }
    let mut tz: TimezoneInformation = std::mem::zeroed();
    let rc = GetTimeZoneInformation(&mut tz);
    // TIME_ZONE_ID_STANDARD = 1, TIME_ZONE_ID_DAYLIGHT = 2
    let bias = if rc == 2 { tz.bias + tz.daylight_bias } else { tz.bias };
    // Bias is minutes west of UTC → local = utc - bias.
    -(bias as i64) * 60
}

#[cfg(not(windows))]
unsafe fn compute_local_offset_secs() -> i64 {
    0
}

// ---------------------------------------------------------------------------
// Civil-date math (Howard Hinnant's algorithms)
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn format_epoch_as_day(local_secs: i64) -> String {
    let (y, m, d) = civil_from_days(local_secs.div_euclid(86_400));
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_roundtrip() {
        for &(y, m, d) in &[(2026i64, 9i64, 28i64), (1970, 1, 1), (2000, 2, 29), (2026, 1, 5)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d));
        }
    }

    #[test]
    fn weekday_math() {
        // 2026-09-28 is a Monday.
        assert_eq!(weekday_of_key("2026-09-28"), 1);
        assert_eq!(weekday_of_key("2026-10-04"), 0); // Sunday
        assert_eq!(weekday_of_key("1970-01-01"), 4); // Thursday
    }

    #[test]
    fn shift_days() {
        assert_eq!(shift_day_key("2026-09-28", 1).unwrap(), "2026-09-29");
        assert_eq!(shift_day_key("2026-09-30", 1).unwrap(), "2026-10-01");
        assert_eq!(shift_day_key("2026-03-01", -1).unwrap(), "2026-02-28");
        assert_eq!(shift_day_key("2026-01-01", -1).unwrap(), "2025-12-31");
    }

    #[test]
    fn day_keys_are_distinct_across_a_month_boundary() {
        // Month, year and leap-day boundaries are where civil-date arithmetic
        // goes wrong, and a wrong day key silently drops a day of usage.
        assert_eq!(shift_day_key("2026-01-31", 1).unwrap(), "2026-02-01");
        assert_eq!(shift_day_key("2026-02-01", -1).unwrap(), "2026-01-31");
        assert_eq!(shift_day_key("2026-12-31", 1).unwrap(), "2027-01-01");
        // A leap year inserts the extra day...
        assert_eq!(shift_day_key("2028-02-28", 1).unwrap(), "2028-02-29");
        assert_eq!(shift_day_key("2028-03-01", -1).unwrap(), "2028-02-29");
        // ...and a common year must not, or every day drifts by one.
        assert_eq!(shift_day_key("2026-02-28", 1).unwrap(), "2026-03-01");
    }

    #[test]
    fn a_full_year_of_shifts_is_invertible() {
        // Guards the arithmetic the retention trim and the trend window both
        // depend on: shifting forward then back must land on the same key.
        // 2026 is not a leap year, so 365 steps forward is the next Jan 1.
        let mut key = "2026-01-01".to_string();
        for _ in 0..365 {
            key = shift_day_key(&key, 1).unwrap();
        }
        assert_eq!(key, "2027-01-01");
        for _ in 0..365 {
            key = shift_day_key(&key, -1).unwrap();
        }
        assert_eq!(key, "2026-01-01");
    }

    #[test]
    fn weekday_survives_a_long_shift_chain() {
        // Each shift must advance the weekday by exactly one.
        let key = shift_day_key("2026-09-28", 100).unwrap();
        assert_eq!(weekday_of_key(&key), (weekday_of_key("2026-09-28") + 100) % 7);
    }

    #[test]
    fn month_arithmetic_clamps_to_the_end_of_a_short_month() {
        // 2026-01-31 + 1 month has no 31st, so it lands on the 28th.
        let jan31 = days_from_civil(2026, 1, 31) * 86_400 * 1000;
        assert_eq!(day_key(add_local_month(jan31, 1)), "2026-02-28");
        // Forward and backward across a year boundary.
        let dec = days_from_civil(2026, 12, 15) * 86_400 * 1000;
        assert_eq!(day_key(add_local_month(dec, 1)), "2027-01-15");
        assert_eq!(day_key(add_local_month(dec, -12)), "2025-12-15");
        // A leap year still gets its 29th.
        let jan = days_from_civil(2028, 1, 31) * 86_400 * 1000;
        assert_eq!(day_key(add_local_month(jan, 1)), "2028-02-29");
        // The time of day survives the move.
        let with_time = jan + 13 * 3_600_000 + 45 * 60_000;
        let moved = add_local_month(with_time, 1);
        assert_eq!(moved - days_from_civil(2028, 2, 29) * 86_400 * 1000, 13 * 3_600_000 + 45 * 60_000);
    }

    #[test]
    fn local_weekday_matches_the_day_key() {
        let monday = days_from_civil(2026, 9, 28) * 86_400 * 1000;
        assert_eq!(local_weekday(monday), 1);
        assert_eq!(local_weekday(monday + 6 * 86_400_000), 0, "the next Sunday");
    }

    #[test]
    fn the_offset_cache_is_safe_to_read_concurrently() {
        // The tracker loop and the UI both call this; a poisoned cache must not
        // take the tracking thread down with it.
        let a = std::thread::spawn(local_utc_offset_secs);
        let b = std::thread::spawn(local_utc_offset_secs);
        assert_eq!(a.join().unwrap(), b.join().unwrap());
    }
}
