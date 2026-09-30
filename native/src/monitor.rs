//! System monitoring (CPU / RAM / GPU / disk / network / temperature).
//!
//! Exposes two FFI entry points used by the Electron main process:
//!  - `oneboost_monitor_sample`   : one monitoring snapshot (cached state inside the DLL)
//!  - `oneboost_monitor_shutdown` : release the shared PDH query
//!
//! Design rules:
//!  - Every metric that cannot be measured is reported as an explicit
//!    "unavailable" sentinel (-1 for floats, 0 for sizes/strings) — never a
//!    guess. The UI renders those as "unavailable".
//!  - One call returns the whole snapshot; rate metrics (bytes/sec) are
//!    computed from the previous call, so the caller polls at a steady cadence
//!    (2 s) and never faster.
//!  - GPU/disk counters share a single PDH query created lazily on first use.
//!    Windows APIs are declared locally (mirroring the crate-wide pattern of
//!    pinning ABI instead of chasing windows-sys feature gates).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use std::time::Instant;

use crate::now_epoch_ms;

// ---------------------------------------------------------------------------
// Locally declared Win32 imports (stable ABI, defined here to avoid feature
// drift in windows-sys). Only stable, versioned functions are used.
// ---------------------------------------------------------------------------

const ERROR_SUCCESS: u32 = 0;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const PDH_MORE_DATA: u32 = 0x8000_07D2;
const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
/// PDH_CSTATUS_VALID_DATA / PDH_CSTATUS_NEW_DATA — both mean "value is valid".
const PDH_CSTATUS_NEW_DATA: u32 = 1;

const DRIVE_FIXED: u32 = 3;

const HKEY_LOCAL_MACHINE: isize = 0x8000_0002;
const KEY_READ: u32 = 0x0002_0019;
const REG_SZ: u32 = 1;

#[repr(C)]
struct FileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

fn ft100ns(ft: &FileTime) -> u64 {
    ((ft.dw_high_date_time as u64) << 32) | ft.dw_low_date_time as u64
}

/// PDH_FMT_COUNTERVALUE (pdh.h): CStatus then an 8-aligned union. We only ever
/// request PDH_FMT_DOUBLE, so the union is modelled as f64.
#[repr(C)]
struct PdhFmtCounterValue {
    c_status: u32,
    double_value: f64, // union at offset 8
}

/// PDH_FMT_COUNTERVALUE_ITEM_W (pdh.h).
#[repr(C)]
struct PdhFmtCounterValueItemW {
    sz_name: *mut u16,
    fmt_value: PdhFmtCounterValue,
}

/// MIB_IFROW (ifmib.h) — pinned layout, asserted by tests.
#[repr(C)]
struct MibIfRow {
    wsz_name: [u16; 256],
    dw_index: u32,
    dw_type: u32,
    dw_mtu: u32,
    dw_speed: u32,
    dw_phys_addr_len: u32,
    b_phys_addr: [u8; 8],
    dw_admin_status: u32,
    dw_oper_status: u32,
    dw_last_change: u32,
    dw_in_octets: u32,
    dw_in_ucast_pkts: u32,
    dw_in_nucast_pkts: u32,
    dw_in_discards: u32,
    dw_in_errors: u32,
    dw_in_unknown_protos: u32,
    dw_out_octets: u32,
    dw_out_ucast_pkts: u32,
    dw_out_nucast_pkts: u32,
    dw_out_discards: u32,
    dw_out_errors: u32,
    dw_out_qlen: u32,
    dw_descr_len: u32,
    b_descr: [u8; 256],
}

/// IF_TYPE_SOFTWARE_LOOPBACK
const IF_TYPE_LOOPBACK: u32 = 24;

