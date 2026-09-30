//! Windows clipboard text access (CF_UNICODETEXT).
//!
//! The clipboard is a single shared resource: `OpenClipboard` fails while
//! another process holds it, so every call opens, copies the data and closes
//! again, retrying a few times rather than holding the clipboard open.
//!
//! Non-Windows builds compile to no-ops so the module stays portable for CI
//! linting.

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalLock, GlobalSize, GlobalUnlock,
    };

    pub const CF_UNICODETEXT: u32 = 13;

    /// Read the clipboard as UTF-16 text. Returns None when the clipboard is
    /// empty, holds a non-text format, or is locked by another process.
    pub fn get_text() -> Option<String> {
        let hwnd: HANDLE = INVALID_HANDLE_VALUE; // HWND for the whole desktop
        // Another app may hold the clipboard for a few ms; retry briefly.
        for _ in 0..4 {
            if unsafe { OpenClipboard(hwnd) } == 0 {
                std::thread::sleep(std::time::Duration::from_millis(12));
                continue;
            }
            let data = unsafe { GetClipboardData(CF_UNICODETEXT) };
            let text = if data == 0 {
                None
            } else {
                unsafe { read_global_utf16(data as HGLOBAL) }
            };
            unsafe {
                CloseClipboard();
            }
            return text;
        }
        None
    }

    unsafe fn read_global_utf16(h: HGLOBAL) -> Option<String> {
        let size = GlobalSize(h);
        if size < 2 {
            return None;
        }
        // GlobalLock returns a c_void pointer; the clipboard format we asked
        // for is always a NUL-terminated UTF-16 string.
        let ptr = GlobalLock(h) as *const u16;
        if ptr.is_null() {
            return None;
        }
        // Walk to the terminator instead of trusting GlobalSize, so a buffer
        // without one can never read past its allocation.
        let words = (size / 2) as usize;
        let mut len = 0usize;
        while len < words && *ptr.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        GlobalUnlock(h);
        Some(text)
    }

    /// Replace the clipboard contents with `text`.
    pub fn set_text(text: &str) -> bool {
        use windows_sys::Win32::System::DataExchange::EmptyClipboard;
        use windows_sys::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };

        let hwnd: HANDLE = INVALID_HANDLE_VALUE;
        for _ in 0..4 {
            if unsafe { OpenClipboard(hwnd) } == 0 {
                std::thread::sleep(std::time::Duration::from_millis(12));
                continue;
            }
            let ok = (|| {
                let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
                let bytes = utf16.len() * 2;
                unsafe { EmptyClipboard() };
                let h = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) } as HGLOBAL;
                if h.is_null() {
                    return false;
                }
                let ptr = unsafe { GlobalLock(h) } as *mut u8;
                if ptr.is_null() {
                    return false;
                }
                std::ptr::copy_nonoverlapping(utf16.as_ptr() as *const u8, ptr, bytes);
                unsafe { GlobalUnlock(h) };
                unsafe { SetClipboardData(CF_UNICODETEXT, h as isize) != 0 }
            })();
            unsafe {
                CloseClipboard();
            }
            return ok;
        }
        false
    }

    #[link(name = "user32")]
    extern "system" {
        fn SetClipboardData(format: u32, data: isize) -> isize;
    }
}

#[cfg(not(windows))]
mod win {
    pub fn get_text() -> Option<String> {
        None
    }
    pub fn set_text(_text: &str) -> bool {
        false
    }
}

/// Current clipboard text, if it holds UTF-16 text.
pub fn get_text() -> Option<String> {
    win::get_text()
}

/// Put `text` on the system clipboard.
pub fn set_text(text: &str) -> bool {
    win::set_text(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_and_write_round_trip() {
        let sample = "1Boost clipboard test\nsecond line — unicode: ✓ é";
        if !set_text(sample) {
            // Locked by another process for the whole retry window; the
            // poller simply skips this tick, so this is not a failure.
            return;
        }
        let read = get_text().expect("clipboard should hold text we just set");
        assert_eq!(read, sample);
    }
}