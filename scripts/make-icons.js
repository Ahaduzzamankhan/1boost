// Generates resources/icons/icon.ico + tray.ico.
//
// Source priority:
//   1. Official artwork: any *.png dropped in the repo-root `icons/` folder
//      (the largest file wins). The PNG is embedded PNG-compressed inside the
//      ICO container (Vista+ shell format, standard for 256px icons) — no
//      pixel decoding required, so the official art is used byte-for-byte.
//   2. Fallback: the procedural 1Boost mark (amber rounded tile + bolt) drawn
//      here with the zero-dependency PNG encoder below, so `npm run build`
//      always succeeds even without official assets.
//
// Usage: node scripts/make-icons.js
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'icons')
const officialDir = join(root, 'icons')
mkdirSync(outDir, { recursive: true })

// ---------- minimal PNG encoder (fallback logo) ----------
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------- logo drawing (fallback) ----------
// Rounded-rect tile + lightning bolt in the app's amber accent (#f59e0b).
const TILE_TOP = [250, 173, 20]
const TILE_BOT = [217, 119, 6]

function drawLogo(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const r = size * 0.225 // corner radius
  const bolt = [
    [0.58, 0.06], [0.3, 0.56], [0.48, 0.56], [0.42, 0.94],
    [0.72, 0.4], [0.53, 0.4],
  ]
  const insideTile = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false
    const nx = Math.min(Math.max(x, r), size - r)
    const ny = Math.min(Math.max(y, r), size - r)
    const dx = x - nx
    const dy = y - ny
    return dx * dx + dy * dy <= r * r
  }
  const pointInPoly = (px, py, poly) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0] * size
      const yi = poly[i][1] * size
      const xj = poly[j][0] * size
      const yj = poly[j][1] * size
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!insideTile(x + 0.5, y + 0.5)) {
        rgba[i + 3] = 0
        continue
      }
      const t = y / size
      const c = [
        Math.round(TILE_TOP[0] + (TILE_BOT[0] - TILE_TOP[0]) * t),
        Math.round(TILE_TOP[1] + (TILE_BOT[1] - TILE_TOP[1]) * t),
        Math.round(TILE_TOP[2] + (TILE_BOT[2] - TILE_TOP[2]) * t),
      ]
      if (pointInPoly(x + 0.5, y + 0.5, bolt)) {
        rgba[i] = 255
        rgba[i + 1] = 255
        rgba[i + 2] = 255
        rgba[i + 3] = 255
      } else {
        rgba[i] = c[0]
        rgba[i + 1] = c[1]
        rgba[i + 2] = c[2]
        rgba[i + 3] = 255
      }
    }
  }
  return rgba
}

function pngFor(size) {
  return encodePng(size, size, drawLogo(size))
}

// ---------- official PNG source ----------
/**
 * Read a PNG's pixel dimensions from its IHDR chunk (bytes 16..24) — no
 * image decoding library needed. Returns null for non-PNG/broken files.
 */
function pngSize(buf) {
  if (buf.length < 24) return null
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/**
 * Largest usable PNG in the root `icons/` folder (official artwork).
 * Prefers a square image; falls back to the largest file of any shape.
 */
function officialPng() {
  try {
    const files = readdirSync(officialDir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => {
        const p = join(officialDir, f)
        const buf = readFileSync(p)
        const size = pngSize(buf)
        if (!size || size.w < 64) return null
        return { p, buf, ...size, area: size.w * size.h }
      })
      .filter(Boolean)
    if (files.length === 0) return null
    files.sort((a, b) => b.area - a.area)
    const square = files.find((f) => f.w === f.h)
    return square ?? files[0]
  } catch {
    return null
  }
}

// ---------- ICO container ----------
/**
 * Build the ICO. `sources` maps requested icon sizes to PNG bytes; every
 * entry >= 128 must be a PNG-compressed image (Vista+ shell requirement),
 * smaller entries may be PNG as well — Windows 10/11 handle it fine.
 */
function icoFromSources(sources) {
  const entries = [...sources.entries()] // [size, Buffer]
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  let offset = 6 + entries.length * 16
  for (const [size, data] of entries) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // palette
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    dirs.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...dirs, ...entries.map(([, d]) => d)])
}

const official = officialPng()
if (official) {
  const art = official.buf
  writeFileSync(join(outDir, 'icon.ico'), icoFromSources(new Map([[256, art]])))
  writeFileSync(join(outDir, 'tray.ico'), icoFromSources(new Map([[32, art]])))
  console.log(`[icons] using official PNG (${official.w}x${official.h}) -> icon.ico + tray.ico`)
} else {
  writeFileSync(join(outDir, 'icon.ico'), icoFromSources(new Map([
    [256, pngFor(256)],
    [64, pngFor(64)],
    [48, pngFor(48)],
    [32, pngFor(32)],
    [16, pngFor(16)],
  ])))
  writeFileSync(join(outDir, 'tray.ico'), icoFromSources(new Map([[32, pngFor(32)], [16, pngFor(16)]])))
  console.log('[icons] generated procedural logo -> icon.ico + tray.ico')
}
