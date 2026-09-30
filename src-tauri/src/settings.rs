//! Launch-at-login (HKCU Run key) — port of electron/main/settings.ts.
//! Writes the same value name ("1Boost") in the same key so the preference
//! carries over from the Electron install, and re-asserts on every launch to
//! repair stale paths (including paths pointing at the old Electron exe).

use crate::model::{LaunchState, Prefs};
use std::path::PathBuf;

#[cfg(windows)]
mod win {
    use super::LazyWide;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_READ, KEY_SET_VALUE,
        REG_EXPAND_SZ, REG_SZ,
    };

    pub const REG_SZ_T: u32 = REG_SZ;
    pub const REG_EXPAND_SZ_T: u32 = REG_EXPAND_SZ;

    pub fn open_key(write: bool) -> Option<HKEY> {
        let mut hk: HKEY = 0;
        let access = if write { KEY_SET_VALUE | KEY_READ } else { KEY_QUERY_VALUE | KEY_READ };
        let rc = unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, run_key_wide(), 0, std::ptr::null(), 0, access, std::ptr::null(), &mut hk, std::ptr::null_mut())
        };
        if rc == 0 {
            Some(hk)
        } else {
            None
        }
    }

    pub fn run_key_wide() -> windows_sys::core::PCWSTR {
        RUN_KEY_WIDE.as_ptr()
    }

    pub static RUN_KEY_WIDE: LazyWide = LazyWide::new(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    );
    pub static RUN_VALUE_WIDE: LazyWide = LazyWide::new("1Boost");

    // Fallback open for probing without creating.
    pub fn probe_key() -> Option<HKEY> {
        let mut hk: HKEY = 0;
        let rc = unsafe {
            RegOpenKeyExW(HKEY_CURRENT_USER, run_key_wide(), 0, KEY_READ, &mut hk)
        };
        if rc == 0 {
            Some(hk)
        } else {
            None
        }
    }

    pub use windows_sys::Win32::System::Registry::{
        RegCloseKey as CloseKey, RegDeleteValueW as DeleteValue, RegQueryValueExW as QueryValue,
        RegSetValueExW as SetValue,
    };
}

/// Lazily-encoded static UTF-16 (with trailing NUL) — no per-call allocation
/// after first use. `encode_utf16` can't run in const fn, so the string is
/// stored and encoded once via OnceLock.
struct LazyWide {
    s: &'static str,
    cell: std::sync::OnceLock<Vec<u16>>,
}

impl LazyWide {
    const fn new(s: &'static str) -> LazyWide {
        LazyWide { s, cell: std::sync::OnceLock::new() }
    }
    fn as_ptr(&self) -> *const u16 {
        self.cell
            .get_or_init(|| self.s.encode_utf16().chain(std::iter::once(0)).collect())
            .as_ptr()
    }
}

fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("1Boost.exe"))
}

fn login_args(start_minimized: bool) -> Vec<String> {
    if start_minimized {
        vec!["--hidden".into()]
    } else {
        Vec::new()
    }
}

fn build_command(start_minimized: bool) -> String {
    let exe = exe_path();
    let quoted = format!("\"{}\"", exe.display());
    match login_args(start_minimized).first() {
        Some(arg) => format!("{quoted} {arg}"),
        None => quoted,
    }
}

/// Extract the executable path from a Run-key command (port of exeFromCommand).
fn exe_from_command(command: &str) -> String {
    let trimmed = command.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return match rest.find('"') {
            Some(end) => rest[..end].to_string(),
            None => rest.to_string(),
        };
    }
    match trimmed.find(' ') {
        Some(space) => trimmed[..space].to_string(),
        None => trimmed.to_string(),
    }
}

/// Read the Run key entry for 1Boost, when present (port of readRunEntry).
pub fn read_run_entry() -> Option<(String, String)> {
    #[cfg(not(windows))]
    {
        None
    }
    #[cfg(windows)]
    {
        let hk = win::probe_key()?;
        let mut buf = [0u8; 2048];
        let mut len: u32 = buf.len() as u32;
        let mut kind: u32 = 0;
        let rc = unsafe {
            win::QueryValue(
                hk,
                win::RUN_VALUE_WIDE.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                buf.as_mut_ptr(),
                &mut len,
            )
        };
        unsafe { win::CloseKey(hk) };
        if rc != 0 || (kind != win::REG_SZ_T && kind != win::REG_EXPAND_SZ_T) || len < 2 {
            return None;
        }
        let units: Vec<u16> = buf[..len as usize]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        let command = String::from_utf16_lossy(&units);
        if command.is_empty() {
            None
        } else {
            Some((command.clone(), exe_from_command(&command)))
        }
    }
}

/// Register or unregister the login item. Idempotent; re-asserts desired state.
pub fn set_launch_at_login(enable: bool, start_minimized: bool) -> bool {
    #[cfg(not(windows))]
    {
        let _ = (enable, start_minimized);
        false
    }
    #[cfg(windows)]
    {
        let Some(hk) = win::open_key(true) else { return false };
        let ok = if enable {
            let cmd = build_command(start_minimized);
            let wide = to_wide_vec(&cmd);
            let bytes = wide_bytes(&wide);
            unsafe {
                win::SetValue(
                    hk,
                    win::RUN_VALUE_WIDE.as_ptr(),
                    0,
                    win::REG_SZ_T,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                ) == 0
            }
        } else {
            // Idempotent delete: treat missing value as success.
            unsafe { win::DeleteValue(hk, win::RUN_VALUE_WIDE.as_ptr()) == 0 }
        };
        unsafe { win::CloseKey(hk) };
        ok
    }
}

#[cfg(windows)]
fn to_wide_vec(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn wide_bytes(w: &[u16]) -> Vec<u8> {
    w.iter().flat_map(|u| u.to_le_bytes()).collect()
}

/// Honest probe of the actual Windows login-item state.
pub fn get_launch_at_login_state(prefs: &Prefs) -> LaunchState {
    let enabled = prefs.launch_at_login;
    let me = exe_path();
    match read_run_entry() {
        Some((_command, exe_path)) => {
            let path_matches = same_file(&exe_path, &me);
            LaunchState {
                enabled,
                registered: true,
                path_matches,
                needs_repair: enabled && !path_matches,
                registered_path: Some(exe_path),
            }
        }
        None => LaunchState {
            enabled,
            registered: false,
            path_matches: false,
            needs_repair: enabled,
            registered_path: None,
        },
    }
}

/// Path comparison that tolerates case differences and 8.3/short names.
fn same_file(a: &str, b: &PathBuf) -> bool {
    let bstr = b.to_string_lossy().to_lowercase();
    let al = a.to_lowercase();
    if al == bstr {
        return true;
    }
    // Fall back to canonical comparison when both exist.
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Re-assert the saved preference at startup (repairs stale Electron paths).
pub fn sync_launch_at_login(prefs: &Prefs) -> LaunchState {
    set_launch_at_login(prefs.launch_at_login, prefs.start_minimized);
    let state = get_launch_at_login_state(prefs);
    if prefs.launch_at_login && !state.registered {
        set_launch_at_login(true, prefs.start_minimized);
        return get_launch_at_login_state(prefs);
    }
    state
}
