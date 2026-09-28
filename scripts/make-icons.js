// Generates resources/icons/icon.ico (256/64/48/32/16) and tray.ico from a
// procedurally drawn logo using pure JS PNG + ICO encoding (no dependencies).
// Usage: node scripts/make-icons.js
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'icons')
mkdirSync(outDir, { recursive: true })

// ---------- minimal PNG encoder ----------
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

// ---------- logo drawing ----------
// Rounded-rect tile + lightning bolt, accent blue (#3b82f6 → #2563eb).
const ACCENT_TOP = [59, 130, 246]
const ACCENT_BOT = [37, 99, 235]

function drawLogo(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const r = size * 0.225 // corner radius
  const bolt = [
    [0.56, 0.08], [0.30, 0.55], [0.47, 0.55], [0.40, 0.92],
    [0.70, 0.42], [0.52, 0.42],
  ]
  const inRounded = (x, y) => {
    const rad = r
    const cx = Math.min(Math.max(x, rad), size - rad)
    const cy = Math.min(Math.max(y, rad), size - rad)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= rad * rad || (x >= rad && x <= size - rad) || (y >= rad && y <= size - rad)
      ? (x >= rad && x <= size - rad) || (y >= rad && y <= size - rad)
        ? true
        : true
      : false
  }
  const insideTile = (x, y) => {
    // proper rounded-rect coverage test
    const x0 = 0, y0 = 0, x1 = size, y1 = size
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
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
        Math.round(ACCENT_TOP[0] + (ACCENT_BOT[0] - ACCENT_TOP[0]) * t),
        Math.round(ACCENT_TOP[1] + (ACCENT_BOT[1] - ACCENT_TOP[1]) * t),
        Math.round(ACCENT_TOP[2] + (ACCENT_BOT[2] - ACCENT_TOP[2]) * t),
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

// ---------- ICO container ----------
function icoFromPngs(sizes) {
  const pngs = sizes.map((s) => ({ size: s, data: pngFor(s) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

writeFileSync(join(outDir, 'icon.ico'), icoFromPngs([256, 64, 48, 32, 16]))
// Tray: same mark; Windows tray shows 16x16.
writeFileSync(join(outDir, 'tray.ico'), icoFromPngs([32, 16]))
console.log('[icons] wrote icon.ico + tray.ico ->', outDir)
