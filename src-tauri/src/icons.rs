//! Executable icon extraction (32×32 PNG data URLs) — replaces Electron's
//! app.getFileIcon. Uses SHGetFileInfoW for the HICON, then GetDIBits to
//! BGRA, and encodes a PNG in-process (tiny encoder, no image crate).

const WIDTH: i32 = 32;
const HEIGHT: i32 = 32;

#[repr(C)]
#[derive(Clone, Copy)]
struct IconInfoW {
    f_icon: i32,
    x_hotspot: u32,
    y_hotspot: u32,
    hbm_mask: isize,
    hbm_color: isize,
}

#[repr(C)]
struct BitmapInfoHeader {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[repr(C)]
struct BitmapInfo {
    bmi_header: BitmapInfoHeader,
    bmi_colors: [u32; 1],
}

#[link(name = "shell32")]
extern "system" {
    fn SHGetFileInfoW(path: *const u16, attrs: u32, psfi: *mut ShFileInfo, cbfi: u32, flags: u32) -> isize;
}

#[link(name = "user32")]
extern "system" {
    fn GetIconInfo(hicon: isize, piconinfo: *mut IconInfoW) -> i32;
    fn GetDC(hwnd: isize) -> isize;
    fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
    fn DestroyIcon(hicon: isize) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
    fn DeleteObject(obj: isize) -> i32;
    fn GetDIBits(hdc: isize, hbmp: isize, start: u32, lines: u32, bits: *mut u8, bi: *mut BitmapInfo, usage: u32) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn lstrlenW(s: *const u16) -> i32;
}

#[repr(C)]
struct ShFileInfo {
    h_icon: isize,
    i_icon: i32,
    dw_attributes: u32,
    sz_display_name: [u16; 260],
    sz_type_name: [u16; 80],
}

const SHGFI_ICON: u32 = 0x100;
const SHGFI_LARGEICON: u32 = 0x0;
const SHGFI_SMALLICON: u32 = 0x1;
const BI_RGB: u32 = 0;
const DIB_RGB_COLORS: u32 = 0;

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Extract a 32×32 PNG data URL for an executable path. Returns None for
/// non-exe paths or when extraction fails (same as the Electron version).
pub fn extract_icon_png_data_url(exe_path: &str) -> Option<String> {
    if exe_path.is_empty() || !exe_path.to_lowercase().ends_with(".exe") {
        return None;
    }
    unsafe {
        let wide = to_wide(exe_path);
        let mut sfi: ShFileInfo = std::mem::zeroed();
        let rc = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut sfi,
            std::mem::size_of::<ShFileInfo>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if rc == 0 || sfi.h_icon == 0 {
            return None;
        }
        let result = hicon_to_png_data_url(sfi.h_icon);
        DestroyIcon(sfi.h_icon);
        result
    }
}

unsafe fn hicon_to_png_data_url(hicon: isize) -> Option<String> {
    let mut ii: IconInfoW = std::mem::zeroed();
    if GetIconInfo(hicon, &mut ii) == 0 {
        return None;
    }
    let bmp = ii.hbm_color;
    if bmp == 0 {
        if ii.hbm_mask != 0 {
            DeleteObject(ii.hbm_mask);
        }
        return None;
    }
    let hdc_screen = GetDC(0);
    let hdc = CreateCompatibleDC(hdc_screen);
    let mut bi: BitmapInfo = std::mem::zeroed();
    bi.bmi_header.bi_size = std::mem::size_of::<BitmapInfoHeader>() as u32;
    bi.bmi_header.bi_width = WIDTH;
    bi.bmi_header.bi_height = -HEIGHT; // top-down
    bi.bmi_header.bi_planes = 1;
    bi.bmi_header.bi_bit_count = 32;
    bi.bmi_header.bi_compression = BI_RGB;

    let mut pixels = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
    let mut ok = false;
    if GetDIBits(hdc, bmp, 0, HEIGHT as u32, pixels.as_mut_ptr(), &mut bi, DIB_RGB_COLORS) != 0 {
        ok = true;
        // BGRA → RGBA.
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
    }
    DeleteDC(hdc);
    ReleaseDC(0, hdc_screen);
    DeleteObject(bmp);
    if ii.hbm_mask != 0 {
        DeleteObject(ii.hbm_mask);
    }
    if !ok {
        return None;
    }
    let png = encode_png(WIDTH as u32, HEIGHT as u32, &pixels);
    Some(format!("data:image/png;base64,{}", base64_encode(&png)))
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (deflate stored blocks) + base64 — no external crates.
// ---------------------------------------------------------------------------

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn crc32(buf: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, e) in t.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *e = c;
        }
        t
    });
    let mut crc: u32 = !0;
    for &byte in buf {
        crc = (crc >> 8) ^ table[((crc ^ byte as u32) & 0xff) as usize];
    }
    !crc
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out.extend_from_slice(&body);
}

/// PNG with stored (uncompressed) deflate blocks — valid, simple, tiny input.
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width * 4 + 1) as usize * height as usize);
    for y in 0..height {
        raw.push(0); // filter: none
        let start = (y * width * 4) as usize;
        raw.extend_from_slice(&rgba[start..start + (width * 4) as usize]);
    }
    // zlib header + stored deflate blocks.
    let mut z = vec![0x78, 0x01];
    let mut pos = 0;
    while pos < raw.len() {
        let n = (raw.len() - pos).min(65535);
        let last = pos + n >= raw.len();
        z.push(if last { 1 } else { 0 });
        z.extend_from_slice(&(n as u16).to_le_bytes());
        z.extend_from_slice(&(!(n as u16)).to_le_bytes());
        z.extend_from_slice(&raw[pos..pos + n]);
        pos += n;
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // RGBA
    ihdr.extend_from_slice(&[0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}
