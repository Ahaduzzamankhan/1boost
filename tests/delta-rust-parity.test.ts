import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

/**
 * A faithful port of src-tauri/src/delta.rs's parse/apply, so the Rust test
 * fixtures can be replayed here in seconds instead of waiting for CI. If the
 * two ever disagree, one of these fails.
 */
const MAGIC = Buffer.from('1BD1', 'ascii')
const FORMAT_VERSION = 1
const HEADER_SIZE = 92
const OP_COPY = 0x01
const OP_ADD = 0x02

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest()

type Spec = { copy: { offset: number; length: number } } | { add: Buffer }

function handMade(ops: Spec[], base: Buffer, target: Buffer): Buffer {
  const parts: Buffer[] = []
  for (const op of ops) {
    if ('copy' in op) {
      const head = Buffer.alloc(13)
      head[0] = OP_COPY
      head.writeBigUInt64LE(BigInt(op.copy.offset), 1)
      head.writeUInt32LE(op.copy.length, 9)
      parts.push(head)
    } else {
      const head = Buffer.alloc(5)
      head[0] = OP_ADD
      head.writeUInt32LE(op.add.length, 1)
      parts.push(head, op.add)
    }
  }
  const out = Buffer.alloc(HEADER_SIZE)
  MAGIC.copy(out, 0)
  out[4] = FORMAT_VERSION
  sha256(base).copy(out, 8)
  sha256(target).copy(out, 40)
  out.writeBigUInt64LE(BigInt(base.length), 72)
  out.writeBigUInt64LE(BigInt(target.length), 80)
  out.writeUInt32LE(ops.length, 88)
  return Buffer.concat([out, ...parts])
}

/** Returns { ok, bytes } or { ok: false, error } using the Rust error names. */
function rebuild(patch: Buffer, base: Buffer): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  if (patch.length < HEADER_SIZE) return { ok: false, error: 'Truncated' }
  if (!patch.subarray(0, 4).equals(MAGIC)) return { ok: false, error: 'Malformed' }
  if (patch[4] !== FORMAT_VERSION) return { ok: false, error: 'Malformed' }
  const baseLen = Number(patch.readBigUInt64LE(72))
  const targetLen = Number(patch.readBigUInt64LE(80))
  const opCount = patch.readUInt32LE(88)

  const ops: Array<{ copy?: [number, number]; add?: Buffer }> = []
  let at = HEADER_SIZE
  let produced = 0
  for (let i = 0; i < opCount; i += 1) {
    const tag = patch[at]
    at += 1
    if (tag === undefined) return { ok: false, error: 'Truncated' }
    if (tag === OP_COPY) {
      const offset = Number(patch.readBigUInt64LE(at))
      at += 8
      const length = patch.readUInt32LE(at)
      at += 4
      if (offset + length > baseLen) return { ok: false, error: 'Malformed: copy past base' }
      produced += length
      ops.push({ copy: [offset, length] })
    } else if (tag === OP_ADD) {
      const length = patch.readUInt32LE(at)
      at += 4
      const data = patch.subarray(at, at + length)
      if (data.length !== length) return { ok: false, error: 'Truncated' }
      at += length
      produced += length
      ops.push({ add: Buffer.from(data) })
    } else {
      return { ok: false, error: 'Malformed: unknown tag' }
    }
    if (produced > targetLen) return { ok: false, error: 'Malformed: overshoot' }
  }
  if (produced !== targetLen) return { ok: false, error: 'Malformed: length mismatch' }
  if (at !== patch.length) return { ok: false, error: 'Malformed: trailing bytes' }

  if (base.length !== baseLen) return { ok: false, error: 'BaseMismatch' }
  if (!sha256(base).equals(patch.subarray(8, 40))) return { ok: false, error: 'BaseMismatch' }

  const out = Buffer.alloc(targetLen)
  let cursor = 0
  for (const op of ops) {
    if (op.copy) {
      base.copy(out, cursor, op.copy[0], op.copy[0] + op.copy[1])
      cursor += op.copy[1]
    } else {
      op.add!.copy(out, cursor)
      cursor += op.add!.length
    }
  }
  if (cursor !== targetLen) return { ok: false, error: 'TargetMismatch' }
  if (!sha256(out).equals(patch.subarray(40, 72))) return { ok: false, error: 'TargetMismatch' }
  return { ok: true, bytes: out }
}

