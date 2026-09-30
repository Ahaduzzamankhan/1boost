// 1Boost — Electron main process entry.

import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type {
  HistoryPage,
  PageId,
  Prefs,
  StatsOverview,
  TrendData,
  WeekdayAverages,
} from '../../shared/types'
import { Tracker } from './tracking'
import { Storage, sanitizePrefs } from './storage'
import { Monitor } from './monitor'
import { getLaunchAtLoginState, setLaunchAtLogin, syncLaunchAtLogin, type LaunchState } from './settings'
import { initUpdater, registerUpdaterIpc } from './updater'
import {
  createMainWindow,
  createTray,
  destroyTray,
  setStartHidden,
  setTrayState,
  setWindowHooks,
  showMainWindow,
  setupAppMenu,
  syncWindowGlass,
  updateTrayMenu,
} from './window'

const PAGES: PageId[] = ['dashboard', 'monitor', 'apps', 'stats', 'history', 'settings']

let storage: Storage | null = null
let tracker: Tracker | null = null
let monitor: Monitor | null = null
let launchState: LaunchState | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  bootstrap()
}

function bootstrap(): void {
  // Hidden flag: launched at login with "start minimized".
  const startHidden = process.argv.includes('--hidden') || process.argv.includes('--start-minimized')
  setStartHidden(startHidden)

  // Must match build.appId so toast notifications and the taskbar group
  // resolve to the installed app identity.
  app.setAppUserModelId('com.ahaduzzamankhan.oneboost')

  setupAppMenu()

  app.whenReady().then(async () => {
    // Load persisted state first.
    storage = new Storage()
    await storage.load()

    // Re-assert the saved launch-at-login preference: repairs stale Run-key
    // entries after updates and re-enables startup if Windows dropped it.
    // (Skipped in unpackaged dev runs so we never register electron.exe.)
    if (app.isPackaged || !storage.settings.prefs.launchAtLogin) {
      syncLaunchAtLogin(storage.settings.prefs)
        .then((s) => {
          launchState = s
        })
        .catch(() => {
          /* probed again on demand by the Settings page */
        })
    } else {
      getLaunchAtLoginState(storage.settings.prefs)
        .then((s) => {
          launchState = s
        })
        .catch(() => {
          /* probed again on demand */
        })
    }

    // Native tracking layer + orchestrator.
    tracker = new Tracker(storage)
    wireTracker()
    tracker.start()

    // System monitoring (Rust-backed). Samples continuously for the app
    // session; pushes only reach renderers that subscribed.
    monitor = new Monitor()
    monitor.registerIpc()
    monitor.start()

    // Window + tray.
    setWindowHooks({
      navigate: (page) => sendToWindow('oneboost:page-changed', page),
      onTrayPauseToggle: () => {
        const p = storage!.settings.prefs
        applyPrefInternal('pauseTracking', !p.pauseTracking)
      },
      onExit: () => tracker?.stop(),
      prefs: () => storage!.settings.prefs,
      version: () => app.getVersion(),
      dataDir: () => storage!.dataPath,
      openDataFolder: () => void shell.showItemInFolder(storage!.dataPath),
    })
    createMainWindow()
    if (storage.settings.prefs.showTray) createTray()
    updateTrayMenu(storage.settings.prefs.pauseTracking)

    registerIpc()
    registerPowerMonitor()
    registerUpdaterIpc()
    initUpdater()

    app.on('activate', () => showMainWindow())
  })

  process.on('uncaughtException', (err) => {
    console.error('[1boost] uncaught exception', err)
  })
  process.on('unhandledRejection', (err) => {
    console.error('[1boost] unhandled rejection', err)
  })
}

function wireTracker(): void {
  if (!tracker) return
  tracker.onSnapshot = (s) => sendToWindow('oneboost:snapshot', s)
  tracker.onUsageUpdated = (d) => sendToWindow('oneboost:usage-updated', d)
  tracker.onToast = (msg) => sendToWindow('oneboost:toast', msg)
}

