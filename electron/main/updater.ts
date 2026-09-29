// Auto-update via GitHub Releases (electron-updater).
//
// Flow: on startup (and on demand) we check the GitHub "latest" release feed.
// When a newer version exists, the installer is downloaded in the background
// and the renderer is notified so it can show a "Restart to update" prompt.
// quitAndInstall() applies it silently and relaunches the app.
//
// Update checks are inert in dev (electron-updater throws outside packaged
// apps), and a feed failure never breaks the app — it surfaces as state.error.

import { app, ipcMain, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../../shared/types'

const { autoUpdater } = electronUpdater

let state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
const listeners = new Set<(s: UpdateState) => void>()

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, currentVersion: app.getVersion() }
  for (const cb of listeners) cb(state)
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('oneboost:update-state', state)
}

function bind(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // We publish untagged drafts from CI; electron-updater only reads
  // published releases, so allow downward-prerelease style feeds off.
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: null })
  })
  autoUpdater.on('update-available', (info) => {
    setState({ status: 'downloading', availableVersion: info.version ?? null, error: null })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'up-to-date', error: null, checkedAt: Date.now() })
  })
  autoUpdater.on('download-progress', (p) => {
    setState({
      status: 'downloading',
      progress: Math.min(100, Math.max(0, Math.round(p.percent ?? 0))),
      downloadedBytes: p.transferred ?? 0,
      totalBytes: p.total ?? 0,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setState({
      status: 'ready',
      availableVersion: info.version ?? state.availableVersion ?? null,
      progress: 100,
      checkedAt: Date.now(),
    })
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('oneboost:toast', `Version ${info.version ?? ''} ready — restart to update in Settings`)
    }
  })
  autoUpdater.on('error', (err) => {
    // Keep the app usable: record the failure and return to idle.
    setState({ status: 'error', error: String(err?.message ?? err) })
  })
}

/** Start background checking (packaged builds only). Safe to call twice. */
export function initUpdater(): void {
  bind()
  if (!app.isPackaged) return
  // Small delay so first paint isn't competing with the update check.
  setTimeout(() => {
    void autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* surfaced via the error event */
    })
  }, 15_000)
  // Re-check every 6 hours.
  setInterval(
    () => {
      void autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    },
    6 * 60 * 60_000,
  )
}

export function getUpdateState(): UpdateState {
  return state
}

export function onState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Manual check from Settings. Resolves with a fresh snapshot. */
export async function checkForUpdates(): Promise<UpdateState> {
  bind()
  if (!app.isPackaged) {
    setState({ status: 'up-to-date', error: null, checkedAt: Date.now() })
    return state
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    setState({ status: 'error', error: String((e as Error)?.message ?? e) })
  }
  return state
}

/** Apply a downloaded update: quit (after tracker flush) and install. */
export function quitAndInstall(): void {
  if (state.status !== 'ready') return
  // Let the app's own before-quit flush the tracker data first.
  autoUpdater.quitAndInstall(false, true)
}

export function registerUpdaterIpc(): void {
  ipcMain.handle('oneboost:update-state', () => getUpdateState())
  ipcMain.handle('oneboost:update-check', () => checkForUpdates())
  ipcMain.handle('oneboost:update-install', () => {
    quitAndInstall()
    return true
  })
}
