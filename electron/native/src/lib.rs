//! 1Boost native tracking layer (Windows).
//!
//! Exposes five FFI entry points used by the Electron main process:
//!  - `oneboost_start`          : spawn the event pump thread (hidden message window)
//!  - `oneboost_shutdown`       : stop the pump thread cleanly
//!  - `oneboost_collect_once`   : one tracking sample (foreground app + input + power state)
//!  - `oneboost_pump_events`    : drain Win32 power / session / display events
//!  - `oneboost_get_idle_state` : GetLastInputInfo-derived idle probe
//!
//! The pump thread owns a hidden top-level window so it receives WM_POWERBROADCAST
//! broadcasts (sleep/resume), a registered power-setting notification (monitor on/off)
//! and WM_WTSSESSION_CHANGE (lock/unlock/logoff) events. It sleeps on
//! MsgWaitForMultipleObjectsEx so events wake it immediately; otherwise it idles at
//! ~1.2s — negligible CPU. Sleep detection is additionally backed by uptime-gap
//! analysis so no suspend is ever missed even if a broadcast is lost.

#![cfg(windows)]
#![allow(non_snake_case)]

use std::collections::VecDeque;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{
    AtomicBool, AtomicI32, AtomicIsize, AtomicU32, AtomicU64, Ordering,
};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{
    GetSystemPowerStatus, PowerSettingRegisterNotification, UnregisterPowerSettingNotification,
    POWERBROADCAST_SETTING, SYSTEM_POWER_STATUS,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSQuerySessionInformationW,
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, MsgWaitForMultipleObjectsEx,
    PeekMessageW, PostThreadMessageW, RegisterClassW, TranslateMessage, MSG, MWMO_INPUTAVAILABLE,
    QS_ALLINPUT, WNDCLASSW, WM_APP, WM_DISPLAYCHANGE, WM_ENDSESSION, WM_POWERBROADCAST,
    WM_QUERYENDSESSION, WM_WTSSESSION_CHANGE,
};

// ---------------------------------------------------------------------------
// Win32 ABI constants (stable values, defined locally to avoid version drift)
// ---------------------------------------------------------------------------

const PBT_APMSUSPEND: u32 = 4;
const PBT_APMRESUMESUSPEND: u32 = 7;
const PBT_APMPOWERSTATUSCHANGE: u32 = 10;
const PBT_APMRESUMEAUTOMATIC: u32 = 18;
const PBT_POWERSETTINGCHANGE: u32 = 0x8013;

const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0;
const NOTIFY_FOR_THIS_SESSION: u32 = 0;
const PM_REMOVE: u32 = 1;
const PM_NOREMOVE: u32 = 0;

const WTS_CONSOLE_CONNECT: u32 = 1;
const WTS_CONSOLE_DISCONNECT: u32 = 2;
const WTS_REMOTE_CONNECT: u32 = 3;
const WTS_REMOTE_DISCONNECT: u32 = 4;
const WTS_SESSION_LOGOFF: u32 = 6;
const WTS_SESSION_LOCK: u32 = 7;
const WTS_SESSION_UNLOCK: u32 = 8;
/// WTS_INFO_CLASS.WTSSessionInfoEx
const WTS_INFO_CLASS_SESSION_INFO_EX: u32 = 25;
/// WTSINFOEXW.Level1.WTSINFOEX_LEVEL1.SessionFlags value when locked.
const WTS_SESSIONSTATE_LOCK: u32 = 7;

const WM_APP_QUIT: u32 = WM_APP + 2;

/// {02731015-4510-4526-9E0D-D837DA21830D} GUID_MONITOR_POWER_ON
const GUID_MONITOR_POWER_ON: windows_sys::core::GUID = windows_sys::core::GUID {
    data1: 0x02731015,
    data2: 0x4510,
    data3: 0x4526,
    data4: [0x9E, 0x0D, 0xD8, 0x37, 0xDA, 0x21, 0x83, 0x0D],
};

