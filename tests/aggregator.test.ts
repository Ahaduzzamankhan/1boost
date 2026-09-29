import { describe, expect, it } from 'vitest'
import {
  accumulateLiveSession,
  applySampleToDay,
  closeSession,
  computeTotals,
  dailyTrend,
  dayKey,
  emptyDay,
  ensureDay,
  openSession,
  parseDayKey,
  topAppsForDay,
  trimToRetention,
} from '../electron/main/aggregator'
import { emptyUsage } from '../electron/main/storage'
import { formatDuration, formatDurationShort, formatPercent } from '../src/lib/format'
import { DEFAULT_PREFS } from '../electron/main/storage'

describe('dayKey', () => {
  it('formats local day keys', () => {
    // 2026-09-28 12:00 local
    const ms = new Date(2026, 8, 28, 12, 30).getTime()
    expect(dayKey(ms)).toBe('2026-09-28')
  })

  it('round-trips through parseDayKey', () => {
    const ms = new Date(2026, 0, 5, 23, 59).getTime()
    const key = dayKey(ms)
    const d = parseDayKey(key)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(5)
  })
})

describe('day buckets', () => {
  it('ensureDay creates and reuses buckets', () => {
    const data = emptyUsage()
    const k = '2026-09-28'
    const d1 = ensureDay(data, k, 1_000)
    d1.pcOnMs += 5_000
    const d2 = ensureDay(data, k, 2_000)
    expect(d2.pcOnMs).toBe(5_000)
    expect(Object.keys(data.days).length).toBe(1)
  })

  it('applySampleToDay accumulates active/idle separately', () => {
    const day = emptyDay('2026-09-28', 0)
    const s = {
      ok: true,
      foregroundOk: true,
      hasWindow: true,
      screenOn: true,
      consoleLocked: false,
      activeSession: true,
      inputActive: true,
      idleMs: 0,
      acOnline: true,
      batteryPct: 100,
      batteryFlag: 1,
      uptimeMs: 0,
      nowEpochMs: 1_000,
      processId: 1,
      processName: 'x',
      isFullscreen: false,
      batteryRemainingMin: -1,
    }
    applySampleToDay({ sample: s, prev: null, deltaMs: 1_000, day, appKey: 'a', appName: 'A' })
    applySampleToDay({
      sample: { ...s, inputActive: false },
      prev: null,
      deltaMs: 500,
      day,
      appKey: 'a',
      appName: 'A',
    })
    expect(day.pcOnMs).toBe(1_500)
    expect(day.activeMs).toBe(1_000)
    expect(day.idleMs).toBe(500)
    expect(day.acMs).toBe(1_500)
    expect(day.focusMs).toBe(0)
  })

  it('applySampleToDay accumulates focusMs only for active fullscreen samples', () => {
    const day = emptyDay('2026-09-28', 0)
    const s = {
      ok: true,
      foregroundOk: true,
      hasWindow: true,
      screenOn: true,
      consoleLocked: false,
      activeSession: true,
      inputActive: true,
      idleMs: 0,
      acOnline: true,
      batteryPct: 100,
      batteryFlag: 1,
      uptimeMs: 0,
      nowEpochMs: 1_000,
      processId: 1,
      processName: 'x',
      isFullscreen: true,
      batteryRemainingMin: 120,
    }
    applySampleToDay({ sample: s, prev: null, deltaMs: 2_000, day, appKey: 'game', appName: 'Game' })
    applySampleToDay({
      sample: { ...s, inputActive: false },
      prev: null,
      deltaMs: 1_000,
      day,
      appKey: 'game',
      appName: 'Game',
    })
    expect(day.focusMs).toBe(2_000)
    expect(day.activeMs).toBe(2_000)
  })

  it('topAppsForDay sorts descending', () => {
    const day = emptyDay('2026-09-28', 0)
    day.apps = { chrome: 100, zed: 500, discord: 250 }
    const top = topAppsForDay(day, 2)
    expect(top.map((a) => a.key)).toEqual(['zed', 'discord'])
  })
})

