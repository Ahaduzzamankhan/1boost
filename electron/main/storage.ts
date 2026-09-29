// Persistent JSON storage for 1Boost: atomic writes, corruption recovery,
// settings persistence, and derived-history bookkeeping.

import { promises as fs, statSync, writeFileSync, renameSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Prefs, UsageData } from '../../shared/types'
import { rebuildTotals } from './aggregator'

const DATA_VERSION = 1
/** Rolling backup copies kept next to the data file. */
const BACKUP_COUNT = 3
/** Minimum interval between backup rotations (saves can be very frequent). */
const BACKUP_MIN_INTERVAL_MS = 5 * 60_000

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

const SETTINGS_VERSION = 1

export interface SettingsFile {
  version: number
  prefs: Prefs
}

export class Storage {
  readonly dataPath: string
  readonly settingsPath: string
  data: UsageData
  settings: SettingsFile
  recovered = false
  lastError: string | null = null
  private lastBackupAt = 0

  constructor(dataPath?: string, settingsPath?: string) {
    const userData = dataPath ?? (app.isReady() ? app.getPath('userData') : undefined)
    const base = userData ?? join(process.cwd(), '.1boost-user-data')
    this.dataPath = dataPath ?? join(base, 'usage-data.json')
    this.settingsPath = settingsPath ?? join(base, 'settings.json')
    this.data = emptyUsage()
    this.settings = { version: SETTINGS_VERSION, prefs: { ...DEFAULT_PREFS } }
  }

  /** Load data + settings from disk, repairing corruption automatically. */
  async load(): Promise<void> {
    await this.ensureDirs()
    await this.loadData()
    await this.loadSettings()
    // Once a healthy file is settled, take a fresh snapshot of it.
    if (!this.recovered) this.writeBackup(0)
  }

  /** Copy the healthy data file to a numbered rolling backup slot. */
  private writeBackup(slot: number): void {
    if (!existsSync(this.dataPath)) return
    try {
      copyFileSync(this.dataPath, this.backupPath(slot))
    } catch {
      /* backup is best-effort; never block loading */
    }
  }

  private backupPath(slot: number): string {
    return `${this.dataPath}.bak${slot}`
  }

  /**
   * After every successful save, rotate backups so a later crash / disk issue
   * can never destroy the last known-good copies (slots 0..BACKUP_COUNT-1).
   */
  private rotateBackups(): void {
    for (let i = BACKUP_COUNT - 1; i > 0; i--) {
      const older = this.backupPath(i - 1)
      if (existsSync(older)) {
        try {
          copyFileSync(older, this.backupPath(i))
        } catch {
          /* best-effort */
        }
      }
    }
    this.writeBackup(0)
  }

  /** Best-effort rebuild of the newest backup after a successful save. */
  private scheduleBackup(): void {
    try {
      const now = Date.now()
      if (now - this.lastBackupAt < BACKUP_MIN_INTERVAL_MS) return
      this.lastBackupAt = now
      this.rotateBackups()
    } catch {
      /* never fail a save because of backups */
    }
  }

  /**
   * Try to recover data from the rolling backups when the primary file is
   * unreadable. Returns true if a backup was restored.
   */
  private tryRecoverFromBackups(): boolean {
    for (let slot = 0; slot < BACKUP_COUNT; slot++) {
      const p = this.backupPath(slot)
      if (!existsSync(p)) continue
      try {
        const raw = readFileSync(p, 'utf8')
        const parsed = JSON.parse(raw) as UsageData
        if (parsed && typeof parsed === 'object' && typeof parsed.days === 'object' && parsed.days !== null) {
          // Primary file is untrustworthy; replace it with the good backup.
          try {
            copyFileSync(p, this.dataPath)
          } catch {
            /* fall through to in-memory recovery below */
          }
          this.data = normalizeUsageData(parsed)
          rebuildTotals(this.data)
          this.recovered = true
          this.lastError = 'Your usage file was damaged; 1Boost restored the most recent backup.'
          return true
        }
      } catch {
        /* try next slot */
      }
    }
    return false
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(dirname(this.dataPath), { recursive: true })
    await fs.mkdir(dirname(this.settingsPath), { recursive: true })
  }

