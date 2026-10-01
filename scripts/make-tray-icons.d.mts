// Types for make-tray-icons.mjs, which is plain JavaScript so it can run in CI
// with `node` and no build step.

/** Windows picks from these depending on the display scale factor. */
export const TRAY_SIZES: readonly number[]
/** Kept in sync with the Rust side by a unit test that reads this list. */
export const TRAY_VARIANTS: readonly ['dark', 'light']

/** RGBA coverage mask for a glyph: white with the shape in the alpha channel. */
export function renderGlyph(size: number): Buffer
/** Minimal RGBA8 PNG encoder — enough for a flat tray glyph. */
export function encodePng(size: number, rgba: Buffer): Buffer
/** Recolours the white glyph for a given taskbar theme. */
export function tint(rgba: Buffer, variant: 'dark' | 'light'): Buffer
export function trayFileName(variant: 'dark' | 'light', size: number): string
/** Every tray PNG the generator writes, keyed by file name. */
export function buildAll(): Map<string, Buffer>