function sendToWindow(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function applyPrefInternal(key: keyof Prefs, value: Prefs[keyof Prefs]): void {
  if (!storage) return
  const next = sanitizePrefs({ ...storage.settings.prefs, [key]: value })
  storage.settings.prefs = next
  void storage.saveSettings()
  sendToWindow('oneboost:prefs-changed', next)

  const glassy = next.theme === 'dark-glass' || next.theme === 'white-glass'
  // Opaque (solid-theme) window ↔ transparent (glass) window is a class flip;
  // Windows assigns transparency at creation, so rebuild the shell. Same-class
  // changes (accent, transparency amount) never touch the window.
  syncWindowGlass(glassy)

  if (key === 'pauseTracking') {
    setTrayState(next.pauseTracking, accentHex(next.accent))
    if (next.pauseTracking) tracker?.pause()
    else tracker?.resume()
  }
  if (key === 'launchAtLogin' || key === 'startMinimized') {
    setLaunchAtLogin(next.launchAtLogin, next.startMinimized)
    void getLaunchAtLoginState(next).then((s) => {
      launchState = s
    })
  }
  if (key === 'showTray') {
    if (!next.showTray) destroyTray()
    else createTray()
  }
}

export function accentHex(a: Prefs['accent']): string {
  const map: Record<Prefs['accent'], string> = {
    blue: '#3b82f6',
    violet: '#8b5cf6',
    teal: '#14b8a6',
    green: '#22c55e',
    amber: '#f59e0b',
    rose: '#f43f5e',
    sky: '#0ea5e9',
    crimson: '#dc2626',
  }
  return map[a] ?? map.blue
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('oneboost:get-initial', async () => {
    const prefs = storage!.settings.prefs
    return {
      prefs,
      dashboard: tracker!.dashboard(),
      storage: storage!.status(),
      version: app.getVersion(),
      platform: process.platform,
      historyDays: tracker!.historyDays(60).map((d) => ({ date: d.date, activeMs: d.activeMs, onMs: d.pcOnMs })),
    }
  })

  ipcMain.handle('oneboost:get-dashboard', async () => tracker!.dashboard())
  ipcMain.handle('oneboost:get-settings-data', async () => {
    const prefs = storage!.settings.prefs
    const launch = launchState ?? (await getLaunchAtLoginState(prefs))
    return {
      prefs,
      storage: storage!.status(),
      version: app.getVersion(),
      platform: process.platform,
      launch,
      days: tracker!.historyDays(90).map((d) => ({ date: d.date, activeMs: d.activeMs, onMs: d.pcOnMs })),
    }
  })

  ipcMain.handle('oneboost:repair-launch', async () => {
    const prefs = storage!.settings.prefs
    setLaunchAtLogin(prefs.launchAtLogin, prefs.startMinimized)
    launchState = await getLaunchAtLoginState(prefs)
    return launchState
  })

  ipcMain.handle('oneboost:set-pref', async (_e, key: string, value: unknown) => {
    const allowed: (keyof Prefs)[] = [
      'theme', 'accent', 'transparency', 'reducedMotion', 'launchAtLogin',
      'startMinimized', 'pauseTracking', 'idleThresholdMin', 'keepHistoryDays', 'showTray',
    ]
    if (!allowed.includes(key as keyof Prefs)) throw new Error('Unknown setting: ' + key)
    applyPrefInternal(key as keyof Prefs, value as Prefs[keyof Prefs])
    return storage!.settings.prefs
  })

  ipcMain.handle('oneboost:theme-class', (_e, glass: unknown) => {
    if (typeof glass === 'boolean') syncWindowGlass(glass)
  })

  ipcMain.handle('oneboost:export-json', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export usage data',
      defaultPath: '1boost-usage-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if ( canceled || !filePath) return { ok: false, canceled: true }
    try {
      await fs.writeFile(filePath, JSON.stringify(storage!.data, null, 2), 'utf8')
      return { ok: true, path: filePath }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('oneboost:clear-data', async () => {
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete all usage data',
      message: 'Delete all usage data?',
      detail: 'This permanently removes all collected usage history. This cannot be undone.',
    })
    if (r.response !== 1) return { ok: false }
    try {
      await storage!.deleteAll()
      tracker?.refreshAfterDataReset()
      sendToWindow('oneboost:usage-updated', tracker!.dashboard())
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  // Window controls
  ipcMain.on('oneboost:minimize', () => BrowserWindow.getAllWindows()[0]?.minimize())
  ipcMain.on('oneboost:toggle-maximize', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('oneboost:is-maximized', () => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    const push = () => {
      if (!win.isDestroyed()) {
        win.webContents.send('oneboost:window-state', {
          maximized: win.isMaximized(),
          focused: win.isFocused(),
        })
      }
    }
    win.on('maximize', push)
    win.on('unmaximize', push)
    win.on('focus', push)
    win.on('blur', push)
  }
  ipcMain.on('oneboost:close', () => {
    BrowserWindow.getAllWindows()[0]?.hide()
  })
  ipcMain.on('oneboost:navigate', (_e, page: string) => {
    if (PAGES.includes(page as PageId)) sendToWindow('oneboost:page-changed', page as PageId)
  })
  ipcMain.on('oneboost:open-app-detail', (_e, key: string) => {
    if (typeof key === 'string' && key.length <= 64) sendToWindow('oneboost:app-detail', key)
  })
  ipcMain.on('oneboost:open-data-folder', () => {
    void shell.showItemInFolder(storage!.dataPath)
  })

  ipcMain.handle('oneboost:get-stats-overview', async (): Promise<StatsOverview> => tracker!.statsOverview())
  ipcMain.handle('oneboost:get-trend', async (_e, days: number): Promise<TrendData> => tracker!.trend(days))
  ipcMain.handle('oneboost:get-weekday-averages', async (): Promise<WeekdayAverages> => tracker!.weekdayAverages())
  ipcMain.handle('oneboost:get-history-page', async (_e, offset: number, limit: number): Promise<HistoryPage> =>
    tracker!.historyPage(offset, limit),
  )
  ipcMain.handle('oneboost:get-app-detail', async (_e, key: string) => tracker!.appDetail(key))
  ipcMain.handle('oneboost:get-apps-list', async () => tracker!.appsList())
}

// ---------------------------------------------------------------------------
// Power monitor
// ---------------------------------------------------------------------------

function registerPowerMonitor(): void {
  // The native layer reports these too; this is a belt-and-braces mirror via
  // Electron's own events (used if the native pump was unavailable).
  powerMonitor.on('suspend', () => tracker?.onPowerEvent('sleep'))
  powerMonitor.on('resume', () => tracker?.onPowerEvent('resume'))
  powerMonitor.on('lock-screen', () => tracker?.onPowerEvent('lock'))
  powerMonitor.on('unlock-screen', () => tracker?.onPowerEvent('unlock'))
  powerMonitor.on('shutdown', () => tracker?.onPowerEvent('shutdown'))
}

app.on('window-all-closed', () => {
  // Keep running in the tray; quit only via the tray menu / Exit.
})

app.on('before-quit', () => {
  tracker?.stop()
  monitor?.stop()
})
