//! Safe, in-process API over the existing FFI layer.
//!
//! The FFI surface (`#[no_mangle]` exports + `repr(C)` structs) is unchanged —
//! it is still exercised by the layout tests below — but the Tauri backend
//! consumes these safe wrappers directly instead of loading a DLL, so there is
//! no koffi, no DataView offsets and no second process boundary.

use crate::monitor::BoostMonitorResult;
use crate::{
    BoostIdleResult, BoostPumpResult, BoostSampleResult, EV_SLEEP, EV_SHUTDOWN,
};

/// One tracking sample (foreground app, input idle, power state).
/// Mirrors shared/types.ts `BoostSample`. `process_name` is the full image
/// path when readable, "" when the process info was denied.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Sample {
    pub ok: bool,
    pub foreground_ok: bool,
    pub has_window: bool,
    pub screen_on: bool,
    pub console_locked: bool,
    pub active_session: bool,
    pub input_active: bool,
    pub idle_ms: u32,
    pub ac_online: bool,
    pub battery_pct: u8,
    pub battery_flag: u8,
    pub uptime_ms: u64,
    pub now_epoch_ms: u64,
    pub process_id: u32,
    pub process_path: String,
    pub is_fullscreen: bool,
    pub battery_remaining_min: i32,
}

impl Sample {
    fn from_raw(r: &BoostSampleResult) -> Sample {
        let len = r.fg.process_name.iter().position(|&c| c == 0).unwrap_or(0);
        Sample {
            ok: r.ok == 1,
            foreground_ok: r.foreground_ok == 1,
            has_window: r.has_window == 1,
            screen_on: r.screen_on == 1,
            console_locked: r.console_locked == 1,
            active_session: r.active_session == 1,
            input_active: r.input_active == 1,
            idle_ms: r.idle_ms,
            ac_online: r.ac_online == 1,
            battery_pct: r.battery_pct,
            battery_flag: r.battery_flag,
            uptime_ms: r.uptime_ms,
            now_epoch_ms: r.now_epoch_ms,
            process_id: r.fg.process_id,
            process_path: String::from_utf16_lossy(&r.fg.process_name[..len]),
            is_fullscreen: r.is_fullscreen == 1,
            battery_remaining_min: r.battery_remaining_min,
        }
    }
}

/// Native power/session/display event. `kind` uses the same string names as
/// the TS layer (shared/types.ts `BoostEventKind`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct NativeEvent {
    pub kind: String,
    pub value: i64,
    pub at_ms: u64,
}

/// System monitoring snapshot. Unavailable metrics are `null` — the sentinel
/// mapping the old TS FFI reader did now happens here, once, in Rust.
///
/// `rename_all = "camelCase"` is load-bearing: the renderer contract in
/// `shared/types.ts` is camelCase (`usedBytes`, `tempC`, `downloadBps`), and
/// serializing snake_case left every multi-word field `undefined` on the
/// Monitor page while the single-word ones (usage, name, cores) kept working.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSample {
    pub ok: bool,
    pub now_ms: u64,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub gpu: GpuInfo,
    pub disk: DiskInfo,
    pub network: NetworkInfo,
    pub drives: Vec<DriveInfo>,
    pub os: OsInfo,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    /// 0..=100, or null while unavailable (e.g. first sample).
    pub usage: Option<f64>,
    /// °C, or null when no usable sensor exists.
    pub temp_c: Option<f64>,
    pub name: String,
    pub cores: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub usage: Option<f64>,
    pub temp_c: Option<f64>,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub read_bps: Option<f64>,
    pub write_bps: Option<f64>,
    pub active_pct: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub download_bps: Option<f64>,
    pub upload_bps: Option<f64>,
    pub interface: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub letter: char,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub name: String,
    pub version: String,
}

