// Tracker orchestrator: drives the native layer, applies samples to the usage
// store, manages sessions and app-switch detection, caches icons, and persists
// data with debounced atomic writes.

import type {
  AppDetailData,
  AppUsageItem,
  BoostEvent,
  BoostEventKind,
  BoostSample,
  DashboardData,
  DayDetail,
  HistoryPage,
  LiveSnapshot,
  Prefs,
  StatsOverview,
  TrendData,
  UsageData,
  WeekdayAverages,
} from '../../shared/types'
import { Storage } from './storage'
import {
  accumulateLiveSession,
  appDetail as computeAppDetail,
  applySampleToDay,
  buildDashboard,
  buildLiveSnapshot,
  closeSession,
  dayKey,
  emptyDay,
  ensureDay,
  openSession,
  parseDayKey,
  sortedDayKeys,
  topAppsForDay,
  topAppsOverall,
  trimToRetention,
} from './aggregator'
import { appDisplayName, appIdentityFromPath, extractIconDataUrl } from './apps'
import { nativeCollectOnce, nativePumpEvents, nativeShutdown, nativeStart } from './native'

const SAMPLE_MS = 1200
const EVENT_POLL_MS = 500
const WAKE_BURST_MS = 10_000
const MAX_ACCOUNTED_GAP_MS = 60_000
const SAVE_DEBOUNCE_MS = 3_000
const SAVE_MAX_WAIT_MS = 60_000
const UI_PUSH_MS = 2_000
const SNAPSHOT_PUSH_MS = 1_000

interface CurrentApp {
  key: string
  name: string
  startMs: number
  exePath: string
}

export class Tracker {
  private storage: Storage
  private sampleTimer: NodeJS.Timeout | null = null
  private eventTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private maxWaitTimer: NodeJS.Timeout | null = null
  private uiTimer: NodeJS.Timeout | null = null

  private prevSample: BoostSample | null = null
  private lastApplyMs: number | null = null
  private current: CurrentApp | null = null
  private wakeBurstUntil = 0

  private icons = new Map<string, string | null>()
  private iconInflight = new Map<string, Promise<string | null>>()
  private identityCache = new Map<string, { key: string; name: string }>()

  private dirty = false
  private lastUiPush = 0
  private lastSnapshotPush = 0
  private lastError: string | null = null
  private stopped = false

  onSnapshot: ((s: LiveSnapshot) => void) | null = null
  onUsageUpdated: ((d: DashboardData) => void) | null = null
  onToast: ((msg: string) => void) | null = null

  constructor(storage: Storage) {
    this.storage = storage
  }

  get prefs(): Prefs {
    return this.storage.settings.prefs
  }

  get data(): UsageData {
    return this.storage.data
  }

  start(): void {
    this.stopped = false
    try {
      nativeStart()
    } catch (e) {
      this.lastError = 'Native tracking layer failed to load: ' + String(e)
      this.onToast?.(this.lastError)
    }
    this.eventTimer = setInterval(() => this.pumpEvents(), EVENT_POLL_MS)
    this.sampleTimer = setInterval(() => void this.sample(), SAMPLE_MS)
    this.uiTimer = setInterval(() => this.pushUi(), 500)
  }

  stop(): void {
    this.stopped = true
    for (const t of [this.sampleTimer, this.eventTimer, this.saveTimer, this.maxWaitTimer, this.uiTimer]) {
      if (t) clearInterval(t)
    }
    this.sampleTimer = this.eventTimer = this.saveTimer = this.maxWaitTimer = this.uiTimer = null
    this.finalizeBeforeExit()
    nativeShutdown()
  }

  pause(): void {
    this.prefs.pauseTracking = true
  }

  resume(): void {
    this.prefs.pauseTracking = false
  }

  /** Mirror of native events from Electron's powerMonitor (dedup-safe). */
  onPowerEvent(kind: BoostEventKind): void {
    if (this.stopped) return
    this.handleEvent({ kind, value: 0, atMs: Date.now() })
  }

