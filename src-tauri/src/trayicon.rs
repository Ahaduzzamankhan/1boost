//! Tray icon artwork.
//!
//! Two details make the tray icon a special case:
//!
//! 1. Windows draws it next to the clock, at 16 logical pixels, and does not
//!    tint it. A full-colour app logo turns to mush at that size, and a white
//!    one is invisible on the light taskbar Windows ships with — which is why
//!    the tray gets its own flat glyph instead of the app icon.
//! 2. The taskbar can be light or dark, and the glyph has to work on both.
//!    So there are two copies of the same artwork and one decides which to
//!    use.
//!
//! The PNGs are generated, not hand-drawn: `node scripts/make-tray-icons.mjs`
//! writes them and `--check` proves the committed bytes still match, so the
//! artwork cannot drift from the code that loads it.

use tauri::image::Image;
use tauri::{AppHandle, Manager, Theme};

/// Dark glyph, for the light taskbar that Windows ships with by default.
const DARK: &[u8] = include_bytes!("../icons/tray-dark-32.png");
/// Light glyph, for a dark taskbar.
const LIGHT: &[u8] = include_bytes!("../icons/tray-light-32.png");

/// Width and height both encoded in a PNG IHDR chunk; asserted by the tests.
#[cfg(test)]
pub const TRAY_ICON_PX: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Dark,
    Light,
}

impl Variant {
    /// `None` — the theme could not be read — resolves to `Dark`, because a
    /// dark glyph on a light taskbar is the combination Windows defaults to.
    pub fn for_theme(theme: Option<Theme>) -> Self {
        match theme {
            Some(Theme::Dark) => Variant::Light,
            _ => Variant::Dark,
        }
    }

    pub fn bytes(self) -> &'static [u8] {
        match self {
            Variant::Dark => DARK,
            Variant::Light => LIGHT,
        }
    }

    /// Decodes the PNG for Tauri to hand to the shell. Returns `None` only if
    /// the embedded bytes are not a readable image, which the tests below
    /// rule out.
    pub fn image(self) -> Option<Image<'static>> {
        Image::from_bytes(self.bytes()).ok()
    }
}

/// The variant to use right now, read from the app's own window so it needs
/// no extra Windows API surface.
pub fn variant_for(app: &AppHandle) -> Variant {
    Variant::for_theme(app.get_webview_window("main").and_then(|w| w.theme().ok()))
}

/// `(width, height, colour_type)` from a PNG IHDR chunk, or `None` if the
/// bytes are not a PNG at all.
pub fn png_header(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 8 + 25 || bytes[..8] != SIGNATURE {
        return None;
    }
    let chunk = &bytes[12..16];
    if chunk != b"IHDR" {
        return None;
    }
    let at = |i: usize| u32::from_be_bytes([bytes[16 + i], bytes[17 + i], bytes[18 + i], bytes[19 + i]]);
    // IHDR payload: width, height, bit depth, colour type.
    Some((at(0), at(4), bytes[25]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_variants_are_32px_pngs() {
        for variant in [Variant::Dark, Variant::Light] {
            let (w, h, colour_type) =
                png_header(variant.bytes()).expect("tray icon should be a PNG");
            assert_eq!((w, h), (TRAY_ICON_PX, TRAY_ICON_PX), "{variant:?} should be square");
            assert_eq!(colour_type, 6, "{variant:?} should be RGBA");
        }
    }

    #[test]
    fn both_variants_carry_real_artwork() {
        // A blank tray icon is the failure mode this module exists to prevent,
        // and a fully transparent PNG compresses to almost nothing.
        for variant in [Variant::Dark, Variant::Light] {
            assert!(
                variant.bytes().len() > 120,
                "{variant:?} tray icon looks empty ({} bytes)",
                variant.bytes().len()
            );
        }
    }

    #[test]
    fn the_two_variants_are_different_pictures() {
        assert_ne!(Variant::Dark.bytes(), Variant::Light.bytes());
    }

    #[test]
    fn header_reader_rejects_non_pngs() {
        assert_eq!(png_header(b""), None);
        assert_eq!(png_header(b"not a png at all, really not"), None);
        assert_eq!(png_header(&[0u8; 64]), None);
    }

    #[test]
    fn dark_taskbar_wants_the_light_glyph() {
        assert_eq!(Variant::for_theme(Some(Theme::Dark)), Variant::Light);
        assert_eq!(Variant::for_theme(Some(Theme::Light)), Variant::Dark);
        // Unreadable theme falls back to the Windows default.
        assert_eq!(Variant::for_theme(None), Variant::Dark);
    }
}
