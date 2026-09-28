// Settings + startup (launch at login) management.

import { app } from 'electron'
import type { Prefs } from '../../shared/types'
import { Storage } from './storage'

export function setLaunchAtLogin(enable: boolean, startMinimized: boolean): boolean {
  try {
    app.setLoginItemSettings({
      openAtLogin: enable,
      args: startMinimized ? ['--hidden'] : [],
    })
    const cur = app.getLoginItemSettings()
    return cur.openAtLogin === enable || cur.openAtLogin
  } catch {
    return false
  }
}

export function applyPref(key: keyof Prefs, value: Prefs[keyof Prefs], storage: Storage): Prefs {
  const prefs = { ...storage.settings.prefs, [key]: value }
  return prefs as Prefs
}
