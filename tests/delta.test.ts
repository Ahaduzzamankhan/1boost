import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  FORMAT_VERSION,
  HEADER_SIZE,
  MAGIC,
  OP_ADD,
  OP_COPY,
  applyDelta,
  buildDelta,
  rollingWindowIsConsistent,
} from '../scripts/gen-delta.mjs'

/**
 * The delta format is shared by the Node generator (CI) and the Rust client
 * (src-tauri/src/delta.rs), so these tests pin the wire format and use
 * `fixtures/delta-*` — a committed base/target/patch triple the Rust test
 * suite applies with the same expectations.
 */
const FIXTURE_DIR = join(process.cwd(), 'src-tauri', 'src', 'delta_fixtures')

/**
 * xorshift32, so every fixture is byte-for-byte reproducible. The Rust suite
 * loads the committed fixture and must reproduce the same result, which only
 * holds if nothing here depends on `crypto.randomBytes`.
 */
function noise(seed: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  let x = seed | 0 || 0x9e3779b9
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    buf[i] = x & 0xff
  }
  return buf
}

/** Pseudo-installer: mostly stable bytes with a rebuilt chunk in the middle. */
function fakeArtifact(seed: number, size: number, mutate?: (buf: Buffer) => void) {
  const buf = noise(seed, size)
  mutate?.(buf)
  return buf
}

describe('delta format', () => {
  it('rolls the window hash consistently with a fresh hash', () => {
    // If the modular inverse used by the rolling hash were wrong, matches
    // would only ever be found at the first window and every patch would
    // degenerate into 64-byte copies.
    expect(rollingWindowIsConsistent()).toBe(true)
  })

  it('writes the documented header', () => {
    const base = Buffer.alloc(256, 1)
    const target = Buffer.alloc(300, 2)
    const { patch } = buildDelta(base, target)

    expect(patch.length).toBeGreaterThan(HEADER_SIZE)
    expect(patch.subarray(0, 4)).toEqual(MAGIC)
    expect(patch[4]).toBe(FORMAT_VERSION)
    expect(patch.readBigUInt64LE(72)).toBe(256n)
    expect(patch.readBigUInt64LE(80)).toBe(300n)
    expect(patch[5]).toBe(0)
    expect(patch.readUInt16LE(6)).toBe(0)
  })

  it('round-trips an unrelated pair of files', () => {
    const base = noise(11, 4096)
    const target = noise(12, 5000)
    const { patch } = buildDelta(base, target)
    expect(applyDelta(base, patch)).toEqual(target)
  })

  it('reproduces a mostly unchanged artifact from a small patch', () => {
    const base = fakeArtifact(1, 512 * 1024)
    const target = Buffer.from(base)
    // Rebuild one 4 KB region, as a recompiled binary would.
    noise(13, 4096).copy(target, 200_000)

    const { patch } = buildDelta(base, target)
    expect(applyDelta(base, patch)).toEqual(target)
    // The unchanged ~500 KB must not be shipped again.
    expect(patch.length).toBeLessThan(base.length / 4)
  })

  it('matches across an inserted block', () => {
    const base = fakeArtifact(2, 256 * 1024)
    const target = Buffer.concat([base.subarray(0, 1000), noise(14, 777), base.subarray(1000)])

    const { patch } = buildDelta(base, target)
    expect(applyDelta(base, patch)).toEqual(target)
    expect(patch.length).toBeLessThan(12_000)
  })

  it('emits literal bytes for content that is not in the base at all', () => {
    const base = fakeArtifact(3, 8192)
    const target = noise(15, 9000)
    const { ops, patch } = buildDelta(base, target)
    expect(ops.every((op) => op.kind === OP_ADD)).toBe(true)
    expect(applyDelta(base, patch)).toEqual(target)
  })

  it('copies an identical artifact with no literal bytes', () => {
    const base = fakeArtifact(4, 4096)
    const { ops, patch } = buildDelta(base, base)
    expect(ops.every((op) => op.kind === OP_COPY)).toBe(true)
    expect(applyDelta(base, patch)).toEqual(base)
  })

  it('handles files smaller than the match window', () => {
    const base = Buffer.from('tiny base')
    const target = Buffer.from('tiny target, slightly longer')
    const { patch } = buildDelta(base, target)
    expect(applyDelta(base, patch)).toEqual(target)
  })

  it('refuses a patch whose instructions under-fill the declared length', () => {
    const base = noise(16, 4096)
    const target = Buffer.from(base)
    const { patch } = buildDelta(base, target)
    // Claim more output than the instructions can produce.
    patch.writeBigUInt64LE(BigInt(target.length + 8), 80)
    expect(() => applyDelta(base, patch)).toThrow(/fill the declared length/)
  })

  it('refuses trailing bytes in a hand-edited patch', () => {
    const base = fakeArtifact(5, 2048)
    const target = Buffer.from(base)
    target[100] ^= 0xff
    const { patch } = buildDelta(base, target)
    const tampered = Buffer.concat([patch, Buffer.from([0])])
    expect(() => applyDelta(base, tampered)).toThrow(/trailing/)
  })

  it('exposes the op tags the Rust client switches on', () => {
    expect(OP_COPY).toBe(1)
    expect(OP_ADD).toBe(2)
  })
})

describe('committed cross-language fixture', () => {
  const base = fakeArtifact(7, 96 * 1024)
  const target = Buffer.from(base)
  noise(8, 2048).copy(target, 40_000)
  target.write('1Boost', 70_000, 'ascii')
  const { patch } = buildDelta(base, target)

  it('round-trips before anything is committed', () => {
    expect(applyDelta(base, patch)).toEqual(target)
  })

  it('matches the fixture the Rust test suite applies', () => {
    const files = {
      'base.bin': base,
      'target.bin': target,
      'patch.1bdelta': patch,
    }
    // Bootstrap once so the fixture can be committed; afterwards the committed
    // bytes are the contract, so a generator change that silently alters the
    // wire format fails here instead of in the Rust suite.
    mkdirSync(FIXTURE_DIR, { recursive: true })
    for (const [name, expected] of Object.entries(files)) {
      const path = join(FIXTURE_DIR, name)
      if (!existsSync(path)) {
        writeFileSync(path, expected)
        continue
      }
      expect(readFileSync(path)).toEqual(expected)
    }
  })
})