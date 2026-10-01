import type { Bridge, PageId, Prefs } from '../shared/types'

/**
 * Browser-harness only: matches package.json so About/Updates never lie.
 */
const HARNESS_VERSION = '1.3.2'

declare global {
  interface Window {
    oneboost?: Bridge
    __TAURI_INTERNALS__?: unknown
  }
}

/**
 * Tauri IPC plumbing
 * --------------------------------------------------------------------------- */

type Cmd = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

async function tauri(): Promise<{ invoke: Cmd; listen: (ev: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> }> {
  const core = (await import('@tauri-apps/api/core')) as { invoke: Cmd }
  const ev = (await import('@tauri-apps/api/event')) as {
    listen: (ev: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>
  }
  return { invoke: core.invoke, listen: ev.listen }
}

/**
 * Browser dev-harness fallback so the UI can be exercised outside Tauri.
 * It returns EMPTY data only (no invented statistics).
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
    hourlyActive: new Array(24).fill(0),
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
    transparency: 0.4,
    reducedMotion: false,
    launchAtLogin: false,
    startMinimized: false,
    pauseTracking: false,
    idleThresholdMin: 1,
    keepHistoryDays: 365,
    showTray: true,
    customCss: '',
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
    openAppDetail: (key: string) => emit('app', key),
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
    rollbackUpdate: async () => ({ ok: false, error: 'updates are disabled in this build' }),
    onUpdateState: () => () => undefined,
    setPref: async (key, value) => {
      ;(prefs as unknown as Record<string, unknown>)[key] = value
      return prefs
    },
    notifyThemeClass: async () => undefined,
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
    pagesList: async () => [],
    pageSave: async (p) => p,
    pageDelete: async () => true,
    tasksList: async () => [],
    taskSave: async (t) => t,
    taskToggle: async () => null,
    taskDelete: async () => true,
    tasksClearDone: async () => 0,
    clipsList: async () => [],
    clipPin: async () => null,
    clipDelete: async () => true,
    clipsClear: async () => 0,
    clipPaste: async () => false,
    clipCapture: async () => null,
    tagIndex: async () => ({}),
    searchEverything: async () => [],
    quickCapture: async (input) => ({ kind: 'page', title: input, id: '' }),
    fileRoots: async () => [],
    filesRecent: async () => [],
    filesSearch: async () => [],
    openFile: async () => undefined,
  }
}

// ---------------------------------------------------------------------------
// Tauri bridge — 1:1 mapping of the Electron preload surface
// ---------------------------------------------------------------------------

function createTauriBridge(): Bridge {
  let ready: ReturnType<typeof tauri> | null = null
  const T = () => (ready ??= tauri())
  const invoke: Cmd = (cmd, args) => T().then((t) => t.invoke(cmd, args))

  /** Subscribe to a Rust event; returns the unsubscribe function. */
  const on = async <T>(event: string, cb: (payload: T) => void) => {
    const t = await T()
    return t.listen(event, (e) => cb(e.payload as T))
  }

  /** Register-first helper so a push racing the subscribe is never missed.
   *  Returns a synchronous unsubscribe (queued until listen resolves). */
  async function listenBefore<T>(event: string, cb: (p: T) => void, after?: () => Promise<unknown>): Promise<() => void> {
    const un = await on<T>(event, cb)
    if (after) await after().catch(() => undefined)
    return un
  }

  /** Bridge listeners must return () => void synchronously; queue until the
   *  async listen() resolves so an early unsubscribe is still honored. */
  function sub<T>(event: string, cb: (p: T) => void, after?: () => Promise<unknown>): () => void {
    let un: (() => void) | null = null
    let cancelled = false
    void listenBefore(event, cb, after).then((u) => {
      if (cancelled) u()
      else un = u
    })
    return () => {
      if (un) un()
      else cancelled = true
    }
  }

  return {
    getInitial: () => invoke('get_initial') as Promise<Awaited<ReturnType<Bridge['getInitial']>>>,
    getDashboard: () => invoke('get_dashboard') as Promise<Awaited<ReturnType<Bridge['getDashboard']>>>,
    getMonitorSample: () => invoke('get_monitor_sample') as Promise<Awaited<ReturnType<Bridge['getMonitorSample']>>>,
    monitor: (cb) => {
      // Subscribe FIRST, then ask main for the seed sample (same ordering
      // guarantee as the Electron preload).
      return sub('oneboost://monitor', cb, () =>
        invoke('monitor_subscribe').catch(() => undefined),
      )
    },
    navigate: (page: PageId) => void invoke('navigate', { page }),
    openAppDetail: (key: string) => void invoke('open_app_detail', { key }),
    pageChanged: (cb) => sub<PageId>('oneboost://page-changed', cb),
    appDetailOpened: (cb) => sub<string>('oneboost://app-detail', cb),
    snapshot: (cb) => sub('oneboost://snapshot', cb),
    onUsageUpdated: (cb) => sub('oneboost://usage-updated', cb),
    getSettingsData: () => invoke('get_settings_data') as Promise<Awaited<ReturnType<Bridge['getSettingsData']>>>,
    repairLaunch: () => invoke('repair_launch') as Promise<Awaited<ReturnType<Bridge['repairLaunch']>>>,
    getUpdateState: () => invoke('get_update_state') as Promise<Awaited<ReturnType<Bridge['getUpdateState']>>>,
    checkForUpdates: () => invoke('check_for_updates') as Promise<Awaited<ReturnType<Bridge['checkForUpdates']>>>,
    installUpdate: () => invoke('install_update') as Promise<boolean>,
    rollbackUpdate: () =>
      invoke('rollback_update') as Promise<{ ok: boolean; version?: string; error?: string }>,
    onUpdateState: (cb) => sub('oneboost://update-state', cb),
    setPref: (key, value) =>
      invoke('set_pref', { key, value }) as Promise<Prefs>,
    notifyThemeClass: (glass) => invoke('notify_theme_class', { glass }) as Promise<void>,
    exportJson: () => invoke('export_json') as Promise<Awaited<ReturnType<Bridge['exportJson']>>>,
    clearData: () => invoke('clear_data') as Promise<{ ok: boolean; error?: string }>,
    toast: (cb) => sub<string>('oneboost://toast', cb),
    onPrefsChanged: (cb) => sub<Prefs>('oneboost://prefs-changed', cb),
    minimize: () => void invoke('minimize_window'),
    toggleMaximize: () => void invoke('toggle_maximize'),
    close: () => void invoke('close_window'),
    windowState: (cb) => sub('oneboost://window-state', cb),
    isMaximized: () => invoke('is_maximized') as Promise<boolean>,
    onOpenSettings: (cb) => sub('oneboost://open-settings', cb),
    getAppsList: () => invoke('get_apps_list') as Promise<Awaited<ReturnType<Bridge['getAppsList']>>>,
    getAppDetail: (key: string) => invoke('get_app_detail', { key }) as Promise<Awaited<ReturnType<Bridge['getAppDetail']>>>,
    getStatsOverview: () => invoke('get_stats_overview') as Promise<Awaited<ReturnType<Bridge['getStatsOverview']>>>,
    getTrend: (days: number) => invoke('get_trend', { days }) as Promise<Awaited<ReturnType<Bridge['getTrend']>>>,
    getWeekdayAverages: () => invoke('get_weekday_averages') as Promise<Awaited<ReturnType<Bridge['getWeekdayAverages']>>>,
    getHistoryPage: (offset: number, limit: number) =>
      invoke('get_history_page', { offset, limit }) as Promise<Awaited<ReturnType<Bridge['getHistoryPage']>>>,
    openDataFolder: () => void invoke('open_data_folder'),
    pagesList: () => invoke('pages_list') as Promise<Awaited<ReturnType<Bridge['pagesList']>>>,
    pageSave: (page) => invoke('page_save', { page }) as Promise<Awaited<ReturnType<Bridge['pageSave']>>>,
    pageDelete: (id) => invoke('page_delete', { id }) as Promise<boolean>,
    tasksList: () => invoke('tasks_list') as Promise<Awaited<ReturnType<Bridge['tasksList']>>>,
    taskSave: (task) => invoke('task_save', { task }) as Promise<Awaited<ReturnType<Bridge['taskSave']>>>,
    taskToggle: (id) => invoke('task_toggle', { id }) as Promise<Awaited<ReturnType<Bridge['taskToggle']>>>,
    taskDelete: (id) => invoke('task_delete', { id }) as Promise<boolean>,
    tasksClearDone: () => invoke('tasks_clear_done') as Promise<number>,
    clipsList: () => invoke('clips_list') as Promise<Awaited<ReturnType<Bridge['clipsList']>>>,
    clipPin: (id) => invoke('clip_pin', { id }) as Promise<Awaited<ReturnType<Bridge['clipPin']>>>,
    clipDelete: (id) => invoke('clip_delete', { id }) as Promise<boolean>,
    clipsClear: () => invoke('clips_clear') as Promise<number>,
    clipPaste: (id) => invoke('clip_paste', { id }) as Promise<boolean>,
    clipCapture: () => invoke('clip_capture') as Promise<Awaited<ReturnType<Bridge['clipCapture']>>>,
    tagIndex: () => invoke('tag_index') as Promise<Awaited<ReturnType<Bridge['tagIndex']>>>,
    searchEverything: (query) =>
      invoke('search_everything', { query }) as Promise<Awaited<ReturnType<Bridge['searchEverything']>>>,
    quickCapture: (input) =>
      invoke('quick_capture', { input }) as Promise<Awaited<ReturnType<Bridge['quickCapture']>>>,
    fileRoots: () => invoke('file_roots') as Promise<Awaited<ReturnType<Bridge['fileRoots']>>>,
    filesRecent: (force = false) =>
      invoke('files_recent', { force }) as Promise<Awaited<ReturnType<Bridge['filesRecent']>>>,
    filesSearch: (query, force = false) =>
      invoke('files_search', { query, force }) as Promise<Awaited<ReturnType<Bridge['filesSearch']>>>,
    openFile: (path, reveal = false) => invoke('open_file', { path, reveal }) as Promise<void>,
  }
}

export const isElectronBackend = typeof window !== 'undefined' && !!window.oneboost
export const isTauriBackend =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || 'isTauri' in window)

export const bridge: Bridge = isTauriBackend
  ? createTauriBridge()
  : window?.oneboost ?? createBrowserHarnessBridge()
