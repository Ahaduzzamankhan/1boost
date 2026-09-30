import type {
  AppAgg,
  AppDetailData,
  BoostSample,
  DashboardData,
  DayData,
  LiveSnapshot,
  Prefs,
  Session,
  TrendPoint,
  UsageData,
} from '../shared/types'

// ---------------------------------------------------------------------------
// Day keys (local time)
// ---------------------------------------------------------------------------

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function dayKeyFromParts(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

// ---------------------------------------------------------------------------
// Day bucket creation / merging
// ---------------------------------------------------------------------------

export function emptyDay(date: string, nowMs: number): DayData {
  return {
    date,
    pcOnMs: 0,
    activeMs: 0,
    idleMs: 0,
    screenOnMs: 0,
    firstMs: nowMs,
    lastMs: nowMs,
    batteryMs: 0,
    acMs: 0,
    focusMs: 0,
    apps: {},
  }
}

export function ensureDay(data: UsageData, key: string, nowMs: number): DayData {
  let d = data.days[key]
  if (!d) {
    d = emptyDay(key, nowMs)
    data.days[key] = d
  }
  return d
}

export function touchDay(day: DayData, nowMs: number): void {
  if (nowMs < day.firstMs) day.firstMs = nowMs
  if (nowMs > day.lastMs) day.lastMs = nowMs
}

export function appUsageForDay(day: DayData | undefined, key: string): number {
  return day?.apps[key] ?? 0
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface TotalsResult {
  pcOnMs: number
  activeMs: number
  idleMs: number
  days: number
}

export function computeTotals(data: UsageData): TotalsResult {
  let pcOnMs = 0
  let activeMs = 0
  let idleMs = 0
  let days = 0
  for (const k of Object.keys(data.days)) {
    const d = data.days[k]
    pcOnMs += d.pcOnMs
    activeMs += d.activeMs
    idleMs += d.idleMs
    if (d.pcOnMs > 0 || d.activeMs > 0 || Object.keys(d.apps).length > 0) days++
  }
  return { pcOnMs, activeMs, idleMs, days }
}

export function rebuildTotals(data: UsageData): void {
  data.totals = computeTotals(data)
}

/** Sorted (newest-first) app aggregates for a day. */
export function topAppsForDay(day: DayData | undefined, limit = 5): AppAgg[] {
  if (!day) return []
  const out: AppAgg[] = []
  for (const [key, ms] of Object.entries(day.apps)) {
    if (ms > 0) out.push({ key, name: key, ms })
  }
  out.sort((a, b) => b.ms - a.ms)
  return limit > 0 ? out.slice(0, limit) : out
}

/** Aggregated app usage across all days (all-time top apps). */
export function topAppsOverall(data: UsageData, limit = 0): AppAgg[] {
  const acc = new Map<string, number>()
  const last = new Map<string, number>()
  for (const day of Object.values(data.days)) {
    for (const [key, ms] of Object.entries(day.apps)) {
      if (ms <= 0) continue
      acc.set(key, (acc.get(key) ?? 0) + ms)
      last.set(key, Math.max(last.get(key) ?? 0, day.lastMs))
    }
  }
  const out: AppAgg[] = [...acc.entries()].map(([key, ms]) => ({ key, name: key, ms }))
  out.sort((a, b) => b.ms - a.ms)
  return limit > 0 ? out.slice(0, limit) : out
}

/** Sorted list of day keys (oldest first). */
export function sortedDayKeys(data: UsageData): string[] {
  return Object.keys(data.days).sort()
}

/**
 * Daily active/on trend for the last N days (missing days are zero-filled).
 * Oldest first.
 */
export function dailyTrend(data: UsageData, days: number, nowMs: number): TrendPoint[] {
  const out: TrendPoint[] = []
  const base = parseDayKey(dayKey(nowMs))
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    const key = dayKeyFromParts(d.getFullYear(), d.getMonth(), d.getDate())
    const day = data.days[key]
    out.push({ date: key, activeMs: day?.activeMs ?? 0, onMs: day?.pcOnMs ?? 0 })
  }
  return out
}

export function hourHistogram(day: DayData | undefined): number[] {
  // Proportional split across the observed window (firstMs..lastMs).
  const out = new Array(24).fill(0)
  if (!day || day.pcOnMs <= 0 || day.lastMs <= day.firstMs) return out
  const span = day.lastMs - day.firstMs
  const clamped = Math.min(day.pcOnMs, span)
  const perHour = clamped / span
  const start = new Date(day.firstMs)
  const end = new Date(day.lastMs)
  for (let h = start.getHours(); h <= end.getHours(); h++) {
    const idx = h % 24
    out[idx] += perHour
  }
  return out
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Cut pending session on sleep/lock/shutdown. Returns session or null. */
export function closeSession(
  data: UsageData,
  nowMs: number,
  reason: 'sleep' | 'lock' | 'shutdown' | 'quit' | 'manual',
): Session | null {
  const s = data.pendingSession
  data.pendingSession = null
  if (!s || s.startMs >= nowMs) return null
  const session: Session = {
    id: `s-${s.startMs}`,
    startMs: s.startMs,
    endMs: nowMs,
    activeMs: s.activeMs,
    onMs: s.onMs,
    idleMs: s.idleMs,
    sleep: reason === 'sleep',
  }
  data.sessions.push(session)
  return session
}

export function openSession(data: UsageData, nowMs: number): void {
  if (!data.pendingSession) {
    data.pendingSession = { startMs: nowMs, activeMs: 0, onMs: 0, idleMs: 0 }
  }
}

export interface SessionStats {
  avgSessionMs: number
  longestSession: Session | null
}

export function sessionStats(data: UsageData): SessionStats {
  if (data.sessions.length === 0) return { avgSessionMs: 0, longestSession: null }
  let total = 0
  let longest: Session | null = null
  for (const s of data.sessions) {
    total += s.onMs
    if (!longest || s.onMs > longest.onMs) longest = s
  }
  return { avgSessionMs: total / data.sessions.length, longestSession: longest }
}

// ---------------------------------------------------------------------------
// Retention / trimming
// ---------------------------------------------------------------------------

export function trimToRetention(data: UsageData, keepDays: number, nowMs: number): void {
  if (keepDays <= 0) return // unlimited
  const cutoff = parseDayKey(dayKey(nowMs)).getTime() - (keepDays - 1) * 86_400_000
  const keys = Object.keys(data.days)
  for (const k of keys) {
    if (parseDayKey(k).getTime() < cutoff) delete data.days[k]
  }
  data.sessions = data.sessions.filter((s) => s.endMs >= cutoff)
}

// ---------------------------------------------------------------------------
// Live snapshot + dashboard payload assembly
// ---------------------------------------------------------------------------

export function buildLiveSnapshot(
  data: UsageData,
  today: DayData,
  opts: {
    nowMs: number
    paused: boolean
    currentApp: { key: string; name: string; startMs: number } | null
    battery: { charging: boolean; pct: number; noBattery: boolean }
    batteryRemainingMin: number | null
    lastError: string | null
  },
): LiveSnapshot {
  return {
    version: 1,
    nowMs: opts.nowMs,
    startedAt: data.createdAt,
    day: today.date,
    pcOnMs: today.pcOnMs,
    activeMs: today.activeMs,
    idleMs: today.idleMs,
    screenOnMs: today.screenOnMs,
    paused: opts.paused,
    appKey: opts.currentApp?.key ?? '',
    appName: opts.currentApp?.name ?? '',
    appStartMs: opts.currentApp?.startMs ?? 0,
    appElapsedMs: opts.currentApp ? Math.max(0, opts.nowMs - opts.currentApp.startMs) : 0,
    battery: opts.battery,
    batteryRemainingMin: opts.batteryRemainingMin,
    lastError: opts.lastError,
  }
}

export function buildDashboard(
  data: UsageData,
  opts: {
    nowMs: number
    paused: boolean
    currentApp: { key: string; name: string; startMs: number } | null
    battery: { charging: boolean; pct: number; noBattery: boolean }
    batteryRemainingMin: number | null
    lastError: string | null
    appNames: Map<string, string>
    icons: Map<string, string | null>
    days: number
  },
): DashboardData {
  const key = dayKey(opts.nowMs)
  const today = ensureDay(data, key, opts.nowMs)
  // Per-app last-used (across all history) for the dashboard list.
  const lastUsed = new Map<string, number>()
  for (const day of Object.values(data.days)) {
    for (const appKey of Object.keys(day.apps)) {
      const t = lastUsed.get(appKey) ?? 0
      if (day.lastMs > t) lastUsed.set(appKey, day.lastMs)
    }
  }
  const apps: DashboardData['apps'] = topAppsForDay(today, 0)
    .slice(0, 6)
    .map((a) => ({
      ...a,
      name: opts.appNames.get(a.key) ?? a.key,
      iconDataUrl: opts.icons.get(a.key) ?? null,
      lastUsedMs: lastUsed.get(a.key) ?? null,
    }))
  return {
    today,
    apps,
    hourly: hourHistogram(today),
    snapshot: buildLiveSnapshot(data, today, {
      nowMs: opts.nowMs,
      paused: opts.paused,
      currentApp: opts.currentApp,
      battery: opts.battery,
      batteryRemainingMin: opts.batteryRemainingMin,
      lastError: opts.lastError,
    }),
    totals: computeTotals(data),
    daily: dailyTrend(data, opts.days, opts.nowMs),
  }
}

// ---------------------------------------------------------------------------
// App detail
// ---------------------------------------------------------------------------

export function appDetail(data: UsageData, key: string, name: string): AppDetailData {
  let totalMs = 0
  const perDay: { date: string; ms: number }[] = []
  let lastUsedMs: number | null = null
  let activeMs = 0
  for (const k of sortedDayKeys(data)) {
    const day = data.days[k]
    const ms = day.apps[key] ?? 0
    if (ms > 0) {
      totalMs += ms
      perDay.push({ date: k, ms })
      if (day.lastMs > (lastUsedMs ?? 0)) lastUsedMs = day.lastMs
    }
    activeMs += day.activeMs
  }
  return {
    identity: { key, name },
    totalMs,
    activeShare: activeMs > 0 ? totalMs / activeMs : 0,
    lastUsedMs,
    perDay,
  }
}

// ---------------------------------------------------------------------------
// Sample application to the current day bucket (delta model)
// ---------------------------------------------------------------------------

export interface ApplyOpts {
  sample: BoostSample
  prev: BoostSample | null
  deltaMs: number
  day: DayData
  appKey: string
  appName: string
}

export function applySampleToDay(opts: ApplyOpts): void {
  const { sample, deltaMs, day } = opts
  if (deltaMs <= 0) return
  const active = sample.inputActive
  day.pcOnMs += deltaMs
  if (active) day.activeMs += deltaMs
  else day.idleMs += deltaMs
  if (sample.screenOn) day.screenOnMs += deltaMs
  if (sample.acOnline) day.acMs += deltaMs
  else if (!(sample.batteryFlag & 128)) day.batteryMs += deltaMs
  // Fullscreen focus time (games, films): active use while the foreground
  // window covers its monitor.
  if (active && sample.isFullscreen) day.focusMs += deltaMs
  touchDay(day, sample.nowEpochMs)
}

// ---------------------------------------------------------------------------
// Live sessions (open session accumulation)
// ---------------------------------------------------------------------------

export function accumulateLiveSession(
  data: UsageData,
  deltaMs: number,
  active: boolean,
  nowMs: number,
): void {
  if (deltaMs <= 0) return
  if (!data.pendingSession) {
    data.pendingSession = { startMs: nowMs, activeMs: 0, onMs: 0, idleMs: 0 }
  }
  data.pendingSession.onMs += deltaMs
  if (active) data.pendingSession.activeMs += deltaMs
  else data.pendingSession.idleMs += deltaMs
}

// ---------------------------------------------------------------------------
// Storage invariants (keep this file import-light: pure logic only)
// ---------------------------------------------------------------------------

export function clampPrefs(p: Partial<Prefs> | null | undefined, defaults: Prefs): Prefs {
  const out: Prefs = { ...defaults }
  if (!p) return out
  const themes: Prefs['theme'][] = ['dark-glass', 'white-glass', 'solid-dark', 'solid-white', 'amoled']
  if (themes.includes(p.theme as Prefs['theme'])) out.theme = p.theme as Prefs['theme']
  const accents: Prefs['accent'][] = ['blue', 'violet', 'teal', 'green', 'amber', 'rose', 'sky', 'crimson']
  if (accents.includes(p.accent as Prefs['accent'])) out.accent = p.accent as Prefs['accent']
  if (typeof p.transparency === 'number' && Number.isFinite(p.transparency)) {
    out.transparency = Math.min(1, Math.max(0, p.transparency))
  }
  out.reducedMotion = typeof p.reducedMotion === 'boolean' ? p.reducedMotion : out.reducedMotion
  out.launchAtLogin = typeof p.launchAtLogin === 'boolean' ? p.launchAtLogin : out.launchAtLogin
  out.startMinimized = typeof p.startMinimized === 'boolean' ? p.startMinimized : out.startMinimized
  out.pauseTracking = typeof p.pauseTracking === 'boolean' ? p.pauseTracking : out.pauseTracking
  if (typeof p.idleThresholdMin === 'number' && Number.isFinite(p.idleThresholdMin)) {
    out.idleThresholdMin = Math.min(120, Math.max(1, Math.round(p.idleThresholdMin)))
  }
  if (typeof p.keepHistoryDays === 'number' && Number.isFinite(p.keepHistoryDays)) {
    out.keepHistoryDays = Math.min(3650, Math.max(7, Math.round(p.keepHistoryDays)))
  }
  out.showTray = typeof p.showTray === 'boolean' ? p.showTray : out.showTray
  return out
}

// ---------------------------------------------------------------------------
// Test/data-shape constants (previously in storage.ts)
// ---------------------------------------------------------------------------

/** Defaults mirroring the shipped Electron settings.json so old installs and
 * the Rust backend agree on the initial preference set. */
export const DEFAULT_PREFS: Prefs = {
  theme: 'dark-glass',
  accent: 'blue',
  transparency: 0.4,
  reducedMotion: false,
  launchAtLogin: false,
  startMinimized: false,
  pauseTracking: false,
  idleThresholdMin: 1,
  keepHistoryDays: 365,
  showTray: true,
}

const DATA_VERSION = 1

/** Empty usage store (data-file shape version 1). */
export function emptyUsage(): UsageData {
  return {
    version: DATA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    days: {},
    sessions: [],
    totals: { pcOnMs: 0, activeMs: 0, idleMs: 0, days: 0 },
    pendingSession: null,
    appNames: {},
  }
}

// ---------------------------------------------------------------------------
// Data normalization (previously in storage.ts; needed by tests and by any
// tooling that validates hand-edited data files)
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** Normalize + validate a parsed UsageData to survive schema drift / hand edits. */
export function normalizeUsageData(v: UsageData): UsageData {
  const days: UsageData['days'] = {}
  for (const [k, d] of Object.entries(v.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d || typeof d !== 'object') continue
    days[k] = {
      date: k,
      pcOnMs: num(d.pcOnMs),
      activeMs: num(d.activeMs),
      idleMs: num(d.idleMs),
      screenOnMs: num(d.screenOnMs),
      firstMs: num(d.firstMs),
      lastMs: num(d.lastMs),
      batteryMs: num(d.batteryMs),
      acMs: num(d.acMs),
      focusMs: num((d as { focusMs?: unknown }).focusMs),
      apps: sanitizeApps(d.apps),
    }
  }
  const sessions = Array.isArray(v.sessions)
    ? v.sessions.filter(
        (s: unknown): s is UsageData['sessions'][number] =>
          !!s && typeof s === 'object' && typeof (s as UsageData['sessions'][number]).startMs === 'number',
      )
    : []
  return {
    version: DATA_VERSION,
    createdAt: num(v.createdAt) || Date.now(),
    updatedAt: num(v.updatedAt) || Date.now(),
    days,
    sessions,
    totals: { pcOnMs: 0, activeMs: 0, idleMs: 0, days: 0 },
    pendingSession: sanitizePending(v.pendingSession),
    appNames: sanitizeAppNames(v.appNames),
  }
}

function sanitizeApps(apps: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (apps && typeof apps === 'object') {
    for (const [k, v] of Object.entries(apps as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length > 0 && k.length <= 64) out[k] = num(v)
    }
  }
  return out
}

function sanitizePending(p: unknown): UsageData['pendingSession'] {
  if (!p || typeof p !== 'object') return null
  const q = p as { startMs?: unknown; activeMs?: unknown; onMs?: unknown; idleMs?: unknown }
  if (typeof q.startMs !== 'number') return null
  return {
    startMs: q.startMs,
    activeMs: num(q.activeMs),
    onMs: num(q.onMs),
    idleMs: num(q.idleMs),
  }
}

function sanitizeAppNames(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object') {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length > 0 && k.length <= 64 && typeof n === 'string' && n.length <= 64) {
        out[k] = n
      }
    }
  }
  return out
}