/// f64 sentinel reader: the native layer reports unavailable metrics as -1.0;
/// NaN or anything negative maps to null (same rule the TS reader used).
fn f64v(v: f64) -> Option<f64> {
    if v.is_finite() && v >= 0.0 {
        Some(v)
    } else {
        None
    }
}

fn wide(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().to_string()
}

/// Windows 11 kept the registry ProductName "Windows 10" for compatibility —
/// correct it from the build number (>= 22000), matching the old TS helper.
fn normalize_os_name(name: String, version: String) -> (String, String) {
    let build = version
        .split("build ")
        .nth(1)
        .and_then(|s| s.trim_end_matches(')').trim().parse::<u32>().ok());
    if build.unwrap_or(0) >= 22000 {
        (name.replacen("Windows 10", "Windows 11", 1), version)
    } else {
        (name, version)
    }
}

impl From<&BoostMonitorResult> for MonitorSample {
    fn from(r: &BoostMonitorResult) -> MonitorSample {
        let (name, version) = normalize_os_name(wide(&r.os_name), wide(&r.os_version));
        MonitorSample {
            ok: r.ok == 1,
            now_ms: r.now_epoch_ms,
            cpu: CpuInfo {
                usage: f64v(r.cpu_usage),
                temp_c: f64v(r.cpu_temp),
                name: wide(&r.cpu_name),
                cores: r.cpu_cores,
            },
            memory: MemoryInfo {
                used_bytes: r.mem_used,
                total_bytes: r.mem_total,
            },
            gpu: GpuInfo {
                usage: f64v(r.gpu_usage),
                temp_c: f64v(r.gpu_temp),
                mem_used_bytes: r.gpu_mem_used,
                mem_total_bytes: r.gpu_mem_total,
                name: wide(&r.gpu_name),
            },
            disk: DiskInfo {
                read_bps: f64v(r.disk_read_bps),
                write_bps: f64v(r.disk_write_bps),
                active_pct: f64v(r.disk_active_pct),
            },
            network: NetworkInfo {
                download_bps: f64v(r.net_download_bps),
                upload_bps: f64v(r.net_upload_bps),
                interface: {
                    let s = wide(&r.net_if_name);
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                },
            },
            drives: r
                .drives
                .iter()
                .filter(|d| d.letter != 0 && d.total_bytes > 0)
                .map(|d| DriveInfo {
                    letter: (d.letter as u8 as char),
                    total_bytes: d.total_bytes,
                    free_bytes: d.free_bytes,
                })
                .collect(),
            os: OsInfo { name, version },
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Start the native event-pump thread. Idempotent.
pub fn start() -> bool {
    crate::oneboost_start() == 1
}

/// Stop the pump thread and release monitoring resources. Idempotent.
pub fn shutdown() {
    crate::oneboost_shutdown()
}

/// Collect one tracking sample.
pub fn collect_once(idle_threshold_ms: u32) -> Option<Sample> {
    let mut raw = BoostSampleResult::zeroed();
    let rc = crate::oneboost_collect_once(&mut raw, idle_threshold_ms);
    if rc == 1 {
        Some(Sample::from_raw(&raw))
    } else {
        None
    }
}

/// Drain queued native events.
pub fn pump_events() -> Vec<NativeEvent> {
    const MAX: usize = 64;
    let mut out = BoostPumpResult::zeroed();
    let mut buf = vec![crate::BoostEventData::zeroed(); MAX];
    let n = crate::oneboost_pump_events(&mut out, buf.as_mut_ptr(), MAX as u32);
    if n <= 0 {
        return Vec::new();
    }
    buf[..n as usize]
        .iter()
        .map(|e| NativeEvent {
            kind: match e.kind {
                EV_SLEEP => "sleep".to_string(),
                EV_SHUTDOWN => "shutdown".to_string(),
                2 => "resume".to_string(),
                3 => "lock".to_string(),
                4 => "unlock".to_string(),
                5 => if e.value > 0 { "monitor-on" } else { "monitor-off" }.to_string(),
                6 => "power-source".to_string(),
                7 => "battery".to_string(),
                8 => "session".to_string(),
                9 => "display".to_string(),
                _ => "display".to_string(),
            },
            value: e.value,
            at_ms: e.now_epoch_ms,
        })
        .collect()
}

/// Idle probe (ms since last input), when available.
pub fn idle_state() -> Option<u32> {
    let mut out = BoostIdleResult::zeroed();
    if crate::oneboost_get_idle_state(&mut out) == 1 && out.ok == 1 {
        Some(out.idle_ms)
    } else {
        None
    }
}

/// One system-monitoring snapshot (rate metrics need a steady ≥2 s cadence).
pub fn monitor_sample() -> Option<MonitorSample> {
    let mut raw = BoostMonitorResult::zeroed();
    let rc = crate::monitor::oneboost_monitor_sample(&mut raw);
    if rc == 1 {
        Some(MonitorSample::from(&raw))
    } else {
        None
    }
}

/// Release the shared PDH query. Safe to call multiple times.
pub fn monitor_shutdown() {
    crate::monitor::oneboost_monitor_shutdown()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer contract (`shared/types.ts`) is camelCase. Serializing
    /// snake_case made every multi-word field undefined in the webview, which
    /// is why the Monitor page only ever had CPU and GPU (both single-word
    /// fields) and stopped updating: its `nowMs` de-dupe compared
    /// `undefined === undefined` and dropped every sample after the first.
    #[test]
    fn monitor_sample_serializes_camel_case() {
        let sample = MonitorSample {
            ok: true,
            now_ms: 1_700_000_000_000,
            cpu: CpuInfo {
                usage: Some(12.5),
                temp_c: Some(48.0),
                name: "Test CPU".into(),
                cores: 8,
            },
            memory: MemoryInfo { used_bytes: 4, total_bytes: 8 },
            gpu: GpuInfo {
                usage: Some(3.0),
                temp_c: None,
                mem_used_bytes: 1,
                mem_total_bytes: 2,
                name: "Test GPU".into(),
            },
            disk: DiskInfo {
                read_bps: Some(10.0),
                write_bps: Some(20.0),
                active_pct: Some(30.0),
            },
            network: NetworkInfo {
                download_bps: Some(1.0),
                upload_bps: Some(2.0),
                interface: Some("Ethernet".into()),
            },
            drives: vec![DriveInfo { letter: 'C', total_bytes: 100, free_bytes: 40 }],
            os: OsInfo { name: "Windows".into(), version: "11".into() },
        };
        let v = serde_json::to_value(&sample).expect("serialize");
        let obj = v.as_object().unwrap();

        for key in ["nowMs", "cpu", "memory", "gpu", "disk", "network", "drives", "os"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
        assert_eq!(obj["cpu"]["tempC"], 48.0);
        assert!(obj["cpu"]["temp_c"].is_null());
        assert_eq!(obj["memory"]["usedBytes"], 4);
        assert_eq!(obj["memory"]["totalBytes"], 8);
        assert_eq!(obj["gpu"]["memUsedBytes"], 1);
        assert_eq!(obj["gpu"]["memTotalBytes"], 2);
        assert_eq!(obj["disk"]["readBps"], 10.0);
        assert_eq!(obj["disk"]["writeBps"], 20.0);
        assert_eq!(obj["disk"]["activePct"], 30.0);
        assert_eq!(obj["network"]["downloadBps"], 1.0);
        assert_eq!(obj["network"]["uploadBps"], 2.0);
        assert_eq!(obj["drives"][0]["totalBytes"], 100);
        assert_eq!(obj["drives"][0]["freeBytes"], 40);
        // Single-word fields keep their name in both casings.
        assert_eq!(obj["cpu"]["usage"], 12.5);
        assert_eq!(obj["os"]["name"], "Windows");
    }
}