  refreshAfterDataReset(): void {
    this.current = null
    this.prevSample = null
    this.lastApplyMs = null
    this.markDirty()
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  private async sample(): Promise<void> {
    if (this.stopped || this.prefs.pauseTracking) {
      this.prevSample = null
      this.lastApplyMs = null
      return
    }
    let s: BoostSample
    try {
      const now = Date.now()
      const burst = now < this.wakeBurstUntil
      const thresholdMs = this.prefs.idleThresholdMin * 60_000
      s = nativeCollectOnce(thresholdMs)
      if (!burst) this.lastError = null
    } catch (e) {
      this.lastError = 'Tracking sample failed: ' + String(e)
      return
    }
    if (!s.ok) {
      this.lastError = 'Tracking sample unavailable.'
      return
    }

    const now = Number(s.nowEpochMs) || Date.now()
    const prevDay = this.todayOrNull()
    const day = ensureDay(this.data, dayKey(now), now)
    if (!prevDay || prevDay.date !== day.date) this.onDayChanged()

    // Gap guard: if a long unaccounted gap occurred (sleep without event,
    // system freeze), do not count it as usage.
    const gap = this.lastApplyMs === null ? 0 : now - this.lastApplyMs
    const accountDelta = gap > 0 && gap <= MAX_ACCOUNTED_GAP_MS ? gap : 0
    if (gap > MAX_ACCOUNTED_GAP_MS) {
      this.closeCurrentSession(now, 'sleep')
      openSession(this.data, now)
    } else if (!this.data.pendingSession && accountDelta > 0) {
      openSession(this.data, now - accountDelta)
    }

    // App switch detection
    const exe = s.foregroundOk ? s.processName : ''
    if (s.foregroundOk && exe) {
      const path = exe
      const ident = this.identityFor(path)
      if (!this.current || this.current.key !== ident.key) {
        this.switchApp(ident.key, ident.name, path, now)
      } else {
        this.current.startMs = this.current.startMs // unchanged
      }
    } else if (!s.foregroundOk && this.current) {
      // Foreground lost (e.g. lock screen transition, secure desktop)
      this.current = null
    }

    if (accountDelta > 0 && this.lastApplyMs !== null) {
      const prev = this.prevSample
      applySampleToDay({
        sample: s,
        prev,
        deltaMs: accountDelta,
        day,
        appKey: this.current?.key ?? '',
        appName: this.current?.name ?? '',
      })
      if (this.data.pendingSession) {
        accumulateLiveSession(this.data, accountDelta, s.inputActive, now - accountDelta)
      }
      // Per-app usage: only while the user is actively present.
      if (s.inputActive && this.current) {
        day.apps[this.current.key] = (day.apps[this.current.key] ?? 0) + accountDelta
      }
      this.markDirty()
    }

    this.prevSample = s
    this.lastApplyMs = now

    if (s.foregroundOk && this.current) void this.ensureIcon(this.current.key, this.current.exePath)
  }

  private onDayChanged(): void {
    trimToRetention(this.data, this.prefs.keepHistoryDays, Date.now())
    this.markDirty()
  }

  private identityFor(exePath: string): { key: string; name: string } {
    const cached = this.identityCache.get(exePath)
    if (cached) return cached
    const ident = appIdentityFromPath(exePath)
    const entry = { key: ident.key, name: ident.name }
    this.identityCache.set(exePath, entry)
    if (this.data.appNames[entry.key] !== entry.name) {
      this.data.appNames[entry.key] = entry.name
      this.markDirty()
    }
    return entry
  }

  private switchApp(key: string, name: string, exePath: string, now: number): void {
    this.current = { key, name, startMs: now, exePath }
    this.markDirty()
  }

  // -------------------------------------------------------------------------
  // Native events
  // -------------------------------------------------------------------------

  private pumpEvents(): void {
    if (this.stopped) return
    let events: BoostEvent[] = []
    try {
      const res = nativePumpEvents()
      events = res.events
    } catch {
      return
    }
    for (const ev of events) this.handleEvent(ev)
  }

  private handleEvent(ev: BoostEvent): void {
    const now = Date.now()
    switch (ev.kind) {
      case 'sleep':
      case 'shutdown': {
        const reason = ev.kind === 'sleep' ? 'sleep' : 'shutdown'
        this.closeCurrentSession(now, reason)
        this.prevSample = null
        this.lastApplyMs = null
        this.flushSave()
        break
      }
      case 'resume': {
        this.wakeBurstUntil = now + WAKE_BURST_MS
        openSession(this.data, now)
        this.lastApplyMs = null
        this.prevSample = null
        break
      }
      case 'lock': {
        this.closeCurrentSession(now, 'lock')
        this.flushSave()
        break
      }
      case 'unlock': {
        openSession(this.data, now)
        this.lastApplyMs = null
        this.prevSample = null
        break
      }
      case 'monitor-off': {
        this.prevSample = null
        this.lastApplyMs = null
        break
      }
      case 'monitor-on': {
        this.lastApplyMs = null
        this.prevSample = null
        break
      }
      case 'power-source':
      case 'battery':
      case 'session':
      case 'display':
      case 'quit':
        break
    }
  }

  private closeCurrentSession(now: number, reason: 'sleep' | 'lock' | 'shutdown' | 'quit' | 'manual'): void {
    const s = closeSession(this.data, now, reason)
    if (s) this.markDirty()
  }

  // -------------------------------------------------------------------------
  // Snapshot / UI payloads
  // -------------------------------------------------------------------------

  private todayOrNull() {
    const key = dayKey(Date.now())
    return this.data.days[key] ?? null
  }

  snapshot(): LiveSnapshot {
    const now = Date.now()
    const day = this.todayOrNull() ?? emptyDay(dayKey(now), now)
    return buildLiveSnapshot(this.data, day, {
      nowMs: now,
      paused: this.prefs.pauseTracking,
      currentApp: this.current ? { key: this.current.key, name: this.current.name, startMs: this.current.startMs } : null,
      battery: this.batteryState(),
      lastError: this.lastError,
    })
  }

  dashboard(): DashboardData {
    const now = Date.now()
    return buildDashboard(this.data, {
      nowMs: now,
      paused: this.prefs.pauseTracking,
      currentApp: this.current ? { key: this.current.key, name: this.current.name, startMs: this.current.startMs } : null,
      battery: this.batteryState(),
      lastError: this.lastError,
      appNames: this.namesMap(),
      icons: this.icons,
      days: Math.min(90, Math.max(14, this.prefs.keepHistoryDays)),
    })
  }

  private namesMap(): Map<string, string> {
    const m = new Map<string, string>()
    for (const [k, v] of Object.entries(this.data.appNames)) m.set(k, v)
    return m
  }

  private batteryState(): { charging: boolean; pct: number; noBattery: boolean } {
    const s = this.prevSample
    if (!s) return { charging: false, pct: 100, noBattery: true }
    return { charging: s.acOnline, pct: s.batteryPct, noBattery: (s.batteryFlag & 128) !== 0 }
  }

  private pushUi(): void {
    if (this.stopped) return
    const now = Date.now()
    if (now - this.lastSnapshotPush >= SNAPSHOT_PUSH_MS) {
      this.lastSnapshotPush = now
      this.onSnapshot?.(this.snapshot())
    }
    if (now - this.lastUiPush >= UI_PUSH_MS) {
      this.lastUiPush = now
      this.onUsageUpdated?.(this.dashboard())
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  markDirty(): void {
    this.dirty = true
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => void this.saveNow(), SAVE_DEBOUNCE_MS)
      this.maxWaitTimer = setTimeout(() => void this.saveNow(), SAVE_MAX_WAIT_MS)
    }
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
    this.saveTimer = this.maxWaitTimer = null
    if (!this.dirty) return
    this.dirty = false
    try {
      await this.storage.saveData()
    } catch (e) {
      this.lastError = 'Failed to write usage data: ' + String(e)
      this.markDirty()
    }
  }

  private flushSave(): void {
    void this.saveNow()
  }

  private finalizeBeforeExit(): void {
    try {
      const now = Date.now()
      this.closeCurrentSession(now, 'quit')
      this.data.updatedAt = now
      this.storage.saveDataSync()
    } catch {
      /* best effort */
    }
  }

  // -------------------------------------------------------------------------
  // Icons
  // -------------------------------------------------------------------------

  private async ensureIcon(key: string, exePath: string): Promise<void> {
    if (this.icons.has(key) || this.iconInflight.has(key)) return
    const p = extractIconDataUrl(exePath)
    this.iconInflight.set(key, p)
    const url = await p
    this.iconInflight.delete(key)
    this.icons.set(key, url)
    if (url) this.onUsageUpdated?.(this.dashboard())
  }

  iconFor(key: string): string | null {
    return this.icons.get(key) ?? null
  }

  // ---------------------------------------------------------------------------
  // Queries for the renderer pages
  // ---------------------------------------------------------------------------

  statsOverview(): StatsOverview {
    const { computeTotals, sessionStats } = require('./aggregator') as typeof import('./aggregator')
    const totals = computeTotals(this.data)
    const days = Math.max(1, totals.days)
    const { avgSessionMs, longestSession } = sessionStats(this.data)
    const overall = topAppsOverall(this.data, 1)[0] ?? null
    return {
      totals,
      avgDayActiveMs: totals.activeMs / days,
      avgDayOnMs: totals.pcOnMs / days,
      avgSessionMs,
      longestSession,
      topApp: overall ? { ...overall, name: this.data.appNames[overall.key] ?? appDisplayName(overall.key) } : null,
      activeDays: totals.days,
    }
  }

  trend(days: number): TrendData {
    const { dailyTrend } = require('./aggregator') as typeof import('./aggregator')
    const n = Math.min(365, Math.max(7, Math.round(days)))
    const points = dailyTrend(this.data, n, Date.now())
    const withData = points.filter((p) => p.activeMs > 0)
    const avg = withData.length ? withData.reduce((a, p) => a + p.activeMs, 0) / withData.length : 0
    return { points, avgBaselineMs: avg }
  }

  weekdayAverages(): WeekdayAverages {
    const buckets = new Map<number, { ms: number; days: number }>()
    for (const k of sortedDayKeys(this.data)) {
      const day = this.data.days[k]
      if (day.pcOnMs <= 0 && Object.keys(day.apps).length === 0) continue
      const wd = parseDayKey(k).getDay()
      const b = buckets.get(wd) ?? { ms: 0, days: 0 }
      b.ms += day.activeMs
      b.days += 1
      buckets.set(wd, b)
    }
    return {
      buckets: [...buckets.entries()].map(([weekday, b]) => ({
        weekday,
        activeMs: b.days > 0 ? b.ms / b.days : 0,
        days: b.days,
      })),
    }
  }

  historyPage(offset: number, limit: number): HistoryPage {
    const keys = sortedDayKeys(this.data).reverse()
    const items: DayDetail[] = []
    for (let i = offset; i < Math.min(keys.length, offset + limit); i++) {
      const day = this.data.days[keys[i]]
      items.push({
        day,
        topApps: topAppsForDay(day, 6).map((a) => ({
          ...a,
          name: this.data.appNames[a.key] ?? appDisplayName(a.key),
        })),
      })
    }
    return { items, hasMore: offset + limit < keys.length }
  }

  appDetail(key: string): (AppDetailData & { iconDataUrl: string | null }) {
    const detail = computeAppDetail(this.data, key, this.data.appNames[key] ?? appDisplayName(key))
    const exe = this.exePathFor(key)
    if (exe) void this.ensureIcon(key, exe)
    return { ...detail, iconDataUrl: this.icons.get(key) ?? null }
  }

  appsList(): AppUsageItem[] {
    const overall = topAppsOverall(this.data, 0)
    const lastUsed = new Map<string, number>()
    for (const day of Object.values(this.data.days)) {
      for (const appKey of Object.keys(day.apps)) {
        if (day.lastMs > (lastUsed.get(appKey) ?? 0)) lastUsed.set(appKey, day.lastMs)
      }
    }
    const out: AppUsageItem[] = overall.map((a) => ({
      ...a,
      name: this.data.appNames[a.key] ?? appDisplayName(a.key),
      iconDataUrl: this.icons.get(a.key) ?? null,
      lastUsedMs: lastUsed.get(a.key) ?? null,
    }))
    for (const item of out) {
      const exe = this.exePathFor(item.key)
      if (exe) void this.ensureIcon(item.key, exe)
    }
    return out
  }

  exePathFor(key: string): string | null {
    for (const [exe, ident] of this.identityCache) {
      if (ident.key === key) return exe
    }
    return null
  }

  historyDays(limit: number) {
    const keys = sortedDayKeys(this.data).reverse().slice(0, limit)
    return keys.map((k) => {
      const day = this.data.days[k]
      return {
        date: k,
        pcOnMs: day.pcOnMs,
        activeMs: day.activeMs,
        idleMs: day.idleMs,
        screenOnMs: day.screenOnMs,
        firstMs: day.firstMs,
        lastMs: day.lastMs,
        batteryMs: day.batteryMs,
        acMs: day.acMs,
        topApps: topAppsForDay(day, 5).map((a) => ({ ...a, name: this.data.appNames[a.key] ?? appDisplayName(a.key) })),
      }
    })
  }
}
