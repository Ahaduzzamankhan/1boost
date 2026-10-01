// Generates the Tauri icon set (src-tauri/icons/) from the official artwork
// in the root icons/ folder (or the procedural fallback), reusing the same
// source-priority logic as make-icons.js. Produces:
//   icon.ico, 32x32.png, 128x128.png, 128x128@2x.png, icon.png
// The tray artwork is separate on purpose — see make-tray-icons.mjs.
// Usage: node scripts/make-tauri-icons.js
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src-tauri', 'icons')
const officialDir = join(root, 'icons')
mkdirSync(outDir, { recursive: true })

// ---- PNG decode (limited): only handle the official PNGs' raw pixel data if
// uncompressed via zlib inflate of IDAT with filters. For simplicity and
// zero-deps reliability, downscaling uses nearest-neighbor on decoded RGBA.

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
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---- minimal PNG decoder (RGBA8, no interlace) ----------------------------
function inflate(data) {
  // node:zlib inflateSync handles zlib-wrapped data.
  return inflateSync(data)
}
import { inflateSync } from 'node:zlib'

function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) return null
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const idats = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idats.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return null
  const bpp = colorType === 6 ? 4 : 3
  let raw
  try {
    raw = inflate(Buffer.concat(idats))
  } catch {
    return null
  }
  const stride = width * bpp
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let rp = 0
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = Buffer.from(line)
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? cur[x - bpp] : 0
      const up = prev[x]
      const ul = x >= bpp ? prev[x - bpp] : 0
      switch (filter) {
        case 1: cur[x] = (cur[x] + left) & 0xff; break
        case 2: cur[x] = (cur[x] + up) & 0xff; break
        case 3: cur[x] = (cur[x] + ((left + up) >> 1)) & 0xff; break
        case 4: cur[x] = (cur[x] + paeth(left, up, ul)) & 0xff; break
      }
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp
      const di = (y * width + x) * 4
      out[di] = cur[si]
      out[di + 1] = cur[si + 1]
      out[di + 2] = cur[si + 2]
      out[di + 3] = bpp === 4 ? cur[si + 3] : 255
    }
    prev = cur
  }
  return { width, height, rgba: out }
}

// ---- official source selection (same priority as make-icons.js) -----------
function pngSize(buf) {
  if (buf.length < 24) return null
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

let officialCache
function officialPngs() {
  if (officialCache) return officialCache
  try {
    officialCache = existsSync(officialDir)
      ? readdirSync(officialDir)
          .filter((f) => f.toLowerCase().endsWith('.png'))
          .map((f) => {
            const buf = readFileSync(join(officialDir, f))
            const size = pngSize(buf)
            if (!size || size.w < 16 || size.h < 16) return null
            return { name: f, buf, ...size }
          })
          .filter(Boolean)
      : []
  } catch {
    officialCache = []
  }
  return officialCache
}

function officialPngFor(target) {
  const files = officialPngs()
  if (files.length === 0) return null
  const exactName = files.find((f) => f.name.toLowerCase() === `icon-${target}x${target}.png`)
  if (exactName && exactName.w === target) return exactName
  const bigEnough = files.filter((f) => f.w >= target && f.h >= target)
  const pool = bigEnough.length > 0 ? bigEnough : files
  pool.sort((a, b) => a.w * a.h - b.w * b.h)
  return bigEnough.length > 0 ? pool[0] : pool[pool.length - 1]
}

// ---- fallback procedural logo (same drawing as make-icons.js) -------------
const TILE_TOP = [250, 173, 20]
const TILE_BOT = [217, 119, 6]

function drawLogo(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const r = size * 0.225
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

// ---- nearest-neighbor downscale to a square target -------------------------
function scaleTo(src, target) {
  if (!src) return drawLogo(target)
  const { width: sw, height: sh, rgba } = src
  const out = Buffer.alloc(target * target * 4)
  for (let y = 0; y < target; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / target))
    for (let x = 0; x < target; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / target))
      const si = (sy * sw + sx) * 4
      const di = (y * target + x) * 4
      out[di] = rgba[si]
      out[di + 1] = rgba[si + 1]
      out[di + 2] = rgba[si + 2]
      out[di + 3] = rgba[si + 3]
    }
  }
  return out
}

// ---- ICO container (PNG-compressed entries, Vista+ shell format) -----------
function icoFromSources(sources) {
  const entries = [...sources.entries()]
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  let offset = 6 + entries.length * 16
  for (const [size, data] of entries) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    dirs.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...dirs, ...entries.map(([, d]) => d)])
}

// ---- build everything ------------------------------------------------------
const best = officialPngFor(1024) ?? officialPngFor(256)
const decoded = best ? decodePng(best.buf) : null

function pngAt(size) {
  return encodePng(size, size, scaleTo(decoded, size))
}

const png256 = pngAt(256)
const png128 = pngAt(128)
const png64 = pngAt(64)
const png32 = pngAt(32)
const png16 = pngAt(16)
const png48 = pngAt(48)

writeFileSync(join(outDir, 'icon.png'), png256)
writeFileSync(join(outDir, '32x32.png'), png32)
writeFileSync(join(outDir, '128x128.png'), png128)
writeFileSync(join(outDir, '128x128@2x.png'), png256)
writeFileSync(join(outDir, 'icon.ico'), icoFromSources(new Map([
  [256, png256],
  [64, png64],
  [48, png48],
  [32, png32],
  [16, png16],
])))

console.log(
  `[icons-tauri] ${best ? `official ${best.name} (${best.w}px)` : 'procedural fallback'} -> src-tauri/icons/`,
)
