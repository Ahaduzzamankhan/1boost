// Native FFI loader + TS bindings for the Rust tracking layer.
// All struct reads use DataView with explicit little-endian offsets that are
// pinned by Rust layout unit tests (electron/native/src/lib.rs tests module).

import koffi from 'koffi'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { BoostEvent, BoostEventKind, BoostSample } from '../../shared/types'

// esbuild emits CJS, so prefer __filename with an ESM fallback.
const here =
  typeof __filename === 'string'
    ? dirname(__filename)
    : dirname(process.argv[1] ?? process.cwd())
const NATIVE_PATHS = [
  // Packaged: extraResources/native inside the install dir.
  ...(typeof process.resourcesPath === 'string'
    ? [join(process.resourcesPath, 'native', 'oneboost_native.dll')]
    : []),
  // Development: project-root resources dir.
  join(here, '..', '..', 'resources', 'native', 'oneboost_native.dll'),
  join(process.cwd(), 'resources', 'native', 'oneboost_native.dll'),
]

type KoffiLib = ReturnType<typeof koffi.load>

let lib: KoffiLib | null = null

function loadLibrary(): KoffiLib {
  if (lib) return lib
  const errors: string[] = []
  for (const p of NATIVE_PATHS) {
    if (!existsSync(p)) {
      errors.push(`not found: ${p}`)
      continue
    }
    try {
      lib = koffi.load(p)
      return lib
    } catch (e) {
      errors.push(`load failed: ${p}: ${String(e)}`)
    }
  }
  throw new Error('Failed to load oneboost_native.dll: ' + errors.join('; '))
}

// FFI signatures — match oneboost_native.dll exports exactly.
const FN_DEFS = {
  start: { name: 'oneboost_start', result: 'int', args: [] as string[] },
  shutdown: { name: 'oneboost_shutdown', result: 'void', args: [] as string[] },
  collect: { name: 'oneboost_collect_once', result: 'int', args: ['void *', 'uint32'] },
  pump: { name: 'oneboost_pump_events', result: 'int', args: ['void *', 'void *', 'uint32'] },
  idle: { name: 'oneboost_get_idle_state', result: 'int', args: ['void *'] },
}

function fn(name: keyof typeof FN_DEFS) {
  const d = FN_DEFS[name]
  return loadLibrary().func(d.name, d.result, d.args)
}

// ---- layout constants (must match Rust tests) ------------------------------
// BoostSampleResult: 584 bytes; BoostEventData: 24 bytes; BoostPumpResult: 32 bytes.
// Offsets: uptime_ms=0 u64, now_epoch_ms=8 u64, ok=16 i32, foreground_ok=20 i32,
// has_window=24 i32, screen_on=28 i32, console_locked=32 i32, active_session=36 i32,
// input_active=40 i32, idle_ms=44 u32, ac_online=48 i32, battery_pct=52 u8,
// battery_flag=53 u8, fg.process_name=56 [u16;260], fg.process_id=576 u32.
const S = {
  uptimeMs: 0,
  nowEpochMs: 8,
  ok: 16,
  foregroundOk: 20,
  hasWindow: 24,
  screenOn: 28,
  consoleLocked: 32,
  activeSession: 36,
  inputActive: 40,
  idleMs: 44,
  acOnline: 48,
  batteryPct: 52,
  batteryFlag: 53,
  fgName: 56,
  fgPid: 576,
}
const S_SIZE = 584
const E_SIZE = 24
const P_SIZE = 32
const MAX_EVENTS = 64

function readUtf16(buf: Buffer, off: number, maxChars: number): string {
  let end = off
  const limit = off + maxChars * 2
  while (end < limit && end + 1 < buf.length) {
    if (buf.readUInt16LE(end) === 0) break
    end += 2
  }
  return buf.subarray(off, end).toString('utf16le')
}

export function nativeStart(): void {
  fn('start')()
}

export function nativeShutdown(): void {
  try {
    if (lib) fn('shutdown')()
  } catch {
    /* ignore */
  }
}

export function nativeCollectOnce(idleThresholdMs: number): BoostSample {
  const out = Buffer.alloc(S_SIZE)
  const rc = fn('collect')(out, idleThresholdMs | 0)
  if (rc !== 1) throw new Error('oneboost_collect_once failed: ' + rc)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  return {
    ok: dv.getInt32(S.ok, true) === 1,
    foregroundOk: dv.getInt32(S.foregroundOk, true) === 1,
    hasWindow: dv.getInt32(S.hasWindow, true) === 1,
    screenOn: dv.getInt32(S.screenOn, true) === 1,
    consoleLocked: dv.getInt32(S.consoleLocked, true) === 1,
    activeSession: dv.getInt32(S.activeSession, true) === 1,
    inputActive: dv.getInt32(S.inputActive, true) === 1,
    idleMs: dv.getUint32(S.idleMs, true),
    acOnline: dv.getInt32(S.acOnline, true) === 1,
    batteryPct: dv.getUint8(S.batteryPct),
    batteryFlag: dv.getUint8(S.batteryFlag),
    uptimeMs: Number(dv.getBigUint64(S.uptimeMs, true)),
    nowEpochMs: Number(dv.getBigUint64(S.nowEpochMs, true)),
    processId: dv.getUint32(S.fgPid, true),
    processName: readUtf16(out, S.fgName, 260),
  }
}

const EVENT_KINDS: BoostEventKind[] = [
  'sleep', 'resume', 'lock', 'unlock', 'monitor-on', 'monitor-off',
  'power-source', 'battery', 'session', 'display', 'shutdown', 'quit',
]

export function nativePumpEvents(): { events: BoostEvent[]; flushed: boolean } {
  const out = Buffer.alloc(P_SIZE)
  const buf = Buffer.alloc(E_SIZE * MAX_EVENTS)
  const n = fn('pump')(out, buf, MAX_EVENTS)
  if (n < 0) throw new Error('oneboost_pump_events failed: ' + n)
  const events: BoostEvent[] = []
  for (let i = 0; i < n; i++) {
    const base = i * E_SIZE
    const value = Number(buf.readBigInt64LE(base))
    const atMs = Number(buf.readBigUint64LE(base + 8))
    const kindRaw = buf.readUInt32LE(base + 16)
    const kind = EVENT_KINDS[kindRaw - 1] ?? 'display'
    events.push({ kind, value, atMs })
  }
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  return { events, flushed: dv.getUint32(20, true) === 1 }
}

export function nativeIdleState(): { ok: boolean; idleMs: number } {
  const out = Buffer.alloc(16)
  const rc = fn('idle')(out)
  if (rc !== 1) return { ok: false, idleMs: 0 }
  return { ok: out.readInt32LE(0) === 1, idleMs: out.readUInt32LE(4) }
}

export function isNativeLoaded(): boolean {
  return lib !== null
}
