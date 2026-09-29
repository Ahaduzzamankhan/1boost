// Settings + startup (launch at login) management.
//
// Windows notes: app.setLoginItemSettings writes a HKCU Run-key entry that
// points at the current executable. Dev builds (electron.exe), relocated
// installs, and app updates all leave stale entries behind, so we re-sync on
// every launch (syncLaunchAtLogin) and probe the actual registry state
// (getLaunchAtLoginState) instead of trusting Electron's arg-matching quirks —
// getLoginItemSettings() reports openAtLogin=false when the stored args don't
// match the query, which produced false "not starting" statuses.

import { app } from 'electron'
import { execFile } from 'node:child_process'
import type { Prefs } from '../../shared/types'
import { Storage } from './storage'

export interface LaunchState {
  /** Preference as the user set it in Settings. */
  enabled: boolean
  /** What Windows actually has registered right now. */
  registered: boolean
  /** Whether the Run entry points at the current executable (not a stale path). */
  pathMatches: boolean
  /** True when pref and reality disagree (needs a re-sync). */
  needsRepair: boolean
  /** The exe path Windows has registered, when any. */
  registeredPath: string | null
}

/** Run-key value name Electron writes (from productName/app name). */
const RUN_VALUE_NAME = '1Boost'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function loginArgs(startMinimized: boolean): string[] {
  return startMinimized ? ['--hidden'] : []
}

function isOurEntry(execPath: string, args: string[]): boolean {
  const ourExe = process.execPath.toLowerCase()
  const ourArgs = loginArgs(true)
  const matchesArgs = args.length === 0 || ourArgs.every((a) => args.includes(a))
  return execPath.toLowerCase() === ourExe && matchesArgs
}

function execFileText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout ?? ''))
    })
  })
}

/**
 * Read the Run key and return the command line registered for 1Boost, or null.
 * Uses `reg query` directly so the answer reflects what Windows will actually
 * run — independent of Electron's arg-sensitive getLoginItemSettings().
 */
async function readRunEntry(): Promise<{ command: string; exePath: string } | null> {
  if (process.platform !== 'win32') return null
  try {
    const out = await execFileText('reg', ['query', RUN_KEY, '/v', RUN_VALUE_NAME])
    // reg output: "    1Boost    REG_SZ    <command>"
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(RUN_VALUE_NAME) || !/REG_SZ/i.test(line)) continue
      const idx = line.indexOf('REG_SZ')
      const command = line.slice(idx + 'REG_SZ'.length).trim()
      if (!command) continue
      return { command, exePath: exeFromCommand(command) }
    }
  } catch {
    /* entry missing or reg query unavailable */
  }
  return null
}

/** Extract the executable path from a Run-key command ("C:\a\b.exe" --args). */
function exeFromCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1)
  }
  const space = trimmed.indexOf(' ')
  return space > 0 ? trimmed.slice(0, space) : trimmed
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
    return true
  } catch {
    return false
  }
}

/** Honest probe of the actual Windows login-item state. */
export async function getLaunchAtLoginState(prefs: Prefs): Promise<LaunchState> {
  const enabled = prefs.launchAtLogin
  try {
    // Registry truth first: this is what Windows actually runs at sign-in.
    const entry = await readRunEntry()
    if (entry) {
      const pathMatches = entry.exePath.toLowerCase() === process.execPath.toLowerCase()
      return {
        enabled,
        registered: true,
        pathMatches,
        needsRepair: enabled ? !pathMatches : false,
        registeredPath: entry.exePath,
      }
    }
    // No Run entry: cross-check Electron's view before reporting broken
    // (covers App StartupTask / Store installs where the key isn't used).
    const cur = app.getLoginItemSettings()
    if (cur.openAtLogin) {
      return { enabled, registered: true, pathMatches: true, needsRepair: false, registeredPath: process.execPath }
    }
    return {
      enabled,
      registered: false,
      pathMatches: false,
      needsRepair: enabled,
      registeredPath: null,
    }
  } catch {
    return {
      enabled,
      registered: false,
      pathMatches: false,
      needsRepair: enabled,
      registeredPath: null,
    }
  }
}

/**
 * Called once at app start: re-assert the user's saved preference so a stale
 * or dropped Run entry is repaired automatically after updates/moves.
 * Returns the resulting state for diagnostics.
 */
export async function syncLaunchAtLogin(prefs: Prefs): Promise<LaunchState> {
  setLaunchAtLogin(prefs.launchAtLogin, prefs.startMinimized)
  const state = await getLaunchAtLoginState(prefs)
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
