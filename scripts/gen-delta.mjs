// Binary delta generator for 1Boost auto-updates.
//
//   node scripts/gen-delta.mjs <base-file> <target-file> <out-file>
//
// Produces a `.1bdelta` patch that turns the base artifact (the updater
// payload the running install already has cached) into the target artifact.
// The format is a flat copy/add instruction stream:
//
//   offset  size  field
//   0       4     magic "1BD1"
//   4       1     format version (1)
//   5       1     flags, reserved, always 0
//   6       2     reserved, always 0
//   8       32    sha256 of the base file
//   40      32    sha256 of the target file
//   72      8     base length in bytes (u64)
//   80      8     target length in bytes (u64)
//   88      4     instruction count (u32)
//   92      ...   instructions
//
//   0x01 COPY  base_offset u64, length u32
//   0x02 ADD   length u32, literal bytes
//
// Both hashes are little-endian, as are every length and offset. The client
// re-checks the base hash before patching and the target hash afterwards, so a
// corrupt patch can only ever produce "reject and fall back", never a bad
// install.
//
// Matching is rsync-style: a rolling 32-bit hash over a 64-byte window scans
// the target while a hash index over the base proposes candidates, each of
// which is confirmed with a full byte compare. The window rolls one byte at a
// time so that insertions in the target do not break alignment, which is what
// makes the patch small for binaries that only differ in a few places.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MAGIC = Buffer.from('1BD1', 'ascii')
export const FORMAT_VERSION = 1
export const HEADER_SIZE = 92
export const OP_COPY = 0x01
export const OP_ADD = 0x02

const WINDOW = 64
const INDEX_STRIDE = 16
const MAX_CANDIDATES = 8
const POLY = 0x01000193 // FNV prime; odd, so it is invertible mod 2^32.
const UINT32 = 0x100000000

/** POLY^(WINDOW-1) mod 2^32. */
const POW_HIGH = (() => {
  let p = 1
  for (let i = 0; i < WINDOW - 1; i += 1) p = Math.imul(p, POLY) >>> 0
  return p
})()

/** Multiplicative inverse of an odd number mod 2^32 (Newton iteration). */
function inverse32(a) {
  let x = a >>> 0
  for (let i = 0; i < 5; i += 1) x = Math.imul(x, (2 - Math.imul(a, x)) | 0) >>> 0
  return x >>> 0
}

const POLY_INV = inverse32(POLY)

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest()
}

/** Hash of the WINDOW bytes starting at `at`. */
function hashAt(buf, at) {
  let h = 0
  for (let i = 0; i < WINDOW; i += 1) h = (Math.imul(h, POLY) + buf[at + i]) >>> 0
  return h
}

/** One-byte window roll: drop `out`, append `in`. */
function roll(h, out, inByte) {
  const stripped = (h - Math.imul(out, POW_HIGH)) | 0
  return (Math.imul(stripped, POLY_INV) + inByte) >>> 0
}

function buildIndex(base) {
  const index = new Map()
  const limit = base.length - WINDOW
  for (let p = 0; p <= limit; p += INDEX_STRIDE) {
    const h = hashAt(base, p)
    const bucket = index.get(h)
    if (bucket === undefined) index.set(h, [p])
    else if (bucket.length < MAX_CANDIDATES) bucket.push(p)
  }
  return index
}

/**
 * Builds the instruction list. Exported so the tests can assert the shape of
 * the patch rather than only its bytes.
 */
export function buildOps(base, target) {
  const index = buildIndex(base)
  const ops = []
  let literalFrom = 0
  let pos = 0

  const flushLiteral = (to) => {
    if (to <= literalFrom) return
    ops.push({ kind: OP_ADD, data: target.subarray(literalFrom, to) })
    literalFrom = to
  }

  while (pos + WINDOW <= target.length) {
    const candidates = index.get(hashAt(target, pos))
    let matched = -1
    if (candidates !== undefined) {
      for (const c of candidates) {
        if (base.compare(target, pos, pos + WINDOW, c, c + WINDOW) === 0) {
          matched = c
          break
        }
      }
    }
    if (matched === -1) {
      pos += 1
      continue
    }
    // Grow the match while the bytes keep lining up, so one long identical run
    // becomes a single COPY instead of a chain of 64-byte ones.
    let len = WINDOW
    while (
      pos + len < target.length &&
      base[matched + len] === target[pos + len] &&
      matched + len < base.length
    ) {
      len += 1
    }
    flushLiteral(pos)
    ops.push({ kind: OP_COPY, offset: matched, length: len })
    pos += len
    literalFrom = pos
  }
  flushLiteral(target.length)
  return ops
}

