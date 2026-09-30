// Window + tray management: frameless main window, hide-to-tray behavior,
// native-feeling tray menu, single-instance locking.

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
} from 'electron'
import koffi from 'koffi'
import { join } from 'node:path'
import type { PageId, Prefs } from '../../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let startHidden = false

// ---------------------------------------------------------------------------
// Native Win11 window chrome (DWM, via koffi)
// ---------------------------------------------------------------------------

const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUND = 2
const DWMWA_TRANSITIONS_FORCEDISABLED = 3

type DwmApi = { setAttribute: (hwnd: bigint, attr: number, value: Buffer) => number }
let dwm: DwmApi | null | undefined

function getDwm(): DwmApi | null {
  if (dwm !== undefined) return dwm
  dwm = null
  if (process.platform !== 'win32') return null
  try {
    const lib = koffi.load('dwmapi.dll')
    const set = lib.func('DwmSetWindowAttribute', 'int32', ['intptr', 'uint32', 'void *', 'uint32'])
    dwm = { setAttribute: (hwnd, attr, value) => set(hwnd, attr, value, value.length) }
  } catch (e) {
    console.warn('[1boost] dwmapi.dll unavailable; using CSS-only window chrome:', String(e))
  }
  return dwm
}

/**
 * Ask DWM for native Win11 rounded corners and enable the classic
 * minimize/maximize/restore animations for the frameless window. Both calls
 * are best-effort: DWM declines to round fully transparent windows (the glass
 * themes keep their CSS radius on `.app`), and on older Windows builds the
 * attributes simply do not exist.
 */
function applyNativeWindowChrome(win: BrowserWindow): void {
  const api = getDwm()
  if (!api || win.isDestroyed()) return
  try {
    const hbuf = win.getNativeWindowHandle()
    if (!hbuf || hbuf.length < 8) return
    const hwnd = hbuf.readBigUInt64LE(0)
    const round = Buffer.alloc(4)
    round.writeUInt32LE(DWMWCP_ROUND, 0)
    api.setAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, round)
    // 0 = do NOT force-disable transitions → native min/restore animations.
    api.setAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, Buffer.alloc(4))
  } catch {
    /* cosmetic only */
  }
}

// ---------------------------------------------------------------------------
// Theme-aware transparency
// ---------------------------------------------------------------------------

const GLASS_THEMES = new Set(['dark-glass', 'white-glass'])
const SOLID_BACKDROPS: Record<string, string> = {
  'solid-dark': '#0a0c10',
  'solid-white': '#f7f8fa',
  amoled: '#000000',
}

function isGlassTheme(theme?: string): boolean {
  return theme ? GLASS_THEMES.has(theme) : true
}

/** Tracks the transparency class the current window was created with. */
let currentGlass: boolean | null = null

export interface WindowHooks {
  navigate: (page: PageId) => void
  onTrayPauseToggle: () => void
  onExit: () => void
  /** Full prefs (the window needs `theme` to pick its transparency class). */
  prefs: () => Prefs
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
  // Glass themes need a genuinely transparent window for the desktop blur.
  // Solid themes get a normal opaque window instead: Windows only assigns
  // transparency at creation, and an opaque frameless window unlocks the
  // native DWM rounded corners, the native min/restore animations and a much
  // smoother compositor path (the old always-transparent window caused jank).
  const theme = hooks?.prefs?.().theme
  const glass = isGlassTheme(theme)
  const transparent = glass
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: transparent ? '#00000000' : SOLID_BACKDROPS[theme ?? ''] ?? '#0a0c10',
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
  currentGlass = glass

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

  applyNativeWindowChrome(win)
  applyRoundedCorners(win)

  mainWindow = win
  return win
}

/**
 * Renderer reports the glass/solid theme class after every prefs change. A
 * flip between the classes needs the opposite window transparency, which
 * Windows only assigns at window creation — so rebuild the shell (bounds,
 * maximize state and tray survive; the page reloads, which a theme flip
 * already visually implies).
 */
export function syncWindowGlass(glass: boolean): void {
  if (currentGlass === null || glass === currentGlass) return
  currentGlass = glass
  // Recreate on a later turn: theme changes usually arrive through the
  // oneboost:set-pref invoke, and destroying the invoking WebContents before
  // its IPC reply is flushed can surface "object destroyed" noise. Deferring
  // lets the reply (and the prefs-changed push) land first.
  setTimeout(() => recreateMainWindow(), 120)
}

export function recreateMainWindow(): void {
  const old = mainWindow
  if (!old) {
    createMainWindow()
    return
  }
  const wasMaximized = old.isMaximized()
  const bounds = old.getBounds()
  // destroy() (not close()) skips the hide-to-tray interception.
  old.destroy()
  mainWindow = null
  // Restore geometry while hidden, BEFORE ready-to-show shows the window —
  // adjusting bounds afterwards would visibly snap from the default size.
  const win = createMainWindow()
  if (win.isDestroyed()) return
  if (wasMaximized) win.maximize()
  else win.setBounds(bounds)
  // createMainWindow() suppresses show() when the app was launched with
  // --hidden; a recreated window means the user is actively using it, so
  // always surface it (its own ready-to-show handler is a no-op then).
  if (startHidden) {
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show()
    })
  }
}

/**
 * Rounded window shell, kept in sync with the maximize state:
 *  - opaque (solid-theme) windows get real DWM rounding (above); transparent
 *    glass windows get the CSS radius on `.app` (index.css),
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
