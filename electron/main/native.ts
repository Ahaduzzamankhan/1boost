// Native FFI loader + TS bindings for the Rust tracking layer.
// All struct reads use DataView with explicit little-endian offsets that are
// pinned by Rust layout unit tests (electron/native/src/lib.rs tests module).

import koffi from 'koffi'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { BoostEvent, BoostEventKind, BoostSample, MonitorSample } from '../../shared/types'

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
  monitor: { name: 'oneboost_monitor_sample', result: 'int', args: ['void *'] },
  monitorShutdown: { name: 'oneboost_monitor_shutdown', result: 'void', args: [] as string[] },
}

function fn(name: keyof typeof FN_DEFS) {
  const d = FN_DEFS[name]
  return loadLibrary().func(d.name, d.result, d.args)
}

// ---- layout constants (must match Rust tests) ------------------------------
// BoostSampleResult: 592 bytes; BoostEventData: 24 bytes; BoostPumpResult: 32 bytes.
// Offsets: uptime_ms=0 u64, now_epoch_ms=8 u64, ok=16 i32, foreground_ok=20 i32,
// has_window=24 i32, screen_on=28 i32, console_locked=32 i32, active_session=36 i32,
// input_active=40 i32, idle_ms=44 u32, ac_online=48 i32, battery_pct=52 u8,
// battery_flag=53 u8, fg.process_name=56 [u16;260], fg.process_id=576 u32,
// is_fullscreen=580 i32, battery_remaining_min=584 i32.
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
  isFullscreen: 580,
  batteryRemainingMin: 584,
}
const S_SIZE = 592
const E_SIZE = 24
const P_SIZE = 32
const MAX_EVENTS = 64

// BoostMonitorResult: 1152 bytes. Offsets pinned by Rust tests in
// electron/native/src/monitor.rs (monitor_layouts).
const M = {
  ok: 0,
  nowEpochMs: 8,
  cpuUsage: 16,
  cpuTemp: 24,
  cpuName: 32,
  cpuCores: 160,
  memUsed: 168,
  memTotal: 176,
  gpuUsage: 184,
  gpuTemp: 192,
  gpuMemUsed: 200,
  gpuMemTotal: 208,
  gpuName: 216,
  diskReadBps: 408,
  diskWriteBps: 416,
  diskActivePct: 424,
  netDownloadBps: 432,
  netUploadBps: 440,
  netIfName: 448,
  drives: 640, // 8 × BoostDriveInfo (letter u32 @+0, pad, total u64 @+8, free u64 @+16)
  osName: 832,
  osVersion: 1024,
}
const M_SIZE = 1152
const M_DRIVE_SIZE = 24
const M_DRIVE_COUNT = 8

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
    isFullscreen: dv.getInt32(S.isFullscreen, true) === 1,
    batteryRemainingMin: dv.getInt32(S.batteryRemainingMin, true),
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

/**
 * One system-monitoring snapshot from the Rust layer. Unavailable metrics
 * arrive as null (Rust sends -1 / 0 sentinels) — never NaN or invented values.
 */
export function nativeMonitorSample(): MonitorSample {
  const out = Buffer.alloc(M_SIZE)
  const rc = fn('monitor')(out)
  if (rc !== 1) throw new Error('oneboost_monitor_sample failed: ' + rc)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const num = (v: number) => (Number.isFinite(v) ? v : null)
  const f64 = (off: number) => num(dv.getFloat64(off, true))
  const str = (off: number, maxChars: number) => readUtf16(out, off, maxChars)

  const drives: MonitorSample['drives'] = []
  for (let i = 0; i < M_DRIVE_COUNT; i++) {
    const base = M.drives + i * M_DRIVE_SIZE
    const letterCode = dv.getUint32(base, true)
    const totalBytes = Number(dv.getBigUint64(base + 8, true))
    if (letterCode === 0 || totalBytes <= 0) continue
    drives.push({
      letter: String.fromCharCode(letterCode),
      totalBytes,
      freeBytes: Number(dv.getBigUint64(base + 16, true)),
    })
  }

  const cpuUsage = f64(M.cpuUsage)
  return {
    ok: dv.getInt32(M.ok, true) === 1,
    nowMs: Number(dv.getBigUint64(M.nowEpochMs, true)),
    cpu: {
      usage: cpuUsage !== null && cpuUsage >= 0 ? cpuUsage : null,
      tempC: f64(M.cpuTemp),
      name: str(M.cpuName, 64),
      cores: dv.getUint32(M.cpuCores, true),
    },
    memory: {
      usedBytes: Number(dv.getBigUint64(M.memUsed, true)),
      totalBytes: Number(dv.getBigUint64(M.memTotal, true)),
    },
    gpu: {
      usage: f64(M.gpuUsage),
      tempC: f64(M.gpuTemp),
      memUsedBytes: Number(dv.getBigUint64(M.gpuMemUsed, true)),
      memTotalBytes: Number(dv.getBigUint64(M.gpuMemTotal, true)),
      name: str(M.gpuName, 96),
    },
    disk: {
      readBps: f64(M.diskReadBps),
      writeBps: f64(M.diskWriteBps),
      activePct: f64(M.diskActivePct),
    },
    network: {
      downloadBps: f64(M.netDownloadBps),
      uploadBps: f64(M.netUploadBps),
      interface: str(M.netIfName, 96) || null,
    },
    drives,
    os: {
      name: str(M.osName, 96),
      version: str(M.osVersion, 64),
    },
  }
}

/** Release monitoring resources (PDH query) in the native layer. */
export function nativeMonitorShutdown(): void {
  try {
    if (lib) fn('monitorShutdown')()
  } catch {
    /* ignore */
  }
}