function encodeOps(ops) {
  const size = ops.reduce(
    (total, op) => total + (op.kind === OP_COPY ? 13 : 5 + op.data.length),
    0,
  )
  const out = Buffer.allocUnsafe(size)
  let at = 0
  for (const op of ops) {
    out[at] = op.kind
    at += 1
    if (op.kind === OP_COPY) {
      out.writeBigUInt64LE(BigInt(op.offset), at)
      at += 8
      out.writeUInt32LE(op.length, at)
      at += 4
    } else {
      out.writeUInt32LE(op.data.length, at)
      at += 4
      op.data.copy(out, at)
      at += op.data.length
    }
  }
  return out
}

/** Reference applier, used by the tests to prove the Rust client agrees. */
export function applyDelta(base, patch) {
  if (patch.subarray(0, 4).compare(MAGIC) !== 0) throw new Error('bad magic')
  if (patch[4] !== FORMAT_VERSION) throw new Error('unsupported version')
  const targetLen = Number(patch.readBigUInt64LE(80))
  const opCount = patch.readUInt32LE(88)
  let at = HEADER_SIZE
  const out = Buffer.allocUnsafe(targetLen)
  let cursor = 0
  for (let i = 0; i < opCount; i += 1) {
    const kind = patch[at]
    at += 1
    if (kind === OP_COPY) {
      const offset = Number(patch.readBigUInt64LE(at))
      at += 8
      const length = patch.readUInt32LE(at)
      at += 4
      base.copy(out, cursor, offset, offset + length)
      cursor += length
    } else {
      const length = patch.readUInt32LE(at)
      at += 4
      patch.copy(out, cursor, at, at + length)
      at += length
      cursor += length
    }
  }
  if (at !== patch.length) throw new Error('trailing bytes')
  return out
}

export function buildDelta(base, target) {
  if (base.length > 0xffffffff || target.length > 0xffffffff) {
    throw new Error('delta format is limited to 4 GiB artifacts')
  }
  const ops = buildOps(base, target)
  const header = Buffer.alloc(HEADER_SIZE)
  MAGIC.copy(header, 0)
  header[4] = FORMAT_VERSION
  header[5] = 0
  header[6] = 0
  header[7] = 0
  sha256(base).copy(header, 8)
  sha256(target).copy(header, 40)
  header.writeBigUInt64LE(BigInt(base.length), 72)
  header.writeBigUInt64LE(BigInt(target.length), 80)
  header.writeUInt32LE(ops.length, 88)
  const body = encodeOps(ops)
  return { patch: Buffer.concat([header, body]), ops, literal: body.length }
}

function main(argv) {
  if (argv.length !== 3) {
    console.error('usage: node scripts/gen-delta.mjs <base-file> <target-file> <out-file>')
    return 1
  }
  const [basePath, targetPath, outPath] = argv
  const base = readFileSync(basePath)
  const target = readFileSync(targetPath)
  const { patch, ops, literal } = buildDelta(base, target)

  // Never ship a "delta" that is bigger than the artifact it replaces: the
  // client is better off taking the full download in that case.
  if (patch.length >= target.length) {
    console.log(
      `::warning::delta from ${basePath} would be ${patch.length} bytes, not smaller than the ${target.length} byte payload; skipping it`,
    )
    return 2
  }

  const rebuilt = applyDelta(base, patch)
  if (rebuilt.compare(target) !== 0) {
    console.error('::error::generated delta does not reproduce the target artifact')
    return 1
  }

  writeFileSync(outPath, patch)
  const saved = ((1 - patch.length / target.length) * 100).toFixed(1)
  console.log(
    `delta ${base.length} -> ${target.length} bytes: ${ops.length} ops, ${patch.length} bytes (${saved}% smaller)`,
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)) ?? 0)
}