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
  /** Foreground window covers its monitor (fullscreen game / video). */
  isFullscreen: boolean
  /** Windows estimate of remaining battery minutes; -1 = unknown / on AC. */
  batteryRemainingMin: number
}

export type BoostEventKind =
  | 'sleep' | 'resume' | 'lock' | 'unlock' | 'monitor-on' | 'monitor-off'
  | 'power-source' | 'battery' | 'session' | 'display' | 'shutdown' | 'quit'

export interface BoostEvent {
  kind: BoostEventKind
  value: number
  atMs: number
}

// ---- System monitoring (Rust layer → main → renderer) ----------------------

export interface MonitorDrive {
  /** Drive letter without colon, e.g. "C". */
  letter: string
  totalBytes: number
  freeBytes: number
}

/**
 * One system-monitoring snapshot. Metrics the OS cannot provide are `null` —
 * the UI must render those as "unavailable", never guess.
 */
export interface MonitorSample {
  ok: boolean
  nowMs: number
  cpu: {
    /** 0..=100, or null while unavailable (e.g. first sample). */
    usage: number | null
    /** °C, or null when no usable sensor exists. */
    tempC: number | null
    name: string
    cores: number
  }
  memory: {
    usedBytes: number
    totalBytes: number
  }
  gpu: {
    usage: number | null
    tempC: number | null
    /** Bytes in use; 0 = unavailable. */
    memUsedBytes: number
    memTotalBytes: number
    name: string
  }
  disk: {
    readBps: number | null
    writeBps: number | null
    /** 0..=100 disk activity, or null. */
    activePct: number | null
  }
  network: {
    downloadBps: number | null
    uploadBps: number | null
    /** Description of the busiest active adapter, when known. */
    interface: string | null
  }
  drives: MonitorDrive[]
  os: {
    name: string
    version: string
  }
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

/** Windows login-item state as probed from the main process. */
export interface LaunchState {
  enabled: boolean
  registered: boolean
  pathMatches: boolean
  needsRepair: boolean
  registeredPath: string | null
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
  /** Estimated minutes of battery life remaining (null when on AC / no battery). */
  batteryRemainingMin: number | null
  lastError: string | null
}

export interface AppAgg {
  key: string
  name: string
  ms: number
}

export interface DayData {
  /** PC-on milliseconds per local hour (index = local hour). Optional so data
      files written before 1.3.1 still typecheck. */
  hours?: number[]
  /** Same buckets, active time only. */
  activeHours?: number[]
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
  /** Active time in the focused (fullscreen) foreground app. */
  focusMs: number
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
  /** Same 24 buckets, active time only. */
  hourlyActive: number[]
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

export interface SettingsPayload {
  prefs: Prefs
  storage: StorageStatus
  version: string
  platform: string
  launch: LaunchState
  days: { date: string; activeMs: number; onMs: number }[]
}

export interface VideoExportResult {
  ok: boolean
  path?: string
  error?: string
}

/** Auto-update lifecycle as surfaced in Settings. */
export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Version currently running. */
  currentVersion: string
  /** Newer version being downloaded / downloaded, when one exists. */
  availableVersion?: string | null
  /** Download progress 0..100 while status is 'downloading'. */
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
  /** Set when status is 'error'. */
  error?: string | null
  /** Epoch ms of the last completed check. */
  checkedAt?: number
  /**
   * Which updater path produced this update: 'delta' when the new artifact was
   * rebuilt locally from a patch, 'full' when it was downloaded whole.
   */
  mode?: 'delta' | 'full' | null
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
  /** Latest system-monitoring snapshot (null when the native layer is missing). */
  getMonitorSample: () => Promise<MonitorSample | null>
  /** Subscribe to live monitoring pushes; returns an unsubscribe function. */
  monitor: (cb: (s: MonitorSample) => void) => () => void
  navigate: (page: PageId) => void
  openAppDetail: (key: string) => void
  pageChanged: (cb: (page: PageId) => void) => () => void
  appDetailOpened: (cb: (key: string) => void) => () => void
  snapshot: (cb: (s: LiveSnapshot) => void) => () => void
  onUsageUpdated: (cb: (d: DashboardData) => void) => () => void
  getSettingsData: () => Promise<SettingsPayload>
  repairLaunch: () => Promise<LaunchState>
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  installUpdate: () => Promise<boolean>
  /** Reinstall the newest cached payload older than this build, if any. */
  rollbackUpdate: () => Promise<{ ok: boolean; version?: string; error?: string }>
  onUpdateState: (cb: (s: UpdateState) => void) => () => void
  setPref: (key: string, value: string | number | boolean) => Promise<Prefs>
  /** Renderer reports the current theme's window class (glass = transparent). */
  notifyThemeClass: (glass: boolean) => Promise<void>
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
  // Productivity vault ---------------------------------------------------
  notesList: () => Promise<Note[]>
  noteSave: (note: Note) => Promise<Note>
  noteDelete: (id: string) => Promise<boolean>
  tasksList: () => Promise<Task[]>
  taskSave: (task: Task) => Promise<Task>
  taskToggle: (id: string) => Promise<Task | null>
  taskDelete: (id: string) => Promise<boolean>
  tasksClearDone: () => Promise<number>
  clipsList: () => Promise<Clip[]>
  clipPin: (id: string) => Promise<Clip | null>
  clipDelete: (id: string) => Promise<boolean>
  clipsClear: () => Promise<number>
  clipPaste: (id: string) => Promise<boolean>
  clipCapture: () => Promise<Clip | null>
  tagIndex: () => Promise<Record<string, number>>
  searchEverything: (query: string) => Promise<SearchHit[]>
  quickCapture: (input: string) => Promise<CaptureResult>
  // File tools ----------------------------------------------------------
  fileRoots: () => Promise<RootFolder[]>
  filesRecent: (force?: boolean) => Promise<FileEntry[]>
  filesSearch: (query: string, force?: boolean) => Promise<FileEntry[]>
  openFile: (path: string, reveal?: boolean) => Promise<void>
}

// ---- Productivity vault (notes / tasks / clipboard) ------------------------

export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  createdMs: number
  updatedMs: number
}

export interface Task {
  id: string
  title: string
  done: boolean
  dueMs?: number | null
  /** 0 = none, 1 = low, 2 = medium, 3 = high. */
  priority: number
  tags: string[]
  createdMs: number
  updatedMs: number
  completedMs?: number | null
}

export interface Clip {
  id: string
  text: string
  pinned: boolean
  createdMs: number
}

export interface FileEntry {
  name: string
  path: string
  modifiedMs: number
  size: number
  folder: string
  ext: string
}

export interface RootFolder {
  label: string
  path: string
  exists: boolean
}

export interface SearchHit {
  kind: 'note' | 'task' | 'app'
  id: string
  title: string
  subtitle: string
  score: number
  target: string
}

export interface CaptureResult {
  kind: 'note' | 'task'
  title: string
  id: string
}

export type PageId =
  // existing tracking surfaces
  | 'dashboard'
  | 'monitor'
  | 'apps'
  | 'stats'
  | 'history'
  | 'settings'
  // productivity modules
  | 'notes'
  | 'tasks'
  | 'clipboard'
  | 'calendar'
  | 'utilities'
  | 'devtools'
  | 'files'

export interface ToastMsg {
  id: number
  message: string
}
