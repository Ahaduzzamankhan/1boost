// Auto-update via GitHub Releases (electron-updater).
//
// Channels:
//   stable   — installs from tagged stable releases (e.g. v1.1.3). They only
//              ever see the stable feed (`latest.yml`), so they are NEVER
//              auto-updated to alpha/beta builds.
//   unstable — installs built from alpha/beta tags. They read the beta feed
//              (`beta.yml`) while it is newer than the newest stable, and
//              automatically migrate back to the stable feed as soon as a
//              stable release newer than the running build exists.
//
// Implementation: the NSIS installer is built once per tag; electron-builder
// writes a channel manifest per tag type (latest.yml vs beta.yml). Unstable
// installs flip autoUpdater.channel to 'beta' at runtime. On every check we
// compare the newest stable version (fetched from the GitHub releases API)
// against the running version: when stable >= running, we switch the channel
// back to 'latest' so the user converges onto stable releases.

import { app, ipcMain, BrowserWindow, net } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../../shared/types'

const { autoUpdater } = electronUpdater

const REPO_OWNER = 'Ahaduzzamankhan'
const REPO_NAME = '1boost'
const BETA_CHANNEL = 'beta'

let state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
const listeners = new Set<(s: UpdateState) => void>()

/** True when the running build itself came from an alpha/beta tag. */
function runningPrerelease(): boolean {
  return /-(alpha|beta)\b/i.test(app.getVersion())
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, currentVersion: app.getVersion() }
  for (const cb of listeners) cb(state)
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('oneboost:update-state', state)
}

/** Semver-ish comparison ('1.2.0-beta.1' < '1.2.0'); returns >0 / 0 / <0. */
function compareVersions(a: string, b: string): number {
  const core = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const [a1, a2, a3] = core(a)
  const [b1, b2, b3] = core(b)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  if (a3 !== b3) return a3 - b3
  const aPre = a.includes('-') ? a.split('-')[1] : null
  const bPre = b.includes('-') ? b.split('-')[1] : null
  if (aPre === bPre) return 0
  if (aPre === null) return 1 // stable > prerelease
  if (bPre === null) return -1
  return aPre < bPre ? -1 : 1
}

/** Newest non-draft, non-prerelease release version from the GitHub API. */
async function fetchLatestStableVersion(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const releases = (await res.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean }[]
    for (const r of releases) {
      if (r.draft || r.prerelease) continue
      const v = (r.tag_name ?? '').replace(/^v/, '')
      if (v) return v
    }
  } catch {
    /* offline / rate-limited: treat as unknown */
  }
  return null
}

function bind(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = runningPrerelease()
  autoUpdater.allowDowngrade = false
  // Unstable installs listen on the beta feed; stable installs on the
  // default 'latest' feed — a stable build can therefore never receive an
  // alpha/beta update.
  if (runningPrerelease()) autoUpdater.channel = BETA_CHANNEL

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
    // No toast: the renderer shows a "Restart now / Later" prompt modal for
    // status 'ready', which is the single notification surface.
  })
  autoUpdater.on('error', (err) => {
    // Keep the app usable: record the failure and return to idle.
    setState({ status: 'error', error: String(err?.message ?? err) })
  })
}

/**
 * Channel reconciliation for unstable installs: if the newest STABLE release
 * is at least as new as the running (prerelease) version, drop back to the
 * stable channel so the next check pulls from latest.yml instead of beta.yml.
 */
async function reconcileChannel(): Promise<void> {
  if (!runningPrerelease()) return
  const stable = await fetchLatestStableVersion()
  if (!stable) return
  if (compareVersions(stable, app.getVersion()) >= 0) {
    autoUpdater.channel = 'latest'
    autoUpdater.allowPrerelease = false
  }
}

/** Start background checking (packaged builds only). Safe to call twice. */
export function initUpdater(): void {
  bind()
  if (!app.isPackaged) return
  // Small delay so first paint isn't competing with the update check.
  setTimeout(() => {
    void reconcileChannel()
      .catch(() => {})
      .then(() => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => {
        /* surfaced via the error event */
      })
  }, 15_000)
  // Re-check every 6 hours.
  setInterval(
    () => {
      void reconcileChannel()
        .catch(() => {})
        .then(() => autoUpdater.checkForUpdatesAndNotify())
        .catch(() => {})
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
    await reconcileChannel()
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
