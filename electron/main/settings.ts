// Settings + startup (launch at login) management.
//
// Windows notes: app.setLoginItemSettings writes a Run-key entry that points at
// the current executable. Dev builds (electron.exe) and relocated installs leave
// stale entries behind, and Windows can drop entries when the path changes —
// so we re-sync on every launch (syncLaunchAtLogin) and expose an honest state
// probe (getLaunchAtLoginState) the Settings page can use to show/repair it.

import { app } from 'electron'
import type { Prefs } from '../../shared/types'
import { Storage } from './storage'

export interface LaunchState {
  /** Preference as the user set it in Settings. */
  enabled: boolean
  /** What Windows actually reports right now. */
  registered: boolean
  /** Whether the Run entry points at the current executable (not a stale path). */
  pathMatches: boolean
  /** True when pref and reality disagree (needs a re-sync). */
  needsRepair: boolean
  /** The path Windows has registered, when any. */
  registeredPath: string | null
}

function loginArgs(startMinimized: boolean): string[] {
  return startMinimized ? ['--hidden'] : []
}

function isOurEntry(execPath: string, args: string[]): boolean {
  const ourExe = process.execPath.toLowerCase()
  const ourArgs = loginArgs(true)
  const matchesArgs = args.length === 0 || ourArgs.every((a) => args.includes(a))
  return execPath.toLowerCase() === ourExe && matchesArgs
}

/**
 * Register or unregister the login item. Idempotent and always safe to call:
 * it re-asserts the desired state on every launch and whenever the pref
 * changes, which repairs stale paths and silently-dropped entries.
 */
export function setLaunchAtLogin(enable: boolean, startMinimized: boolean): boolean {
  try {
    app.setLoginItemSettings({
      openAtLogin: enable,
      path: process.execPath,
      args: loginArgs(startMinimized),
    })
    if (enable) {
      // Verify and retry once — some AV policies swallow the first write.
      const cur = app.getLoginItemSettings({ path: process.execPath })
      if (!cur.openAtLogin) {
        app.setLoginItemSettings({
          openAtLogin: true,
          path: process.execPath,
          args: loginArgs(startMinimized),
        })
      }
    }
    return true
  } catch {
    return false
  }
}

/** Honest probe of the actual Windows login-item state. */
export function getLaunchAtLoginState(prefs: Prefs): LaunchState {
  try {
    const cur = app.getLoginItemSettings() as Electron.LoginItemSettings & { path?: string }
    const registered = cur.openAtLogin
    const execPath = cur.path || process.execPath
    const pathMatches = execPath.toLowerCase() === process.execPath.toLowerCase()
    const enabled = prefs.launchAtLogin
    return {
      enabled,
      registered,
      pathMatches,
      needsRepair: enabled ? !registered || !pathMatches : registered,
      registeredPath: registered ? execPath : null,
    }
  } catch {
    return {
      enabled: prefs.launchAtLogin,
      registered: false,
      pathMatches: false,
      needsRepair: prefs.launchAtLogin,
      registeredPath: null,
    }
  }
}

/**
 * Called once at app start: re-assert the user's saved preference so a stale
 * or dropped Run entry is repaired automatically after updates/moves.
 * Returns the resulting state for diagnostics.
 */
export function syncLaunchAtLogin(prefs: Prefs): LaunchState {
  setLaunchAtLogin(prefs.launchAtLogin, prefs.startMinimized)
  const state = getLaunchAtLoginState(prefs)
  if (prefs.launchAtLogin && !state.registered) {
    // One more attempt with a plain re-assert before reporting failure.
    setLaunchAtLogin(true, prefs.startMinimized)
    return getLaunchAtLoginState(prefs)
  }
  return state
}

export function applyPref(key: keyof Prefs, value: Prefs[keyof Prefs], storage: Storage): Prefs {
  const prefs = { ...storage.settings.prefs, [key]: value }
  return prefs as Prefs
}

export { isOurEntry }