#[link(name = "pdh")]
extern "system" {
    fn PdhOpenQueryW(szdatasource: *const u16, dwuserdata: usize, phquery: *mut isize) -> u32;
    fn PdhCloseQuery(hquery: isize) -> u32;
    fn PdhAddEnglishCounterW(
        hquery: isize,
        szfullcounterpath: *const u16,
        dwuserdata: usize,
        phcounter: *mut isize,
    ) -> u32;
    fn PdhCollectQueryData(hquery: isize) -> u32;
    fn PdhGetFormattedCounterValue(
        hcounter: isize,
        dwformat: u32,
        lptype: *mut u32,
        fmtvalue: *mut PdhFmtCounterValue,
    ) -> u32;
    fn PdhGetFormattedCounterArrayW(
        hcounter: isize,
        dwformat: u32,
        lpdwbuffersize: *mut u32,
        lpdwitemcount: *mut u32,
        itembuffer: *mut u8,
    ) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetSystemTimes(
        lpIdleTime: *mut FileTime,
        lpKernelTime: *mut FileTime,
        lpUserTime: *mut FileTime,
    ) -> i32;
    fn GetLogicalDriveStringsW(nbufferlength: u32, lpbuffer: *mut u16) -> u32;
    fn GetDriveTypeW(lprootpathname: *const u16) -> u32;
    fn GetDiskFreeSpaceExW(
        lpdirectoryname: *const u16,
        lpfreebytesavailabletocaller: *mut u64,
        lptotalnumberofbytes: *mut u64,
        lptotalnumberoffreebytes: *mut u64,
    ) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        hkey: isize,
        lpsubkey: *const u16,
        uloptions: u32,
        samdesired: u32,
        phkresult: *mut isize,
    ) -> i32;
    fn RegQueryValueExW(
        hkey: isize,
        lpvaluename: *const u16,
        lpreserved: *mut u32,
        lptype: *mut u32,
        lpdata: *mut u8,
        lpcbdata: *mut u32,
    ) -> i32;
    fn RegCloseKey(hkey: isize) -> i32;
}

#[link(name = "iphlpapi")]
extern "system" {
    fn GetIfTable(piftable: *mut u8, pdwsize: *mut u32, border: i32) -> u32;
}

use windows_sys::Win32::System::SystemInformation::{
    GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};

// ---------------------------------------------------------------------------
// FFI data structure — layout asserted by tests and mirrored 1:1 in TS
// (electron/main/native.ts, M / M_SIZE).
// ---------------------------------------------------------------------------

