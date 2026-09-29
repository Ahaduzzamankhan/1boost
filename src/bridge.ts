import type { Bridge, PageId, Prefs } from '../shared/types'

/** Browser-harness only: matches package.json so About/Updates never lie. */
const HARNESS_VERSION = '1.1.3'

declare global {
  interface Window {
    oneboost?: Bridge
  }
}

export const ACCENT_HEX: Record<Prefs['accent'], string> = {
  blue: '#3b82f6',
  violet: '#8b5cf6',
  teal: '#14b8a6',
  green: '#22c55e',
  amber: '#f59e0b',
  rose: '#f43f5e',
  sky: '#0ea5e9',
  crimson: '#dc2626',
}

export function accentHex(a: Prefs['accent']): string {
  return ACCENT_HEX[a] ?? ACCENT_HEX.blue
}

export function accentRgba(a: Prefs['accent'], alpha: number): string {
  const hex = accentHex(a)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Browser dev-harness fallback so the UI can be exercised outside Electron.
 * It returns EMPTY data only (no invented statistics) and is never used inside
 * the packaged app, where window.oneboost always exists.
 */
function createBrowserHarnessBridge(): Bridge {
  const today = {
    date: new Date().toISOString().slice(0, 10),
    pcOnMs: 0,
    activeMs: 0,
    idleMs: 0,
    screenOnMs: 0,
    firstMs: Date.now(),
    lastMs: Date.now(),
    batteryMs: 0,
    acMs: 0,
    focusMs: 0,
    apps: {},
  }
  const dashboard = {
    today,
    apps: [],
    hourly: new Array(24).fill(0),
    snapshot: {
      version: 1,
      nowMs: Date.now(),
      startedAt: Date.now(),
      day: today.date,
      pcOnMs: 0,
      activeMs: 0,
      idleMs: 0,
      screenOnMs: 0,
      paused: false,
      appKey: '',
      appName: '',
      appStartMs: 0,
      appElapsedMs: 0,
      battery: { charging: false, pct: 100, noBattery: true },
      batteryRemainingMin: null,
      lastError: null,
    },
    totals: { pcOnMs: 0, activeMs: 0, idleMs: 0, days: 0 },
    daily: [],
  }
  const prefs: Prefs = {
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
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const emit = (ch: string, ...args: unknown[]) => (listeners[ch] ?? []).forEach((f) => f(...args))
  return {
    getInitial: async () => ({
      prefs,
      dashboard,
      storage: { file: '(browser preview)', bytes: 0, recovered: false, healthy: true },
      version: HARNESS_VERSION,
      platform: 'browser',
      historyDays: [],
    }),
    getDashboard: async () => dashboard,
    getMonitorSample: async () => null,
    monitor: (cb) => {
      ;(listeners['monitor'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['monitor'] = listeners['monitor'].filter((f) => f !== cb)
      }
    },
    navigate: (page: PageId) => emit('page', page),
    openAppDetail: () => undefined,
    pageChanged: (cb) => {
      ;(listeners['page'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['page'] = listeners['page'].filter((f) => f !== cb)
      }
    },
    appDetailOpened: (cb) => {
      ;(listeners['app'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['app'] = listeners['app'].filter((f) => f !== cb)
      }
    },
    snapshot: (cb) => {
      ;(listeners['snap'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['snap'] = listeners['snap'].filter((f) => f !== cb)
      }
    },
    onUsageUpdated: (cb) => {
      ;(listeners['usage'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['usage'] = listeners['usage'].filter((f) => f !== cb)
      }
    },
    getSettingsData: async () => ({
      prefs,
      storage: { file: '(browser preview)', bytes: 0, recovered: false, healthy: true },
      version: HARNESS_VERSION,
      platform: 'browser',
      launch: { enabled: false, registered: false, pathMatches: false, needsRepair: false, registeredPath: null },
      days: [],
    }),
    repairLaunch: async () => ({
      enabled: false,
      registered: false,
      pathMatches: false,
      needsRepair: false,
      registeredPath: null,
    }),
    getUpdateState: async () => ({
      status: 'up-to-date' as const,
      currentVersion: HARNESS_VERSION,
      checkedAt: Date.now(),
    }),
    checkForUpdates: async () => ({
      status: 'up-to-date' as const,
      currentVersion: HARNESS_VERSION,
      checkedAt: Date.now(),
    }),
    installUpdate: async () => false,
    onUpdateState: () => () => undefined,
    setPref: async (key, value) => {
      ;(prefs as unknown as Record<string, unknown>)[key] = value
      return prefs
    },
    exportJson: async () => ({ ok: false }),
    clearData: async () => ({ ok: true }),
    toast: (cb) => {
      ;(listeners['toast'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['toast'] = listeners['toast'].filter((f) => f !== cb)
      }
    },
    onPrefsChanged: (cb) => {
      ;(listeners['prefs'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['prefs'] = listeners['prefs'].filter((f) => f !== cb)
      }
    },
    minimize: () => undefined,
    toggleMaximize: () => undefined,
    close: () => undefined,
    windowState: (cb) => {
      cb({ maximized: false, focused: true })
      return () => undefined
    },
    isMaximized: async () => false,
    onOpenSettings: (cb) => {
      ;(listeners['open-settings'] ??= []).push(cb as (...args: unknown[]) => void)
      return () => {
        listeners['open-settings'] = listeners['open-settings'].filter((f) => f !== cb)
      }
    },
    getAppsList: async () => [],
    getAppDetail: async () => null as unknown as Bridge['getAppDetail'] extends Promise<infer T> ? T : never,
    getStatsOverview: async () => ({
      totals: { pcOnMs: 0, activeMs: 0, idleMs: 0, days: 0 },
      avgDayActiveMs: 0,
      avgDayOnMs: 0,
      avgSessionMs: 0,
      longestSession: null,
      topApp: null,
      activeDays: 0,
    }),
    getTrend: async () => ({ points: [], avgBaselineMs: 0 }),
    getWeekdayAverages: async () => ({ buckets: [] }),
    getHistoryPage: async () => ({ items: [], hasMore: false }),
    openDataFolder: () => undefined,
  }
}

export const isElectronBackend = typeof window !== 'undefined' && !!window.oneboost

export const bridge: Bridge = window?.oneboost ?? createBrowserHarnessBridge()
