// Window + tray management: frameless main window, hide-to-tray behavior,
// native-feeling tray menu, single-instance locking.

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
} from 'electron'
import { join } from 'node:path'
import type { PageId } from '../../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let startHidden = false

export interface WindowHooks {
  navigate: (page: PageId) => void
  onTrayPauseToggle: () => void
  onExit: () => void
  prefs: () => { startMinimized: boolean; showTray: boolean; reducedMotion: boolean; accent: string }
  version: () => string
  dataDir: () => string
  openDataFolder: () => void
}

let hooks: WindowHooks | null = null

export function setWindowHooks(h: WindowHooks): void {
  hooks = h
}

export function setStartHidden(v: boolean): void {
  startHidden = v
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function showMainWindow(page?: PageId): void {
  const win = getMainWindow()
  if (!win) return
  if (page) hooks?.navigate(page)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function toggleMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) {
    win.hide()
  } else {
    showMainWindow()
  }
}

export function createMainWindow(): BrowserWindow {
  const preloader = join(__dirname, '../preload/index.cjs')
  // Glass themes need a genuinely transparent window; solid themes paint
  // their own full-bleed background so transparency is harmless there.
  const transparent = true
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: transparent ? '#00000000' : '#0a0c10',
    transparent,
    title: '1Boost',
    icon: getIconPath(),
    webPreferences: {
      preload: preloader,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  win.setMenuBarVisibility(false)
  // Renderer lives in <root>/dist; main bundle is dist-electron/main.
  win.loadFile(join(__dirname, '../../dist/index.html'))
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[1boost] renderer failed to load:', code, desc)
  })

  win.once('ready-to-show', () => {
    if (startHidden) return
    win.show()
  })

  win.on('close', (e) => {
    // Hide to tray on close; real exit goes through appExit().
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  applyRoundedCorners(win)

  mainWindow = win
  return win
}

/**
 * Rounded window shell, kept in sync with the maximize state:
 *  - the frameless transparent window gets visible rounded corners from the
 *    CSS radius on `.app` (index.css); DWM never rounds transparent windows,
 *  - `data-win-max` on the document root collapses the radius when maximized
 *    so content reaches the true screen edges,
 *  - the same push drives the titlebar maximize/restore icon via the existing
 *    `oneboost:window-state` channel (the renderer listens to it already).
 */
function applyRoundedCorners(win: BrowserWindow): void {
  const push = () => {
    if (win.isDestroyed()) return
    win.webContents.send('oneboost:window-state', {
      maximized: win.isMaximized(),
      focused: win.isFocused(),
    })
  }
  win.on('maximize', push)
  win.on('unmaximize', push)
  win.on('focus', push)
  win.on('blur', push)
  push()
}

export function appExit(): void {
  quitting = true
  try {
    hooks?.onExit()
  } catch {
    /* ignore */
  }
  app.quit()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

export function createTray(): Tray | null {
  if (tray) return tray
  if (process.env.ONEBOOST_NO_TRAY === '1') return null
  const icon = trayIcon()
  if (icon.isEmpty()) {
    console.warn('[1boost] tray icon missing; tray disabled')
    return null
  }
  tray = new Tray(icon)
  updateTrayMenu(false)
  tray.on('click', () => showMainWindow())
  return tray
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

export function updateTrayMenu(paused: boolean): void {
  if (!tray || !hooks) return
  const menu = Menu.buildFromTemplate([
    { label: '1Boost', enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => showMainWindow('dashboard') },
    {
      label: paused ? 'Resume Tracking' : 'Pause Tracking',
      click: () => hooks?.onTrayPauseToggle(),
    },
    { type: 'separator' },
    { label: 'Settings', click: () => showMainWindow('settings') },
    { type: 'separator' },
    { label: 'Exit 1Boost', click: () => appExit() },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(paused ? '1Boost — tracking paused' : '1Boost — tracking your PC usage')
}

let trayState: { paused: boolean; accent: string } = { paused: false, accent: '#3b82f6' }
export function setTrayState(paused: boolean, accent: string): void {
  trayState = { paused, accent }
  if (tray) updateTrayMenu(paused)
}
export function getTrayState() {
  return trayState
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export function getIconPath(): string {
  if (app.isPackaged && typeof process.resourcesPath === 'string') {
    return join(process.resourcesPath, 'icons', 'icon.ico')
  }
  return join(__dirname, '../../resources/icons/icon.ico')
}

function trayIconPath(): string {
  if (app.isPackaged && typeof process.resourcesPath === 'string') {
    return join(process.resourcesPath, 'icons', 'tray.ico')
  }
  return join(__dirname, '../../resources/icons/tray.ico')
}

export function trayIcon(): Electron.NativeImage {
  try {
    return nativeImage.createFromPath(trayIconPath())
  } catch {
    return nativeImage.createEmpty()
  }
}

// ---------------------------------------------------------------------------
// App menu / permissions
// ---------------------------------------------------------------------------

export function setupAppMenu(): void {
  Menu.setApplicationMenu(null)
}

export function requestSendNotificationPermission(): boolean {
  // Not required on Windows; keep for API completeness.
  return true
}

export { quitting }
