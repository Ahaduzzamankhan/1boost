// Preload bridge: minimal typed IPC surface for the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import type { Bridge, DashboardData, LiveSnapshot, PageId, Prefs, UpdateState } from '../../shared/types'

const api = {
  getInitial: () => ipcRenderer.invoke('oneboost:get-initial'),
  getDashboard: () => ipcRenderer.invoke('oneboost:get-dashboard'),
  navigate: (page: PageId) => ipcRenderer.send('oneboost:navigate', page),
  openAppDetail: (key: string) => ipcRenderer.send('oneboost:open-app-detail', key),
  pageChanged: (cb: (page: PageId) => void) => {
    const h = (_e: unknown, page: PageId) => cb(page)
    ipcRenderer.on('oneboost:page-changed', h)
    return () => ipcRenderer.removeListener('oneboost:page-changed', h)
  },
  appDetailOpened: (cb: (key: string) => void) => {
    const h = (_e: unknown, key: string) => cb(key)
    ipcRenderer.on('oneboost:app-detail', h)
    return () => ipcRenderer.removeListener('oneboost:app-detail', h)
  },
  snapshot: (cb: (s: LiveSnapshot) => void) => {
    const h = (_e: unknown, s: LiveSnapshot) => cb(s)
    ipcRenderer.on('oneboost:snapshot', h)
    return () => ipcRenderer.removeListener('oneboost:snapshot', h)
  },
  onUsageUpdated: (cb: (d: DashboardData) => void) => {
    const h = (_e: unknown, d: DashboardData) => cb(d)
    ipcRenderer.on('oneboost:usage-updated', h)
    return () => ipcRenderer.removeListener('oneboost:usage-updated', h)
  },
  getSettingsData: () => ipcRenderer.invoke('oneboost:get-settings-data'),
  repairLaunch: () => ipcRenderer.invoke('oneboost:repair-launch'),
  getUpdateState: () => ipcRenderer.invoke('oneboost:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('oneboost:update-check'),
  installUpdate: () => ipcRenderer.invoke('oneboost:update-install'),
  onUpdateState: (cb: (s: UpdateState) => void) => {
    const h = (_e: unknown, s: UpdateState) => cb(s)
    ipcRenderer.on('oneboost:update-state', h)
    return () => ipcRenderer.removeListener('oneboost:update-state', h)
  },
  setPref: (key: string, value: string | number | boolean) =>
    ipcRenderer.invoke('oneboost:set-pref', key, value),
  exportJson: () => ipcRenderer.invoke('oneboost:export-json'),
  clearData: () => ipcRenderer.invoke('oneboost:clear-data'),
  toast: (cb: (msg: string) => void) => {
    const h = (_e: unknown, msg: string) => cb(msg)
    ipcRenderer.on('oneboost:toast', h)
    return () => ipcRenderer.removeListener('oneboost:toast', h)
  },
  onPrefsChanged: (cb: (prefs: Prefs) => void) => {
    const h = (_e: unknown, p: Prefs) => cb(p)
    ipcRenderer.on('oneboost:prefs-changed', h)
    return () => ipcRenderer.removeListener('oneboost:prefs-changed', h)
  },
  minimize: () => ipcRenderer.send('oneboost:minimize'),
  toggleMaximize: () => ipcRenderer.send('oneboost:toggle-maximize'),
  close: () => ipcRenderer.send('oneboost:close'),
  windowState: (cb: (s: { maximized: boolean; focused: boolean }) => void) => {
    const h = (_e: unknown, s: { maximized: boolean; focused: boolean }) => cb(s)
    ipcRenderer.on('oneboost:window-state', h)
    return () => ipcRenderer.removeListener('oneboost:window-state', h)
  },
  isMaximized: () => ipcRenderer.invoke('oneboost:is-maximized'),
  onOpenSettings: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('oneboost:open-settings', h)
    return () => ipcRenderer.removeListener('oneboost:open-settings', h)
  },
  getAppsList: () => ipcRenderer.invoke('oneboost:get-apps-list'),
  getAppDetail: (key: string) => ipcRenderer.invoke('oneboost:get-app-detail', key),
  getStatsOverview: () => ipcRenderer.invoke('oneboost:get-stats-overview'),
  getTrend: (days: number) => ipcRenderer.invoke('oneboost:get-trend', days),
  getWeekdayAverages: () => ipcRenderer.invoke('oneboost:get-weekday-averages'),
  getHistoryPage: (offset: number, limit: number) =>
    ipcRenderer.invoke('oneboost:get-history-page', offset, limit),
  openDataFolder: () => ipcRenderer.send('oneboost:open-data-folder'),
} satisfies Bridge

contextBridge.exposeInMainWorld('oneboost', api)
