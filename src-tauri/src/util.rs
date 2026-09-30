//! Small shared helpers.

use std::time::{SystemTime, UNIX_EPOCH};

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

// ---------------------------------------------------------------------------
// Local timezone offset (cached once per process)
// ---------------------------------------------------------------------------

use std::sync::OnceLock;

static OFFSET: OnceLock<i64> = OnceLock::new();

fn local_utc_offset_secs() -> i64 {
    *OFFSET.get_or_init(|| unsafe { compute_local_offset_secs() })
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
}