  private async readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; error: string; exists: boolean }> {
    try {
      const raw = await fs.readFile(path, 'utf8')
      return { ok: true, value: JSON.parse(raw) as T }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return { ok: false, error: 'missing', exists: false }
      return { ok: false, error: String(err.message ?? err), exists: true }
    }
  }

  private async loadData(): Promise<void> {
    const res = await this.readJson<UsageData>(this.dataPath)
    if (res.ok) {
      const v = res.value
      if (v && typeof v === 'object' && typeof v.days === 'object' && v.days !== null) {
        this.data = normalizeUsageData(v)
        rebuildTotals(this.data)
        return
      }
      // Recognizable file but wrong shape: try backups before giving up.
      if (this.tryRecoverFromBackups()) return
      this.recovered = true
      this.lastError = 'Unrecognized data file format; starting fresh.'
      return
    }
    if (res.exists) {
      // Primary file is unreadable (truncated JSON, encoding error, etc.) —
      // try the rolling backups before starting from zero.
      if (this.tryRecoverFromBackups()) return
      this.recovered = true
      this.lastError = 'Your usage file could not be read and no backup was usable. 1Boost will rebuild it automatically.'
    }
  }

  private async loadSettings(): Promise<void> {
    const res = await this.readJson<SettingsFile>(this.settingsPath)
    if (res.ok) {
      const p = res.value?.prefs
      if (p && typeof p === 'object') {
        this.settings = { version: SETTINGS_VERSION, prefs: sanitizePrefs(p) }
        return
      }
      this.recovered = true
      return
    }
    if (res.exists) {
      this.recovered = true
      this.lastError ||= 'Your settings file could not be read; defaults were restored.'
    }
  }

  /** Write settings atomically (tmp file + rename). */
  async saveSettings(): Promise<void> {
    await this.ensureDirs()
    this.settings = { version: SETTINGS_VERSION, prefs: this.settings.prefs }
    const tmp = this.settingsPath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    await fs.rename(tmp, this.settingsPath)
  }

  /** Write usage data atomically (tmp file + rename); rotated backups follow. */
  async saveData(): Promise<void> {
    await this.ensureDirs()
    this.data.updatedAt = Date.now()
    const tmp = this.dataPath + '.tmp'
    const payload = JSON.stringify(this.data)
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, this.dataPath)
    this.scheduleBackup()
  }

  /**
   * Synchronous atomic write for exit-time flushes. Also used for
   * suspend/shutdown critical saves where async writes may never complete.
   */
  saveDataSync(): void {
    this.data.updatedAt = Date.now()
    const tmp = this.dataPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
    renameSync(tmp, this.dataPath)
  }

  async deleteAll(): Promise<void> {
    this.data = emptyUsage()
    await this.ensureDirs()
    await fs.rm(this.dataPath, { force: true })
    await this.saveData()
    // Remove stale backups so a deleted history can't silently resurrect.
    for (let slot = 0; slot < BACKUP_COUNT; slot++) {
      try {
        await fs.rm(this.backupPath(slot), { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  status(): { file: string; bytes: number; recovered: boolean; healthy: boolean } {
    try {
      const st = statSync(this.dataPath) as { size: number }
      return { file: this.dataPath, bytes: st.size, recovered: this.recovered, healthy: !this.recovered }
    } catch {
      return { file: this.dataPath, bytes: 0, recovered: this.recovered, healthy: !this.recovered }
    }
  }
}

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

/** Lenient pref sanitizer used at load + write boundaries (subset clamp). */
export function sanitizePrefs(p: Partial<Prefs>): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS }
  const themes: Prefs['theme'][] = ['dark-glass', 'white-glass', 'solid-dark', 'solid-white', 'amoled']
  if (typeof p.theme === 'string' && themes.includes(p.theme as Prefs['theme'])) out.theme = p.theme as Prefs['theme']
  const accents: Prefs['accent'][] = ['blue', 'violet', 'teal', 'green', 'amber', 'rose', 'sky', 'crimson']
  if (typeof p.accent === 'string' && accents.includes(p.accent as Prefs['accent'])) out.accent = p.accent as Prefs['accent']
  if (typeof p.transparency === 'number' && Number.isFinite(p.transparency)) out.transparency = Math.min(1, Math.max(0, p.transparency))
  if (typeof p.reducedMotion === 'boolean') out.reducedMotion = p.reducedMotion
  if (typeof p.launchAtLogin === 'boolean') out.launchAtLogin = p.launchAtLogin
  if (typeof p.startMinimized === 'boolean') out.startMinimized = p.startMinimized
  if (typeof p.pauseTracking === 'boolean') out.pauseTracking = p.pauseTracking
  if (typeof p.idleThresholdMin === 'number' && Number.isFinite(p.idleThresholdMin)) {
    out.idleThresholdMin = Math.min(120, Math.max(1, Math.round(p.idleThresholdMin)))
  }
  if (typeof p.keepHistoryDays === 'number' && Number.isFinite(p.keepHistoryDays)) {
    out.keepHistoryDays = Math.min(3650, Math.max(7, Math.round(p.keepHistoryDays)))
  }
  if (typeof p.showTray === 'boolean') out.showTray = p.showTray
  return out
}
