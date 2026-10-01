// @ts-check
// Tray icon: one tray, legible artwork, and no config tray fighting the Rust
// one for the same id.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAll, encodePng, renderGlyph, tint, trayFileName, TRAY_SIZES, TRAY_VARIANTS } from '../scripts/make-tray-icons.mjs'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const config = JSON.parse(read('src-tauri/tauri.conf.json'))

/** `(width, height, colour type)` out of a PNG's IHDR. */
function header(bytes: Buffer) {
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25] }
}

/** Fraction of pixels with any alpha — a blank icon scores ~0. */
function ink(bytes: Buffer, size: number) {
  let hits = 0
  for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 40) hits += 1
  return hits / (size * size)
}

describe('tray artwork', () => {
  it('renders a 16px glyph that is actually visible', () => {
    expect(ink(renderGlyph(16), 16)).toBeGreaterThan(0.2)
  })

  it('renders the same shape at every tray size', () => {
    for (const size of TRAY_SIZES) {
      expect(ink(renderGlyph(size), size)).toBeGreaterThan(0.15)
    }
  })

  it('encodes a readable PNG header', () => {
    for (const size of TRAY_SIZES) {
      expect(header(encodePng(size, renderGlyph(size)))).toEqual({
        width: size,
        height: size,
        colourType: 6,
      })
    }
  })

  it('rejects nothing about itself: the encoder is deterministic', () => {
    expect(encodePng(16, renderGlyph(16))).toEqual(encodePng(16, renderGlyph(16)))
  })

  it('keeps the two variants distinguishable', () => {
    const dark = tint(renderGlyph(16), 'dark')
    const light = tint(renderGlyph(16), 'light')
    expect(dark).not.toEqual(light)
    // Alpha — the part Windows actually reads — must be identical.
    for (let i = 3; i < dark.length; i += 4) expect(dark[i]).toBe(light[i])
  })
})

describe('committed tray icons', () => {
  const built = buildAll()

  it('ships every generated size, byte for byte', () => {
    for (const [name, bytes] of built) {
      const path = join(root, 'src-tauri', 'icons', name)
      expect(existsSync(path), `${name} is missing`).toBe(true)
      expect(readFileSync(path).equals(bytes), `${name} is stale — run npm run icons:tray`).toBe(true)
    }
  })

  it('leaves the icon the old tray used behind deleted', () => {
    // It was a copy of 32x32.png, which is what produced the unreadable
    // smear in the notification area.
    expect(existsSync(join(root, 'src-tauri', 'icons', 'tray.png'))).toBe(false)
  })

  it('covers both taskbar themes at the size the shell scales from', () => {
    for (const variant of TRAY_VARIANTS) {
      const path = join(root, 'src-tauri', 'icons', trayFileName(variant, 32))
      expect(header(readFileSync(path))).toEqual({ width: 32, height: 32, colourType: 6 })
    }
  })
})

describe('one tray, owned by Rust', () => {
  it('does not declare app.trayIcon in the Tauri config', () => {
    // A config tray is built before `setup` runs and takes the main-tray id,
    // so setup_tray found it, returned early, and the user got a menu-less
    // icon. The Rust side is now the only owner.
    expect(config.app.trayIcon).toBeUndefined()
    expect(read('src-tauri/tauri.conf.json')).not.toContain('tray.png')
  })

  it('builds the tray with a menu, a tooltip and an explicit icon', () => {
    const lib = read('src-tauri/src/lib.rs')
    expect(lib).toMatch(/pub fn setup_tray[\s\S]*?\.menu\(&menu\)/)
    expect(lib).toMatch(/pub fn setup_tray[\s\S]*?\.tooltip\(tray_tooltip/)
    expect(lib).toMatch(/pub fn setup_tray[\s\S]*?builder\.icon\(icon\)/)
    // A bare `default_window_icon()` was the only icon the tray ever had,
    // and it is absent whenever the window has none.
    expect(lib).not.toContain('if let Some(icon) = app.default_window_icon()')
  })

  it('pins the tray id to one constant everywhere', () => {
    const lib = read('src-tauri/src/lib.rs')
    expect(lib).toContain('const TRAY_ID: &str = "main-tray"')
    expect(lib).not.toContain('tray_by_id("main-tray")')
  })

  it('picks the glyph from the OS theme', () => {
    const trayicon = read('src-tauri/src/trayicon.rs')
    expect(trayicon).toMatch(/Some\(Theme::Dark\) => Variant::Light/)
    // Unreadable theme must land on the light-taskbar glyph, not a guess.
    expect(trayicon).toMatch(/_ => Variant::Dark/)
  })

  it('does not let a poisoned mutex kill the tray menu', () => {
    const lib = read('src-tauri/src/lib.rs')
    const update = lib.slice(lib.indexOf('fn update_tray_state'), lib.indexOf('fn build_tray_menu'))
    expect(update).toContain('unwrap_or_else(|e| e.into_inner())')
    expect(update).not.toContain('.lock().unwrap()')
  })
})
