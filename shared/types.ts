// Shared types for 1Boost (mirrors native FFI structs and storage schema).

export type ThemeId = 'dark-glass' | 'white-glass' | 'solid-dark' | 'solid-white' | 'amoled'
export type AccentId =
  | 'blue' | 'violet' | 'teal' | 'green' | 'amber' | 'rose' | 'sky' | 'crimson'

export interface AppIdentity {
  /** Lowercased file name without extension, e.g. "chrome". */
  key: string
  /** Display name, e.g. "Google Chrome". */
  name: string
  /** Absolute path, when resolvable. */
  path?: string
}

/** One native tracking sample (mirrors BoostSampleResult). */
export interface BoostSample {
  ok: boolean
  foregroundOk: boolean
  hasWindow: boolean
  screenOn: boolean
  consoleLocked: boolean
  activeSession: boolean
  inputActive: boolean
  idleMs: number
  acOnline: boolean
  batteryPct: number
  batteryFlag: number
  uptimeMs: number
  nowEpochMs: number
  processId: number
  processName: string
}

export type BoostEventKind =
  | 'sleep' | 'resume' | 'lock' | 'unlock' | 'monitor-on' | 'monitor-off'
  | 'power-source' | 'battery' | 'session' | 'display' | 'shutdown' | 'quit'

export interface BoostEvent {
  kind: BoostEventKind
  value: number
  atMs: number
}

export interface Prefs {
  theme: ThemeId
  accent: AccentId
  transparency: number
  reducedMotion: boolean
  launchAtLogin: boolean
  startMinimized: boolean
  pauseTracking: boolean
  idleThresholdMin: number
  keepHistoryDays: number
  showTray: boolean
}

export interface LiveSnapshot {
  version: number
  nowMs: number
  startedAt: number
  day: string
  pcOnMs: number
  activeMs: number
  idleMs: number
  screenOnMs: number
  paused: boolean
  appKey: string
  appName: string
  appStartMs: number
  appElapsedMs: number
  battery: { charging: boolean; pct: number; noBattery: boolean }
  lastError: string | null
}

export interface AppAgg {
  key: string
  name: string
  ms: number
}

export interface DayData {
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  pcOnMs: number
  activeMs: number
  idleMs: number
  screenOnMs: number
  /** First epoch ms and last epoch ms seen during the day. */
  firstMs: number
  lastMs: number
  batteryMs: number
  acMs: number
  apps: Record<string, number>
}

export interface Session {
  id: string
  startMs: number
  endMs: number
  /** ms active / ms total within this session */
  activeMs: number
  onMs: number
  idleMs: number
  sleep: boolean
}

export interface UsageData {
  version: number
  createdAt: number
  updatedAt: number
  days: Record<string, DayData>
  sessions: Session[]
  totals: { pcOnMs: number; activeMs: number; idleMs: number; days: number }
  /** Session currently being accumulated (not yet closed). */
  pendingSession?: { startMs: number; activeMs: number; onMs: number; idleMs: number } | null
  /** Known friendly display names for app keys. */
  appNames: Record<string, string>
}

export interface AppDetailData {
  identity: { key: string; name: string; path?: string }
  totalMs: number
  activeShare: number
  lastUsedMs: number | null
  perDay: { date: string; ms: number }[]
}

// ---- IPC channel payloads (main <-> renderer) ------------------------------

export interface DayDetail {
  day: DayData
  topApps: AppAgg[]
}

export interface HistoryPage {
  items: DayDetail[]
  hasMore: boolean
}

export interface StatsOverview {
  totals: UsageData['totals']
  avgDayActiveMs: number
  avgDayOnMs: number
  avgSessionMs: number
  longestSession: Session | null
  topApp: AppAgg | null
  activeDays: number
}

export interface TrendPoint {
  date: string
  activeMs: number
  onMs: number
}

export interface TrendData {
  points: TrendPoint[]
  avgBaselineMs: number
}

export interface WeekdayAverages {
  /** 0 = Sunday … 6 = Saturday */
  buckets: { weekday: number; activeMs: number; days: number }[]
}

export interface AppUsageItem extends AppAgg {
  iconDataUrl: string | null
  lastUsedMs: number | null
}

export interface DashboardData {
  today: DayData
  apps: AppUsageItem[]
  hourly: number[]
  snapshot: LiveSnapshot
  totals: UsageData['totals']
  daily: TrendPoint[]
}

export interface StorageStatus {
  file: string
  bytes: number
  recovered: boolean
  healthy: boolean
}

export interface VideoExportResult {
  ok: boolean
  path?: string
  error?: string
}

export interface Bridge {
  getInitial: () => Promise<{
    prefs: Prefs
    dashboard: DashboardData
    storage: StorageStatus
    version: string
    platform: string
    historyDays: { date: string; activeMs: number; onMs: number }[]
  }>
  getDashboard: () => Promise<DashboardData>
  navigate: (page: PageId) => void
  openAppDetail: (key: string) => void
  pageChanged: (cb: (page: PageId) => void) => () => void
  appDetailOpened: (cb: (key: string) => void) => () => void
  snapshot: (cb: (s: LiveSnapshot) => void) => () => void
  onUsageUpdated: (cb: (d: DashboardData) => void) => () => void
  getSettingsData: () => Promise<{
    prefs: Prefs
    storage: StorageStatus
    version: string
    platform: string
    days: { date: string; activeMs: number; onMs: number }[]
  }>
  setPref: (key: string, value: string | number | boolean) => Promise<Prefs>
  exportJson: () => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  clearData: () => Promise<{ ok: boolean; error?: string }>
  toast: (cb: (msg: string) => void) => () => void
  onPrefsChanged: (cb: (prefs: Prefs) => void) => () => void
  windowState: (cb: (s: { maximized: boolean; focused: boolean }) => void) => () => void
  onOpenSettings: (cb: () => void) => () => void
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  getAppsList: () => Promise<AppUsageItem[]>
  getAppDetail: (key: string) => Promise<(Omit<AppDetailData, 'identity'> & { identity: { key: string; name: string }; iconDataUrl: string | null })>
  getStatsOverview: () => Promise<StatsOverview>
  getTrend: (days: number) => Promise<TrendData>
  getWeekdayAverages: () => Promise<WeekdayAverages>
  getHistoryPage: (offset: number, limit: number) => Promise<HistoryPage>
  openDataFolder: () => void
}

export type PageId = 'dashboard' | 'apps' | 'stats' | 'history' | 'settings'

export interface ToastMsg {
  id: number
  message: string
}