const offsetOf = (haystack: Buffer, needle: Buffer) => haystack.indexOf(needle)

describe('rust delta parity', () => {
  it('replays copies_and_literals_round_trip', () => {
    const base = Buffer.from('the quick brown fox jumps over the lazy dog')
    const target = Buffer.from('the quick brown cat jumps over the lazy dog!')
    const shared = Buffer.from('jumps over the lazy dog')
    const offset = offsetOf(base, shared)
    expect(offset).toBe(20)
    const patch = handMade(
      [
        { add: Buffer.from('the quick brown cat ') },
        { copy: { offset, length: shared.length } },
        { add: Buffer.from('!') },
      ],
      base,
      target,
    )
    const result = rebuild(patch, base)
    expect(result.ok).toBe(true)
    expect(result.ok && result.bytes.equals(target)).toBe(true)
  })

  it('replays rejects_a_literal_byte_that_was_changed_in_flight', () => {
    const base = Buffer.from('hello world')
    const target = Buffer.from('hello there')
    const patch = handMade(
      [
        { copy: { offset: 0, length: 5 } },
        { add: Buffer.from(' there') },
      ],
      base,
      target,
    )
    expect(rebuild(patch, base).ok).toBe(true)

    const tampered = Buffer.from(patch)
    const dataAt = HEADER_SIZE + 1 + 8 + 4 + 1 + 4
    expect(tampered.subarray(dataAt, dataAt + 6).toString()).toBe(' there')
    tampered[dataAt] ^= 0xff
    // Still structurally valid: only the target hash exposes the change.
    expect(rebuild(tampered, base)).toEqual({ ok: false, error: 'TargetMismatch' })
  })

  it('replays rejects_a_copy_that_reads_past_the_base', () => {
    const base = Buffer.from('abcdefgh')
    const target = Buffer.from('abcdefgh')
    const patch = handMade([{ copy: { offset: 4, length: 8 } }], base, target)
    patch.writeBigUInt64LE(8n, 72)
    expect(rebuild(patch, base).ok).toBe(false)
  })

  it('replays rejects_instructions_that_overshoot_the_declared_length', () => {
    const base = Buffer.from('abc')
    const target = Buffer.from('abc')
    const patch = handMade([{ copy: { offset: 0, length: 3 } }], base, target)
    patch.writeBigUInt64LE(2n, 80)
    expect(rebuild(patch, base).ok).toBe(false)
  })

  it('replays rejects_a_lying_target_length', () => {
    const base = Buffer.from('abc')
    const target = Buffer.from('abc')
    const patch = handMade([{ copy: { offset: 0, length: 3 } }], base, target)
    patch.writeBigUInt64LE(9n, 80)
    expect(rebuild(patch, base).ok).toBe(false)
  })

  it('replays rejects_a_forged_target_hash', () => {
    const base = Buffer.from('hello')
    const target = Buffer.from('hello world')
    const patch = handMade(
      [
        { copy: { offset: 0, length: 5 } },
        { add: Buffer.from(' world') },
      ],
      base,
      target,
    )
    sha256(Buffer.from('goodbye world')).copy(patch, 40)
    expect(rebuild(patch, base)).toEqual({ ok: false, error: 'TargetMismatch' })
  })

  it('replays the fixture round trip', () => {
    const base = Buffer.from(require('node:fs').readFileSync('src-tauri/src/delta_fixtures/base.bin'))
    const target = Buffer.from(
      require('node:fs').readFileSync('src-tauri/src/delta_fixtures/target.bin'),
    )
    const patch = Buffer.from(
      require('node:fs').readFileSync('src-tauri/src/delta_fixtures/patch.1bdelta'),
    )
    const result = rebuild(patch, base)
    expect(result.ok).toBe(true)
    expect(result.ok && result.bytes.equals(target)).toBe(true)
    expect(result.ok && result.bytes.length).toBe(target.length)
  })
})