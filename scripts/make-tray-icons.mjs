// @ts-check
// Generates the Windows system-tray icons.
//
// The tray is the one place in the app that is drawn by Windows rather than
// by us: it sits on the user's taskbar, next to the clock, at 16 logical
// pixels. A full-colour app logo turns to mush at that size — and a white
// logo vanishes entirely on the light taskbar that Windows 11 ships with.
// So the tray gets its own artwork: one flat glyph, drawn twice, once dark
// for a light taskbar and once light for a dark one, and the right pair is
// picked at runtime (see src-tauri/src/trayicon.rs).
//
// Usage:
//   node scripts/make-tray-icons.mjs          write the PNGs
//   node scripts/make-tray-icons.mjs --check  fail if the committed PNGs differ
import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'src-tauri', 'icons')

/** Windows picks from these depending on the display scale factor. */
export const TRAY_SIZES = [16, 20, 24, 32]

/** Kept in sync with the Rust side by a unit test that reads this list. */
export const TRAY_VARIANTS = /** @type {const} */ (['dark', 'light'])

// --- geometry ---------------------------------------------------------------
// The glyph is a rounded-square badge with a rising bar chart inside: two
// shapes that both survive a 4x downscale, which is the only test that has
// ever really mattered for a tray icon.

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r)
  const qy = Math.abs(py) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** Signed distance to a thick line segment. */
function sdSegment(px, py, ax, ay, bx, by, half) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
  return Math.hypot(wx - vx * t, wy - vy * t) - half
}

/**
 * Coverage of the glyph at a point in [-1, 1] glyph space.
 * @returns {number} 0 = empty, 1 = solid.
 */
function glyphCoverage(x, y) {
  // Badge: a rounded square drawn as a ring (outline, not a fill). The bars
  // live inside it, so the two shapes are combined rather than tested in
  // sequence — the interior of the ring is empty, but not finished.
  const badge = Math.abs(sdRoundRect(x, y, 0.92, 0.92, 0.3)) - 0.13
  if (badge <= 0) return 1

  // Rising bars, normalised so the tallest bar stops short of the ring.
  const barW = 0.2
  const gap = 0.13
  const left = -barW / 2 - gap
  const heights = [0.42, 0.66, 0.9]
  const base = 0.52
  for (let i = 0; i < heights.length; i += 1) {
    const cx = left + i * (barW + gap)
    if (sdRoundRect(x - cx, y - (base - heights[i] / 2), barW / 2, heights[i] / 2, barW / 4) <= 0) {
      return 1
    }
  }
  return 0
}

// --- rasteriser -------------------------------------------------------------

/**
 * Renders one RGBA icon. Coverage is supersampled 4x4 per pixel and kept
 * white so the same glyph serves both the dark and the light variant: only
 * the alpha channel differs, which is what a tray icon actually needs.
 */
export function renderGlyph(size) {
  const ss = 4
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const x = -1 + (px * ss + sx + 0.5) * (2 / (size * ss))
          const y = -1 + (py * ss + sy + 0.5) * (2 / (size * ss))
          if (glyphCoverage(x, y) > 0) hits += 1
        }
      }
      const at = (py * size + px) * 4
      pixels[at] = 255
      pixels[at + 1] = 255
      pixels[at + 2] = 255
      pixels[at + 3] = Math.round((hits / (ss * ss)) * 255)
    }
  }
  return pixels
}

// --- PNG encoding ------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Minimal RGBA8 PNG encoder — enough for a flat tray glyph, no dependency. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One filter byte (0 = None) per scanline keeps the encoder trivial.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 4 + 1)
    raw[at] = 0
    rgba.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Recolours the white glyph for a given taskbar theme. */
export function tint(rgba, variant) {
  const rgb = variant === 'light' ? [0xf2, 0xf4, 0xf8] : [0x12, 0x14, 0x1a]
  const out = Buffer.from(rgba)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = rgb[0]
    out[i + 1] = rgb[1]
    out[i + 2] = rgb[2]
  }
  return out
}

export function trayFileName(variant, size) {
  return `tray-${variant}-${size}.png`
}

export function buildAll() {
  /** @type {Map<string, Buffer>} */
  const files = new Map()
  for (const variant of TRAY_VARIANTS) {
    for (const size of TRAY_SIZES) {
      files.set(trayFileName(variant, size), encodePng(size, tint(renderGlyph(size), variant)))
    }
  }
  return files
}

function main() {
  const check = process.argv.includes('--check')
  const files = buildAll()
  let stale = 0
  for (const [name, bytes] of files) {
    const path = join(OUT_DIR, name)
    if (check) {
      const current = existsSync(path) ? readFileSync(path) : null
      if (!current || !current.equals(bytes)) {
        console.error(`[tray-icons] out of date: ${name}`)
        stale += 1
      }
    } else {
      writeFileSync(path, bytes)
      console.log(`[tray-icons] wrote ${name} (${bytes.length} bytes)`)
    }
  }
  if (check && stale > 0) {
    console.error(`[tray-icons] ${stale} file(s) differ — run: node scripts/make-tray-icons.mjs`)
    process.exit(1)
  }
  if (check) console.log('[tray-icons] all tray icons up to date')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