describe('totals + trend', () => {
  it('computeTotals sums days', () => {
    const data = emptyUsage()
    const d1 = ensureDay(data, '2026-09-27', 0)
    d1.pcOnMs = 100
    d1.activeMs = 60
    const d2 = ensureDay(data, '2026-09-28', 0)
    d2.pcOnMs = 200
    d2.activeMs = 90
    const t = computeTotals(data)
    expect(t.pcOnMs).toBe(300)
    expect(t.activeMs).toBe(150)
    expect(t.days).toBe(2)
  })

  it('dailyTrend zero-fills missing days, oldest first', () => {
    const data = emptyUsage()
    const today = new Date()
    const key = dayKey(today.getTime())
    ensureDay(data, key, 0).activeMs = 42
    const points = dailyTrend(data, 7, today.getTime())
    expect(points.length).toBe(7)
    expect(points[6].date).toBe(key)
    expect(points[6].activeMs).toBe(42)
    expect(points[0].activeMs).toBe(0)
  })
})

describe('sessions', () => {
  it('open/close records a session with accumulated time', () => {
    const data = emptyUsage()
    openSession(data, 1_000)
    accumulateLiveSession(data, 10_000, true, 1_000)
    accumulateLiveSession(data, 5_000, false, 11_000)
    const s = closeSession(data, 20_000, 'sleep')
    expect(s).not.toBeNull()
    expect(s!.onMs).toBe(15_000)
    expect(s!.activeMs).toBe(10_000)
    expect(s!.idleMs).toBe(5_000)
    expect(s!.sleep).toBe(true)
    expect(data.sessions.length).toBe(1)
  })

  it('closing with no open session returns null', () => {
    const data = emptyUsage()
    expect(closeSession(data, 1_000, 'lock')).toBeNull()
  })
})

describe('retention', () => {
  it('trims days older than the retention window', () => {
    const data = emptyUsage()
    const now = new Date(2026, 8, 28, 12).getTime()
    ensureDay(data, '2025-01-01', 0).pcOnMs = 1
    ensureDay(data, '2026-09-28', 0).pcOnMs = 2
    trimToRetention(data, 30, now)
    expect(data.days['2025-01-01']).toBeUndefined()
    expect(data.days['2026-09-28']).toBeDefined()
  })
})

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(59_999)).toBe('1m')
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(3_600_000 + 42 * 60_000)).toBe('1h 42m')
    expect(formatDurationShort(3_600_000 + 5 * 60_000)).toBe('1:05')
  })

  it('formats percentages', () => {
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(0.123, 1)).toBe('12.3%')
  })
})

describe('pref defaults', () => {
  it('have sane defaults', () => {
    expect(DEFAULT_PREFS.theme).toBe('dark-glass')
    expect(DEFAULT_PREFS.idleThresholdMin).toBe(1)
    expect(DEFAULT_PREFS.keepHistoryDays).toBeGreaterThanOrEqual(7)
  })
})

describe('usage data normalization', () => {
  it('fills focusMs with 0 when loading legacy data without it', async () => {
    const legacy = {
      version: 1,
      createdAt: 1_000,
      updatedAt: 2_000,
      days: {
        '2026-09-28': {
          date: '2026-09-28',
          pcOnMs: 3_600_000,
          activeMs: 2_400_000,
          idleMs: 1_200_000,
          screenOnMs: 3_600_000,
          firstMs: 0,
          lastMs: 0,
          batteryMs: 0,
          acMs: 0,
          apps: { chrome: 1_800_000 },
        },
      },
      sessions: [],
      totals: { pcOnMs: 0, activeMs: 0, idleMs: 0, days: 0 },
      pendingSession: null,
      appNames: {},
    }
    const { normalizeUsageData } = await import('../electron/main/storage')
    const normalized = normalizeUsageData(legacy as never)
    expect(normalized.days['2026-09-28'].focusMs).toBe(0)
    expect(normalized.days['2026-09-28'].activeMs).toBe(2_400_000)
  })
})