fn guid_eq(a: &windows_sys::core::GUID, b: &windows_sys::core::GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

// ---------------------------------------------------------------------------
// Event kinds (mirrored in electron/main/tracker.ts)
// ---------------------------------------------------------------------------

pub const EV_SLEEP: u32 = 1;
pub const EV_RESUME: u32 = 2;
pub const EV_LOCK: u32 = 3;
pub const EV_UNLOCK: u32 = 4;
pub const EV_MONITOR: u32 = 5;
pub const EV_POWER_SOURCE: u32 = 6;
pub const EV_BATTERY: u32 = 7;
pub const EV_SESSION: u32 = 8;
pub const EV_DISPLAY: u32 = 9;
pub const EV_SHUTDOWN: u32 = 10;
pub const EV_QUIT: u32 = 11;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

static MONITOR_ON: AtomicI32 = AtomicI32::new(1);
static CONSOLE_LOCKED: AtomicI32 = AtomicI32::new(0);
static SESSION_ACTIVE: AtomicI32 = AtomicI32::new(1);
static LAST_AC: AtomicI32 = AtomicI32::new(-1);
static LAST_BATT: AtomicI32 = AtomicI32::new(-1);
static LAST_WAKE_UPTIME: AtomicU64 = AtomicU64::new(0);
static LAST_TIMEOUT: AtomicU32 = AtomicU32::new(1200);
static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static STOPPED: AtomicBool = AtomicBool::new(true);
static READY: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
static POWER_NOTIF: AtomicIsize = AtomicIsize::new(0);

const EVQ_CAP: usize = 128;
static EVQ: Mutex<VecDeque<BoostEventData>> = Mutex::new(VecDeque::new());

const CLS_NAME: &[u16] = &[
    b'1' as u16, b'B' as u16, b'o' as u16, b'o' as u16, b's' as u16, b't' as u16,
    b'T' as u16, b'r' as u16, b'a' as u16, b'c' as u16, b'k' as u16, b'e' as u16,
    b'r' as u16, b'W' as u16, b'n' as u16, b'd' as u16, 0,
];

// ---------------------------------------------------------------------------
// FFI data structures — layouts are asserted by tests and mirrored 1:1 in TS
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoostForegroundApp {
    /// Full process image path, NUL-terminated UTF-16 (may be empty if denied).
    pub process_name: [u16; 260],
    pub process_id: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoostSampleResult {
    pub uptime_ms: u64,
    pub now_epoch_ms: u64,
    pub ok: i32,
    /// 1 when a foreground window was found and process info was read.
    pub foreground_ok: i32,
    /// 1 when GetForegroundWindow returned a window at all.
    pub has_window: i32,
    pub screen_on: i32,
    pub console_locked: i32,
    pub active_session: i32,
    /// Input within idle threshold + screen on + unlocked + session active.
    pub input_active: i32,
    pub idle_ms: u32,
    pub ac_online: i32,
    pub battery_pct: u8,
    /// Raw SYSTEM_POWER_STATUS.BatteryFlag (128 = no battery).
    pub battery_flag: u8,
    pub fg: BoostForegroundApp,
    /// 1 when the foreground window covers its monitor (fullscreen/game/film).
    pub is_fullscreen: i32,
    /// Windows BatteryLifeTime in minutes; -1 = unknown / on AC / no battery.
    pub battery_remaining_min: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoostEventData {
    pub value: i64,
    pub now_epoch_ms: u64,
    pub kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoostPumpResult {
    pub uptime_ms: u64,
    pub now_epoch_ms: u64,
    pub count: u32,
    /// 1 when events were drained.
    pub flushed: u32,
    pub next_poll_ms: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoostIdleResult {
    pub ok: i32,
    pub idle_ms: u32,
    pub now_epoch_ms: u64,
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn now_epoch_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0, // pre-epoch clock skew; not a realistic tracking scenario
    }
}

fn uptime_ms() -> u64 {
    unsafe { GetTickCount64() }
}

fn push_event(kind: u32, value: i64) {
    let ev = BoostEventData {
        value,
        now_epoch_ms: now_epoch_ms(),
        kind,
    };
    if let Ok(mut q) = EVQ.lock() {
        if q.len() >= EVQ_CAP {
            q.pop_front();
        }
        q.push_back(ev);
    }
}

unsafe fn fg_from_window(hwnd: isize, out: &mut BoostForegroundApp) -> bool {
    if hwnd == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
        return false;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 {
        return false;
    }
    out.process_id = pid;
    let h: isize = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if h != 0 {
        let mut len: u32 = (out.process_name.len() - 1) as u32;
        if QueryFullProcessImageNameW(h, 0, out.process_name.as_mut_ptr(), &mut len) != 0 {
            out.process_name[len as usize] = 0;
        }
        CloseHandle(h);
    }
    true
}

/// True when the window's rect fully covers its monitor (fullscreen app/video).
/// A plain maximized window never covers the taskbar, so this stays false there.
unsafe fn is_fullscreen_window(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    let mut rect = std::mem::zeroed();
    if GetWindowRect(hwnd, &mut rect) == 0 {
        return false;
    }
    let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if mon == 0 {
        return false;
    }
    let mut mi: MONITORINFO = std::mem::zeroed();
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(mon, &mut mi) == 0 {
        return false;
    }
    rect.left <= mi.rcMonitor.left
        && rect.right >= mi.rcMonitor.right
        && rect.top <= mi.rcMonitor.top
        && rect.bottom >= mi.rcMonitor.bottom
}

/// Probe the console session lock state via WTSINFOEX (SessionFlags at byte 16).
unsafe fn console_locked_probe() -> bool {
    let sid = WTSGetActiveConsoleSessionId();
    if sid == 0xFFFF_FFFF {
        return false;
    }
    let mut buf: *mut u16 = std::ptr::null_mut();
    let mut len: u32 = 0;
    let ok = WTSQuerySessionInformationW(
        0,
        sid,
        WTS_INFO_CLASS_SESSION_INFO_EX as i32,
        &mut buf,
        &mut len,
    );
    if ok == 0 || buf.is_null() || len < 20 {
        return false;
    }
    let outer_level = std::ptr::read_unaligned(buf.add(0) as *const u32);
    let flags = if outer_level == 1 {
        std::ptr::read_unaligned(buf.add(8) as *const u32)
    } else {
        0
    };
    WTSFreeMemory(buf as *mut c_void);
    flags == WTS_SESSIONSTATE_LOCK
}

fn refresh_power_state() {
    unsafe {
        let mut ps: SYSTEM_POWER_STATUS = std::mem::zeroed();
        GetSystemPowerStatus(&mut ps);
        let ac = ps.ACLineStatus as i32;
        let prev = LAST_AC.swap(ac, Ordering::Relaxed);
        if prev != -1 && prev != ac {
            push_event(EV_POWER_SOURCE, ac as i64);
        }
        let no_battery = ps.BatteryFlag & 128 != 0;
        let pct: i32 = if no_battery { -1 } else { ps.BatteryLifePercent as i32 };
        if pct >= 0 {
            let prev_b = LAST_BATT.swap(pct, Ordering::Relaxed);
            if prev_b != -1 && prev_b != pct {
                push_event(EV_BATTERY, pct as i64);
            }
        }
    }
}

fn refresh_wts_state() {
    let locked = unsafe { console_locked_probe() };
    CONSOLE_LOCKED.store(locked as i32, Ordering::Relaxed);
    let session_active = unsafe { WTSGetActiveConsoleSessionId() } != 0xFFFF_FFFF;
    SESSION_ACTIVE.store(session_active as i32, Ordering::Relaxed);
}

unsafe fn handle_power_setting(lparam: isize) {
    if lparam == 0 {
        return;
    }
    let ps = lparam as *const POWERBROADCAST_SETTING;
    debug_assert!(!ps.is_null());
    if guid_eq(&(*ps).PowerSetting, &GUID_MONITOR_POWER_ON) {
        let on: u32 = if (*ps).DataLength >= 4 {
            std::ptr::read_unaligned((*ps).Data.as_ptr() as *const u32)
        } else {
            1
        };
        MONITOR_ON.store(if on != 0 { 1 } else { 0 }, Ordering::Relaxed);
        push_event(EV_MONITOR, on as i64);
    }
}

// ---------------------------------------------------------------------------
// Window procedure + pump thread
// ---------------------------------------------------------------------------

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    match msg {
        WM_POWERBROADCAST => {
            match wparam as u32 {
                PBT_APMSUSPEND => {
                    push_event(EV_SLEEP, 0);
                }
                PBT_APMRESUMEAUTOMATIC => {
                    MONITOR_ON.store(1, Ordering::Relaxed);
                    push_event(EV_RESUME, 0);
                }
                PBT_APMRESUMESUSPEND => {
                    push_event(EV_RESUME, 1);
                }
                PBT_APMPOWERSTATUSCHANGE => {
                    push_event(EV_POWER_SOURCE, 255);
                    refresh_power_state();
                }
                PBT_POWERSETTINGCHANGE => handle_power_setting(lparam),
                _ => {}
            }
            1
        }
        WM_WTSSESSION_CHANGE => {
            match wparam as u32 {
                WTS_SESSION_LOCK => {
                    CONSOLE_LOCKED.store(1, Ordering::Relaxed);
                    push_event(EV_LOCK, 0);
                }
                WTS_SESSION_UNLOCK => {
                    CONSOLE_LOCKED.store(0, Ordering::Relaxed);
                    push_event(EV_UNLOCK, 0);
                }
                WTS_SESSION_LOGOFF => {
                    SESSION_ACTIVE.store(0, Ordering::Relaxed);
                    push_event(EV_SESSION, 0);
                }
                WTS_CONSOLE_CONNECT => {
                    SESSION_ACTIVE.store(1, Ordering::Relaxed);
                    push_event(EV_SESSION, 1);
                }
                WTS_CONSOLE_DISCONNECT => {
                    SESSION_ACTIVE.store(0, Ordering::Relaxed);
                    push_event(EV_SESSION, 0);
                }
                WTS_REMOTE_CONNECT => {
                    push_event(EV_SESSION, 2);
                }
                WTS_REMOTE_DISCONNECT => {
                    push_event(EV_SESSION, 3);
                }
                _ => {}
            }
            0
        }
        WM_DISPLAYCHANGE => {
            push_event(EV_DISPLAY, 0);
            0
        }
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wparam != 0 {
                push_event(EV_SHUTDOWN, 0);
            }
            0
        }
        WM_APP_QUIT => 0,
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn pump_loop() {
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    let mut timeout: u32 = 1200;
    loop {
        if STOP.load(Ordering::SeqCst) {
            break;
        }
        let now_upt = uptime_ms();
        let prev = LAST_WAKE_UPTIME.load(Ordering::Relaxed);
        let expected = LAST_TIMEOUT.load(Ordering::Relaxed) as u64 + 2500;
        if prev > 0 && now_upt.saturating_sub(prev) > expected {
            // The process was frozen: the system slept (or hibernated).
            MONITOR_ON.store(1, Ordering::Relaxed);
            push_event(EV_RESUME, now_upt.saturating_sub(prev) as i64);
            refresh_wts_state();
        }
        LAST_WAKE_UPTIME.store(now_upt, Ordering::Relaxed);
        LAST_TIMEOUT.store(timeout, Ordering::Relaxed);
        refresh_power_state();

        let wr = unsafe {
            MsgWaitForMultipleObjectsEx(0, std::ptr::null(), timeout, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        if wr == WAIT_OBJECT_0 {
            unsafe {
                loop {
                    let has = PeekMessageW(&mut msg, 0, 0, 0, PM_REMOVE);
                    if has == 0 {
                        break;
                    }
                    if msg.message == WM_APP_QUIT {
                        return;
                    }
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            timeout = 300;
        } else if wr == WAIT_TIMEOUT {
            timeout = 1200;
        } else {
            timeout = 1200;
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn pump_thread_main() {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());

        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(wnd_proc);
        wc.hInstance = hinstance;
        wc.lpszClassName = CLS_NAME.as_ptr();
        let _ = RegisterClassW(&wc); // 0 = already registered, tolerated

        let hwnd: isize = CreateWindowExW(
            0,
            CLS_NAME.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            hinstance,
            std::ptr::null(),
        );
        if hwnd == 0 {
            STOPPED.store(true, Ordering::SeqCst);
            RUNNING.store(false, Ordering::SeqCst);
            READY.store(false, Ordering::SeqCst);
            STARTED.store(false, Ordering::SeqCst);
            return;
        }

        // Explicitly create the message queue before advertising readiness.
        let mut dummy: MSG = std::mem::zeroed();
        let _ = PeekMessageW(&mut dummy, 0, 0, 0, PM_NOREMOVE);

        let mut notif: *mut c_void = std::ptr::null_mut();
        let err = PowerSettingRegisterNotification(
            &GUID_MONITOR_POWER_ON,
            DEVICE_NOTIFY_WINDOW_HANDLE,
            hwnd,
            &mut notif,
        );
        let _ = &mut notif;
        if err == 0 {
            POWER_NOTIF.store(notif as isize, Ordering::SeqCst);
        }
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);

        refresh_wts_state();
        refresh_power_state();
        THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
        READY.store(true, Ordering::SeqCst);
        RUNNING.store(true, Ordering::SeqCst);

        pump_loop();

        let pn = POWER_NOTIF.load(Ordering::SeqCst);
        if pn != 0 {
            UnregisterPowerSettingNotification(pn);
        }
        let _ = WTSUnRegisterSessionNotification(hwnd);
        DestroyWindow(hwnd);
        RUNNING.store(false, Ordering::SeqCst);
        STOPPED.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// FFI exports
// ---------------------------------------------------------------------------

/// Start the event pump thread. Returns 1 on success (or if already running).
#[no_mangle]
pub extern "system" fn oneboost_start() -> i32 {
    if RUNNING.load(Ordering::SeqCst) {
        return 1;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return if RUNNING.load(Ordering::SeqCst) { 1 } else { 0 };
    }
    STOP.store(false, Ordering::SeqCst);
    STOPPED.store(false, Ordering::SeqCst);
    READY.store(false, Ordering::SeqCst);
    LAST_WAKE_UPTIME.store(0, Ordering::Relaxed);
    match std::thread::Builder::new()
        .name("oneboost-tracker".into())
        .spawn(pump_thread_main)
    {
        Ok(_) => 1,
        Err(_) => {
            STARTED.store(false, Ordering::SeqCst);
            0
        }
    }
}

/// Stop the pump thread. Safe to call multiple times.
#[no_mangle]
pub extern "system" fn oneboost_shutdown() {
    if !STARTED.load(Ordering::SeqCst) && !RUNNING.load(Ordering::SeqCst) {
        return;
    }
    STOP.store(true, Ordering::SeqCst);
    if READY.load(Ordering::SeqCst) {
        let tid = THREAD_ID.load(Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                PostThreadMessageW(tid, WM_APP_QUIT, 0, 0);
            }
        }
    }
    for _ in 0..80 {
        if STOPPED.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    STARTED.store(false, Ordering::SeqCst);
    READY.store(false, Ordering::SeqCst);
    THREAD_ID.store(0, Ordering::SeqCst);
}

/// Collect one tracking sample. `idle_threshold_ms` of 0 means 45s.
#[no_mangle]
pub extern "system" fn oneboost_collect_once(out: *mut BoostSampleResult, idle_threshold_ms: u32) -> i32 {
    if out.is_null() {
        return 0;
    }
    let r = catch_unwind(AssertUnwindSafe(|| unsafe {
        collect_once_inner(&mut *out, idle_threshold_ms)
    }));
    r.unwrap_or(0)
}

unsafe fn collect_once_inner(out: &mut BoostSampleResult, idle_threshold_ms: u32) -> i32 {
    let mut ps: SYSTEM_POWER_STATUS = std::mem::zeroed();
    GetSystemPowerStatus(&mut ps);

    let mut fg = BoostForegroundApp {
        process_name: [0; 260],
        process_id: 0,
    };
    let hwnd: isize = GetForegroundWindow();
    let has_window = (hwnd != 0) as i32;
    let mut foreground_ok = 0i32;
    if hwnd != 0 && fg_from_window(hwnd, &mut fg) {
        foreground_ok = 1;
    }
    let fullscreen = is_fullscreen_window(hwnd);

    let mut lii = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    let mut idle_ms: u32 = u32::MAX;
    if GetLastInputInfo(&mut lii) != 0 {
        // (GetTickCount64 as u32).wrapping_sub handles the 49.7-day wrap correctly.
        idle_ms = (GetTickCount64() as u32).wrapping_sub(lii.dwTime);
    }

    let screen_on = MONITOR_ON.load(Ordering::Relaxed) != 0;
    let locked = if READY.load(Ordering::SeqCst) {
        CONSOLE_LOCKED.load(Ordering::Relaxed) != 0
    } else {
        console_locked_probe()
    };
    let session_active = SESSION_ACTIVE.load(Ordering::Relaxed) != 0;
    let threshold = if idle_threshold_ms == 0 { 45_000 } else { idle_threshold_ms };
    let input_active = (idle_ms != u32::MAX
        && idle_ms < threshold
        && screen_on
        && !locked
        && session_active
        && foreground_ok == 1) as i32;

    out.uptime_ms = uptime_ms();
    out.now_epoch_ms = now_epoch_ms();
    out.ok = 1;
    out.foreground_ok = foreground_ok;
    out.has_window = has_window;
    out.screen_on = screen_on as i32;
    out.console_locked = locked as i32;
    out.active_session = session_active as i32;
    out.input_active = input_active;
    out.idle_ms = idle_ms;
    out.ac_online = (ps.ACLineStatus == 1) as i32;
    out.battery_pct = ps.BatteryLifePercent;
    out.battery_flag = ps.BatteryFlag;
    out.fg = fg;
    out.is_fullscreen = fullscreen as i32;
    out.battery_remaining_min = if ps.BatteryFlag & 128 != 0
        || ps.ACLineStatus == 1
        || ps.BatteryLifeTime == 0xFFFF_FFFF
        || ps.BatteryLifeTime == 0
    {
        -1
    } else {
        (ps.BatteryLifeTime / 60).min(i32::MAX as u32) as i32
    };
    1
}

/// Drain queued events. Returns number of events written (0 on error).
#[no_mangle]
pub extern "system" fn oneboost_pump_events(
    out: *mut BoostPumpResult,
    buf: *mut BoostEventData,
    cap: u32,
) -> i32 {
    if out.is_null() || (cap > 0 && buf.is_null()) {
        return 0;
    }
    let r = catch_unwind(AssertUnwindSafe(|| unsafe {
        let mut n: u32 = 0;
        if let Ok(mut q) = EVQ.lock() {
            while (n as usize) < cap as usize {
                match q.pop_front() {
                    Some(ev) => {
                        std::ptr::write(buf.add(n as usize), ev);
                        n += 1;
                    }
                    None => break,
                }
            }
        }
        (*out).uptime_ms = uptime_ms();
        (*out).now_epoch_ms = now_epoch_ms();
        (*out).count = n;
        (*out).flushed = (n > 0) as u32;
        (*out).next_poll_ms = 1200;
        n as i32
    }));
    r.unwrap_or(0)
}

/// Idle probe for extra accuracy checks.
#[no_mangle]
pub extern "system" fn oneboost_get_idle_state(out: *mut BoostIdleResult) -> i32 {
    if out.is_null() {
        return 0;
    }
    let r = catch_unwind(AssertUnwindSafe(|| unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        let mut idle_ms: u32 = u32::MAX;
        if GetLastInputInfo(&mut lii) != 0 {
            idle_ms = (GetTickCount64() as u32).wrapping_sub(lii.dwTime);
        }
        (*out).ok = (idle_ms != u32::MAX) as i32;
        (*out).idle_ms = idle_ms;
        (*out).now_epoch_ms = now_epoch_ms();
        1
    }));
    r.unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Layout tests — offsets here are mirrored by DataView code in tracker.ts
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    #[test]
    fn ffi_layouts() {
        assert_eq!(size_of::<BoostForegroundApp>(), 524);
        assert_eq!(offset_of!(BoostForegroundApp, process_name), 0);
        assert_eq!(offset_of!(BoostForegroundApp, process_id), 520);

        assert_eq!(size_of::<BoostSampleResult>(), 592);
        assert_eq!(offset_of!(BoostSampleResult, uptime_ms), 0);
        assert_eq!(offset_of!(BoostSampleResult, now_epoch_ms), 8);
        assert_eq!(offset_of!(BoostSampleResult, ok), 16);
        assert_eq!(offset_of!(BoostSampleResult, foreground_ok), 20);
        assert_eq!(offset_of!(BoostSampleResult, has_window), 24);
        assert_eq!(offset_of!(BoostSampleResult, screen_on), 28);
        assert_eq!(offset_of!(BoostSampleResult, console_locked), 32);
        assert_eq!(offset_of!(BoostSampleResult, active_session), 36);
        assert_eq!(offset_of!(BoostSampleResult, input_active), 40);
        assert_eq!(offset_of!(BoostSampleResult, idle_ms), 44);
        assert_eq!(offset_of!(BoostSampleResult, ac_online), 48);
        assert_eq!(offset_of!(BoostSampleResult, battery_pct), 52);
        assert_eq!(offset_of!(BoostSampleResult, battery_flag), 53);
        assert_eq!(offset_of!(BoostSampleResult, fg), 56);
        assert_eq!(offset_of!(BoostSampleResult, is_fullscreen), 580);
        assert_eq!(offset_of!(BoostSampleResult, battery_remaining_min), 584);

        assert_eq!(size_of::<BoostEventData>(), 24);
        assert_eq!(offset_of!(BoostEventData, value), 0);
        assert_eq!(offset_of!(BoostEventData, now_epoch_ms), 8);
        assert_eq!(offset_of!(BoostEventData, kind), 16);

        assert_eq!(size_of::<BoostPumpResult>(), 32);
        assert_eq!(offset_of!(BoostPumpResult, uptime_ms), 0);
        assert_eq!(offset_of!(BoostPumpResult, now_epoch_ms), 8);
        assert_eq!(offset_of!(BoostPumpResult, count), 16);
        assert_eq!(offset_of!(BoostPumpResult, flushed), 20);
        assert_eq!(offset_of!(BoostPumpResult, next_poll_ms), 24);

        assert_eq!(size_of::<BoostIdleResult>(), 16);
        assert_eq!(offset_of!(BoostIdleResult, ok), 0);
        assert_eq!(offset_of!(BoostIdleResult, idle_ms), 4);
        assert_eq!(offset_of!(BoostIdleResult, now_epoch_ms), 8);
    }
}