impl BoostMonitorResult {
    pub fn zeroed() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoostDriveInfo {
    /// Drive letter as ASCII code ('C' = 67); 0 = unused slot.
    pub letter: u32,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[repr(C)]
pub struct BoostMonitorResult {
    pub ok: i32,
    pub now_epoch_ms: u64,
    /// Overall CPU usage 0..=100; -1 = unavailable (first sample).
    pub cpu_usage: f64,
    /// Hottest thermal zone in °C; -1 = no usable sensor.
    pub cpu_temp: f64,
    pub cpu_name: [u16; 64],
    pub cpu_cores: u32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// GPU usage 0..=100; -1 = counters unavailable on this system.
    pub gpu_usage: f64,
    /// -1: no reliable GPU temperature source (never guessed).
    pub gpu_temp: f64,
    /// GPU memory in use in bytes; 0 = unavailable.
    pub gpu_mem_used: u64,
    /// 0 = total unknown.
    pub gpu_mem_total: u64,
    pub gpu_name: [u16; 96],
    /// Physical-disk rates in bytes/sec; -1 = unavailable.
    pub disk_read_bps: f64,
    pub disk_write_bps: f64,
    /// 100 - % idle, 0..=100; -1 = unavailable.
    pub disk_active_pct: f64,
    /// Summed non-loopback adapter traffic in bytes/sec; -1 = unavailable.
    pub net_download_bps: f64,
    pub net_upload_bps: f64,
    /// Description of the busiest active adapter; empty = unavailable.
    pub net_if_name: [u16; 96],
    /// Fixed drives (up to 8); letter = 0 marks unused slots.
    pub drives: [BoostDriveInfo; 8],
    pub os_name: [u16; 96],
    pub os_version: [u16; 64],
}

/// Sentinels for unavailable float metrics.
const UNAVAIL: f64 = -1.0;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct PdhCounters {
    query: isize,
    gpu_util: isize,
    gpu_mem: isize,
    disk_read: isize,
    disk_write: isize,
    disk_idle: isize,
    temp: isize,
    has_gpu_util: bool,
    has_gpu_mem: bool,
    has_disk: bool,
    has_temp: bool,
}

struct MonitorState {
    pdh: Option<PdhCounters>,
    prev_idle: u64,
    prev_kernel: u64,
    prev_user: u64,
    cpu_prev_valid: bool,
    /// (if index, in octets, out octets) of the previous sample.
    prev_net: Vec<(u32, u64, u64)>,
    net_prev_valid: bool,
    prev_sample: Option<Instant>,
    cpu_name: [u16; 64],
    cpu_cores: u32,
    gpu_name: [u16; 96],
    os_name: [u16; 96],
    os_version: [u16; 64],
}

static MON: Mutex<Option<MonitorState>> = Mutex::new(None);

impl PdhCounters {
    /// Open one shared query and add every counter we might use. Individual
    /// counters that don't exist (e.g. no GPU perf counters) are tolerated —
    /// their metrics simply report unavailable.
    fn open() -> Option<PdhCounters> {
        unsafe {
            let mut query: isize = 0;
            if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != ERROR_SUCCESS {
                return None;
            }
            let mut c = PdhCounters {
                query,
                gpu_util: 0,
                gpu_mem: 0,
                disk_read: 0,
                disk_write: 0,
                disk_idle: 0,
                temp: 0,
                has_gpu_util: false,
                has_gpu_mem: false,
                has_disk: false,
                has_temp: false,
            };
            c.has_gpu_util = add(query, r"\GPU Engine(*)\Utilization Percentage", &mut c.gpu_util);
            c.has_gpu_mem = add(query, r"\GPU Process Memory(*)\Local Usage", &mut c.gpu_mem);
            c.has_disk = add(query, r"\PhysicalDisk(_Total)\Disk Read Bytes/sec", &mut c.disk_read)
                && add(query, r"\PhysicalDisk(_Total)\Disk Write Bytes/sec", &mut c.disk_write)
                && add(query, r"\PhysicalDisk(_Total)\% Idle Time", &mut c.disk_idle);
            c.has_temp = add(query, r"\Thermal Zone Information(*)\Temperature", &mut c.temp);
            // Prime once so rate counters have two samples next read.
            PdhCollectQueryData(query);
            Some(c)
        }
    }
}

fn add(query: isize, path: &str, handle: &mut isize) -> bool {
    let w = wide(path);
    unsafe { PdhAddEnglishCounterW(query, w.as_ptr(), 0, handle) == ERROR_SUCCESS }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Copy `s` into a fixed UTF-16 buffer, NUL-terminated, remainder zeroed.
fn store_wide(dst: &mut [u16], s: &str) {
    if dst.is_empty() {
        return;
    }
    let chars: Vec<u16> = s.encode_utf16().take(dst.len() - 1).collect();
    dst[..chars.len()].copy_from_slice(&chars);
    for b in &mut dst[chars.len()..] {
        *b = 0;
    }
}

// ---------------------------------------------------------------------------
// Registry helpers (static hardware / OS info, read once)
// ---------------------------------------------------------------------------

unsafe fn reg_read_string(subkey: &str, value: &str) -> Option<String> {
    let mut hk: isize = 0;
    let sub = wide(subkey);
    let val = wide(value);
    if RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub.as_ptr(), 0, KEY_READ, &mut hk) != 0 {
        return None;
    }
    let mut buf = [0u8; 1024];
    let mut len: u32 = buf.len() as u32;
    let mut kind: u32 = 0;
    let rc = RegQueryValueExW(hk, val.as_ptr(), std::ptr::null_mut(), &mut kind, buf.as_mut_ptr(), &mut len);
    RegCloseKey(hk);
    if rc != 0 || kind != REG_SZ || len < 2 {
        return None;
    }
    let n = ((len as usize) / 2).min(511);
    let units: Vec<u16> = buf[..n * 2]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(&units))
}

/// CPU name, core count, GPU name and OS strings — read once at first sample.
fn init_names() -> ([u16; 64], u32, [u16; 96], [u16; 96], [u16; 64]) {
    let mut cpu_name = [0u16; 64];
    let mut cpu_cores: u32 = 0;
    let mut gpu_name = [0u16; 96];
    let mut os_name = [0u16; 96];
    let mut os_version = [0u16; 64];

    if let Some(s) = unsafe {
        reg_read_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString")
    } {
        store_wide(&mut cpu_name, s.trim());
    }
    unsafe {
        let mut si: SYSTEM_INFO = std::mem::zeroed();
        GetSystemInfo(&mut si);
        // dwNumberOfProcessors is the logical-processor count (threads), which
        // is what Task Manager shows first; keep that semantic in the UI.
        cpu_cores = si.dwNumberOfProcessors;
    }

    // Primary display adapter (fallback: second entry).
    let gpu_desc = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let s = unsafe { reg_read_string(&format!("{gpu_desc}\\0000"), "DriverDesc") }
        .or_else(|| unsafe { reg_read_string(&format!("{gpu_desc}\\0001"), "DriverDesc") });
    if let Some(s) = s {
        store_wide(&mut gpu_name, s.trim());
    }

    let product = unsafe { reg_read_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName") }
        .unwrap_or_else(|| "Windows".into());
    // Windows 11 kept the registry ProductName "Windows 10"; derive the real
    // marketing name from the build number (>= 22000 is Windows 11).
    let build_str = unsafe {
        reg_read_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")
    };
    let product = match build_str.as_deref().and_then(|b| b.trim().parse::<u32>().ok()) {
        Some(build) if build >= 22000 => product
            .replacen("Windows 10", "Windows 11", 1)
            .trim()
            .to_string(),
        _ => product,
    };
    store_wide(&mut os_name, product.trim());

    let display = unsafe {
        reg_read_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "DisplayVersion")
    };
    let build = unsafe {
        reg_read_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")
    };
    let mut ver = String::new();
    if let Some(d) = display.as_ref() {
        ver.push_str(d.trim());
    }
    if let Some(b) = build.as_ref() {
        if !ver.is_empty() {
            ver.push(' ');
        }
        ver.push_str(&format!("(build {})", b.trim()));
    }
    if !ver.is_empty() {
        store_wide(&mut os_version, &ver);
    }

    (cpu_name, cpu_cores, gpu_name, os_name, os_version)
}

// ---------------------------------------------------------------------------
// PDH reads
// ---------------------------------------------------------------------------

/// Sum of every valid instance of a wildcard counter (e.g. all GPU engines).
/// The scratch buffer is a Vec<u64> so the pointer is guaranteed 8-byte
/// aligned, as PDH_FMT_COUNTERVALUE_ITEM_W requires.
unsafe fn sum_counter_array(handle: isize) -> Option<f64> {
    if handle == 0 {
        return None;
    }
    let mut size: u32 = 65_536;
    let mut buf: Vec<u64> = Vec::new();
    loop {
        buf.resize((size as usize + 7) / 8, 0);
        let mut count: u32 = 0;
        let rc = PdhGetFormattedCounterArrayW(
            handle,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            buf.as_mut_ptr() as *mut u8,
        );
        if rc == PDH_MORE_DATA {
            if size as usize > 4 * 1024 * 1024 || size == 0 {
                return None;
            }
            continue;
        }
        if rc != ERROR_SUCCESS {
            return None;
        }
        let items = std::slice::from_raw_parts(
            buf.as_ptr() as *const PdhFmtCounterValueItemW,
            count as usize,
        );
        let mut sum = 0.0f64;
        let mut any = false;
        for it in items {
            if it.fmt_value.c_status <= PDH_CSTATUS_NEW_DATA {
                sum += it.fmt_value.double_value;
                any = true;
            }
        }
        return if any { Some(sum) } else { None };
    }
}

/// MAX of every valid instance of a wildcard counter — used for metrics whose
/// instances are alternatives rather than additive components (temperatures,
/// utilization percentages, where a sum can exceed the physical maximum).
unsafe fn max_counter_array(handle: isize) -> Option<f64> {
    if handle == 0 {
        return None;
    }
    let mut size: u32 = 65_536;
    let mut buf: Vec<u64> = Vec::new();
    loop {
        buf.resize((size as usize + 7) / 8, 0);
        let mut count: u32 = 0;
        let rc = PdhGetFormattedCounterArrayW(
            handle,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            buf.as_mut_ptr() as *mut u8,
        );
        if rc == PDH_MORE_DATA {
            if size as usize > 4 * 1024 * 1024 || size == 0 {
                return None;
            }
            continue;
        }
        if rc != ERROR_SUCCESS {
            return None;
        }
        let items = std::slice::from_raw_parts(
            buf.as_ptr() as *const PdhFmtCounterValueItemW,
            count as usize,
        );
        let mut max = 0.0f64;
        let mut any = false;
        for it in items {
            if it.fmt_value.c_status <= PDH_CSTATUS_NEW_DATA && it.fmt_value.double_value.is_finite()
            {
                max = max.max(it.fmt_value.double_value);
                any = true;
            }
        }
        return if any { Some(max) } else { None };
    }
}

/// Formatted value of a single-instance counter.
unsafe fn formatted_single(handle: isize) -> Option<f64> {
    if handle == 0 {
        return None;
    }
    let mut v: PdhFmtCounterValue = std::mem::zeroed();
    if PdhGetFormattedCounterValue(handle, PDH_FMT_DOUBLE, std::ptr::null_mut(), &mut v)
        != ERROR_SUCCESS
    {
        return None;
    }
    if v.c_status > PDH_CSTATUS_NEW_DATA {
        return None;
    }
    if !v.double_value.is_finite() {
        return None;
    }
    Some(v.double_value)
}

/// Hottest valid thermal zone in °C. The PDH counter reports Kelvin on most
/// firmware; values that already look like Celsius are accepted as-is.
/// MAX, not the sum: zones are alternatives, not additive components.
unsafe fn hottest_temp(handle: isize) -> Option<f64> {
    max_counter_array(handle).and_then(|raw| {
        let c = if raw > 150.0 { raw - 273.15 } else { raw };
        if (1.0..=120.0).contains(&c) {
            Some((c * 10.0).round() / 10.0)
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// Network rows
// ---------------------------------------------------------------------------

struct NetRow {
    index: u32,
    in_octets: u64,
    out_octets: u64,
    descr: String,
}

unsafe fn get_if_rows() -> Option<Vec<NetRow>> {
    let mut size: u32 = 16 * 1024;
    // Vec<u32> guarantees 4-byte alignment for the MIB_IFROW reads below.
    let mut buf: Vec<u32> = Vec::new();
    loop {
        buf.resize((size as usize + 3) / 4, 0);
        let rc = GetIfTable(buf.as_mut_ptr() as *mut u8, &mut size, 0);
        if rc == ERROR_INSUFFICIENT_BUFFER {
            if size as usize > 1024 * 1024 || size == 0 {
                return None;
            }
            continue;
        }
        if rc != ERROR_SUCCESS {
            return None;
        }
        break;
    }
    let n = *buf.first().unwrap_or(&0) as usize;
    let row_size = std::mem::size_of::<MibIfRow>();
    let mut rows = Vec::with_capacity(n.min(64));
    for i in 0..n {
        let off = 4 + i * row_size;
        if off + row_size > buf.len() * 4 {
            break;
        }
        let row = &*((buf.as_ptr() as *const u8).add(off) as *const MibIfRow);
        if row.dw_type == IF_TYPE_LOOPBACK {
            continue;
        }
        let dlen = (row.dw_descr_len as usize).min(row.b_descr.len());
        let descr = String::from_utf8_lossy(&row.b_descr[..dlen]).trim().to_string();
        rows.push(NetRow {
            index: row.dw_index,
            in_octets: row.dw_in_octets as u64,
            out_octets: row.dw_out_octets as u64,
            descr,
        });
    }
    Some(rows)
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

unsafe fn fill_drives(out: &mut BoostMonitorResult) {
    let mut buf = [0u16; 512];
    let n = GetLogicalDriveStringsW(512, buf.as_mut_ptr()) as usize;
    if n == 0 || n >= buf.len() {
        return;
    }
    let mut idx = 0usize;
    let mut slot = 0usize;
    while idx < n && buf[idx] != 0 && slot < out.drives.len() {
        let start = idx;
        while idx < n && buf[idx] != 0 {
            idx += 1;
        }
        let root = &buf[start..idx]; // e.g. "C:\"
        idx += 1; // skip separator NUL
        if root.is_empty() {
            continue;
        }
        let mut path: Vec<u16> = root.to_vec();
        if path[path.len() - 1] != b'\\' as u16 {
            path.push(b'\\' as u16);
        }
        path.push(0);
        if GetDriveTypeW(path.as_ptr()) != DRIVE_FIXED {
            continue;
        }
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        let mut dummy: u64 = 0;
        if GetDiskFreeSpaceExW(path.as_ptr(), &mut dummy, &mut total, &mut free) != 0 && total > 0
        {
            out.drives[slot] = BoostDriveInfo {
                letter: root[0] as u32,
                total_bytes: total,
                free_bytes: free,
            };
            slot += 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

fn monitor_sample_inner(out: &mut BoostMonitorResult) -> i32 {
    // Explicit "unavailable" defaults: every float metric starts at -1 and is
    // only overwritten by a real measurement. The struct arrives zeroed, so
    // zero would otherwise be indistinguishable from a genuine 0% reading.
    out.cpu_usage = UNAVAIL;
    out.cpu_temp = UNAVAIL;
    out.gpu_usage = UNAVAIL;
    out.gpu_temp = UNAVAIL;
    out.disk_read_bps = UNAVAIL;
    out.disk_write_bps = UNAVAIL;
    out.disk_active_pct = UNAVAIL;
    out.net_download_bps = UNAVAIL;
    out.net_upload_bps = UNAVAIL;

    out.ok = 1;
    out.now_epoch_ms = now_epoch_ms();

    let mut guard = match MON.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let state = guard.get_or_insert_with(|| {
        let (cpu_name, cpu_cores, gpu_name, os_name, os_version) = init_names();
        MonitorState {
            pdh: None,
            prev_idle: 0,
            prev_kernel: 0,
            prev_user: 0,
            cpu_prev_valid: false,
            prev_net: Vec::new(),
            net_prev_valid: false,
            prev_sample: None,
            cpu_name,
            cpu_cores,
            gpu_name,
            os_name,
            os_version,
        }
    });

    // dt since the previous sample gates every rate metric.
    let dt = state
        .prev_sample
        .map(|t| t.elapsed().as_secs_f64())
        .unwrap_or(0.0);
    state.prev_sample = Some(Instant::now());
    let dt_ok = dt >= 0.1 && dt <= 10.0;

    // ---- CPU usage (GetSystemTimes; kernel time already includes idle) ----
    unsafe {
        let mut idle = std::mem::zeroed::<FileTime>();
        let mut kernel = std::mem::zeroed::<FileTime>();
        let mut user = std::mem::zeroed::<FileTime>();
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
            let i = ft100ns(&idle);
            let k = ft100ns(&kernel);
            let u = ft100ns(&user);
            if state.cpu_prev_valid && dt_ok {
                let di = i.saturating_sub(state.prev_idle);
                let total = k
                    .saturating_sub(state.prev_kernel)
                    .saturating_add(u.saturating_sub(state.prev_user));
                if total > 0 {
                    out.cpu_usage =
                        (100.0 * (1.0 - di as f64 / total as f64)).clamp(0.0, 100.0);
                }
            }
            state.prev_idle = i;
            state.prev_kernel = k;
            state.prev_user = u;
            state.cpu_prev_valid = true;
        }
    }

    // ---- Memory ----
    unsafe {
        let mut ms: MEMORYSTATUSEX = std::mem::zeroed();
        ms.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut ms) != 0 {
            out.mem_total = ms.ullTotalPhys;
            out.mem_used = ms.ullTotalPhys.saturating_sub(ms.ullAvailPhys);
        }
    }

    // ---- PDH-backed metrics: GPU / disk / temperature ----
    if state.pdh.is_none() {
        state.pdh = PdhCounters::open();
    }
    let mut pdh_ok = false;
    let mut gpu_util: Option<f64> = None;
    let mut gpu_mem: Option<f64> = None;
    let mut disk_read: Option<f64> = None;
    let mut disk_write: Option<f64> = None;
    let mut disk_idle: Option<f64> = None;
    let mut temp: Option<f64> = None;
    if let Some(pdh) = state.pdh.as_ref() {
        pdh_ok = unsafe { PdhCollectQueryData(pdh.query) } == ERROR_SUCCESS;
        if pdh_ok {
            unsafe {
                if pdh.has_gpu_util {
                    gpu_util = max_counter_array(pdh.gpu_util);
                }
                if pdh.has_gpu_mem {
                    gpu_mem = sum_counter_array(pdh.gpu_mem);
                }
                if pdh.has_disk {
                    disk_read = formatted_single(pdh.disk_read);
                    disk_write = formatted_single(pdh.disk_write);
                    disk_idle = formatted_single(pdh.disk_idle);
                }
                if pdh.has_temp {
                    temp = hottest_temp(pdh.temp);
                }
            }
        }
    }
    if let Some(v) = gpu_util {
        // "Utilization Percentage" summed over every engine instance can
        // exceed 100 when several engines run concurrently; overall usage is
        // reported here as the busiest engine, not an invented total.
        out.gpu_usage = v.clamp(0.0, 100.0);
    }
    if let Some(v) = gpu_mem {
        if v.is_finite() && v >= 0.0 {
            out.gpu_mem_used = v as u64;
        }
    }
    if let Some(v) = disk_read {
        if v.is_finite() && v >= 0.0 {
            out.disk_read_bps = v;
        }
    }
    if let Some(v) = disk_write {
        if v.is_finite() && v >= 0.0 {
            out.disk_write_bps = v;
        }
    }
    if let Some(v) = disk_idle {
        if v.is_finite() {
            out.disk_active_pct = (100.0 - v).clamp(0.0, 100.0);
        }
    }
    if let Some(v) = temp {
        out.cpu_temp = v;
    }

    // ---- Network (GetIfTable deltas across non-loopback adapters) ----
    if dt_ok {
        if let Some(rows) = unsafe { get_if_rows() } {
            let cap = (dt * 12.5e9) as u64; // > 100 Gbit/s ⇒ counter reset, skip
            let mut down: u64 = 0;
            let mut up: u64 = 0;
            let mut busiest: Option<(u64, &NetRow)> = None;
            let mut any_delta = false;
            for row in &rows {
                if let Some((_, pin, pout)) =
                    state.prev_net.iter().find(|(idx, _, _)| *idx == row.index)
                {
                    let d_in = row.in_octets.wrapping_sub(*pin);
                    let d_out = row.out_octets.wrapping_sub(*pout);
                    let d_in = if d_in <= cap { d_in } else { 0 };
                    let d_out = if d_out <= cap { d_out } else { 0 };
                    down += d_in;
                    up += d_out;
                    any_delta = true;
                    let activity = d_in + d_out;
                    match busiest {
                        Some((best, _)) if best >= activity => {}
                        _ => busiest = Some((activity, row)),
                    }
                }
            }
            state.prev_net = rows
                .iter()
                .map(|r| (r.index, r.in_octets, r.out_octets))
                .collect();
            if state.net_prev_valid && any_delta {
                out.net_download_bps = (down as f64 / dt).max(0.0);
                out.net_upload_bps = (up as f64 / dt).max(0.0);
                if let Some((_, row)) = busiest {
                    if !row.descr.is_empty() {
                        store_wide(&mut out.net_if_name, &row.descr);
                    }
                }
            }
            state.net_prev_valid = true;
        } else {
            state.net_prev_valid = false;
        }
    }

    // ---- Static info + drives ----
    out.cpu_cores = state.cpu_cores;
    out.cpu_name = state.cpu_name;
    out.gpu_name = state.gpu_name;
    out.os_name = state.os_name;
    out.os_version = state.os_version;
    unsafe { fill_drives(out) };
    1
}

// ---------------------------------------------------------------------------
// FFI exports
// ---------------------------------------------------------------------------

/// Collect one monitoring snapshot. Returns 1 on success (individual metrics
/// may still be "unavailable"), 0 on error.
#[no_mangle]
pub extern "system" fn oneboost_monitor_sample(out: *mut BoostMonitorResult) -> i32 {
    if out.is_null() {
        return 0;
    }
    let r = catch_unwind(AssertUnwindSafe(|| unsafe {
        std::ptr::write_bytes(out, 0, 1);
        monitor_sample_inner(&mut *out)
    }));
    r.unwrap_or(0)
}

/// Release the shared PDH query. Safe to call multiple times.
#[no_mangle]
pub extern "system" fn oneboost_monitor_shutdown() {
    if let Ok(mut guard) = MON.lock() {
        if let Some(state) = guard.as_mut() {
            if let Some(pdh) = state.pdh.take() {
                unsafe {
                    PdhCloseQuery(pdh.query);
                }
            }
        }
        *guard = None;
    }
}

// ---------------------------------------------------------------------------
// Layout tests — offsets mirrored by DataView code in electron/main/native.ts
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    #[test]
    fn monitor_layouts() {
        assert_eq!(size_of::<BoostDriveInfo>(), 24);
        assert_eq!(offset_of!(BoostDriveInfo, letter), 0);
        assert_eq!(offset_of!(BoostDriveInfo, total_bytes), 8);
        assert_eq!(offset_of!(BoostDriveInfo, free_bytes), 16);

        assert_eq!(size_of::<BoostMonitorResult>(), 1152);
        assert_eq!(offset_of!(BoostMonitorResult, ok), 0);
        assert_eq!(offset_of!(BoostMonitorResult, now_epoch_ms), 8);
        assert_eq!(offset_of!(BoostMonitorResult, cpu_usage), 16);
        assert_eq!(offset_of!(BoostMonitorResult, cpu_temp), 24);
        assert_eq!(offset_of!(BoostMonitorResult, cpu_name), 32);
        assert_eq!(offset_of!(BoostMonitorResult, cpu_cores), 160);
        assert_eq!(offset_of!(BoostMonitorResult, mem_used), 168);
        assert_eq!(offset_of!(BoostMonitorResult, mem_total), 176);
        assert_eq!(offset_of!(BoostMonitorResult, gpu_usage), 184);
        assert_eq!(offset_of!(BoostMonitorResult, gpu_temp), 192);
        assert_eq!(offset_of!(BoostMonitorResult, gpu_mem_used), 200);
        assert_eq!(offset_of!(BoostMonitorResult, gpu_mem_total), 208);
        assert_eq!(offset_of!(BoostMonitorResult, gpu_name), 216);
        assert_eq!(offset_of!(BoostMonitorResult, disk_read_bps), 408);
        assert_eq!(offset_of!(BoostMonitorResult, disk_write_bps), 416);
        assert_eq!(offset_of!(BoostMonitorResult, disk_active_pct), 424);
        assert_eq!(offset_of!(BoostMonitorResult, net_download_bps), 432);
        assert_eq!(offset_of!(BoostMonitorResult, net_upload_bps), 440);
        assert_eq!(offset_of!(BoostMonitorResult, net_if_name), 448);
        assert_eq!(offset_of!(BoostMonitorResult, drives), 640);
        assert_eq!(offset_of!(BoostMonitorResult, os_name), 832);
        assert_eq!(offset_of!(BoostMonitorResult, os_version), 1024);
    }

    #[test]
    fn pdh_layouts() {
        assert_eq!(size_of::<PdhFmtCounterValue>(), 16);
        assert_eq!(offset_of!(PdhFmtCounterValue, c_status), 0);
        assert_eq!(offset_of!(PdhFmtCounterValue, double_value), 8);
        assert_eq!(size_of::<PdhFmtCounterValueItemW>(), 24);
        assert_eq!(offset_of!(PdhFmtCounterValueItemW, fmt_value), 8);
    }

    #[test]
    fn ifrow_layouts() {
        assert_eq!(size_of::<MibIfRow>(), 860);
        assert_eq!(offset_of!(MibIfRow, wsz_name), 0);
        assert_eq!(offset_of!(MibIfRow, dw_index), 512);
        assert_eq!(offset_of!(MibIfRow, dw_in_octets), 552);
        assert_eq!(offset_of!(MibIfRow, dw_out_octets), 576);
        assert_eq!(offset_of!(MibIfRow, dw_descr_len), 600);
        assert_eq!(offset_of!(MibIfRow, b_descr), 604);
    }
}
