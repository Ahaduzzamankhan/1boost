// Application identity (friendly names) + icon extraction.

import { app } from 'electron'
import { basename, extname } from 'node:path'
import type { AppIdentity } from '../../shared/types'

const NAME_MAP: Record<string, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  arc: 'Arc',
  code: 'VS Code',
  windowsterminal: 'Windows Terminal',
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  conhost: 'Console',
  devenv: 'Visual Studio',
  rider64: 'Rider',
  clion64: 'CLion',
  pycharm64: 'PyCharm',
  webstorm64: 'WebStorm',
  idea64: 'IntelliJ IDEA',
  goland64: 'GoLand',
  zed: 'Zed',
  sublime_text: 'Sublime Text',
  notepad: 'Notepad',
  notepad3: 'Notepad3',
  obsidian: 'Obsidian',
  typora: 'Typora',
  electron: 'Electron',
  '1boost': '1Boost',
  explorer: 'File Explorer',
  dllhost: 'COM Surrogate',
  searchhost: 'Windows Search',
  searchapp: 'Windows Search',
  textinputhost: 'Text Input',
  startmenuexperiencehost: 'Start Menu',
  runtimebroker: 'Runtime Broker',
  applicationframehost: 'UWP Apps',
  systemsettings: 'Windows Settings',
  taskmgr: 'Task Manager',
  regedit: 'Registry Editor',
  steam: 'Steam',
  steamwebhelper: 'Steam',
  discord: 'Discord',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  msteams: 'Microsoft Teams',
  msedgewebview2: 'Edge WebView',
  spotify: 'Spotify',
  spotify_new: 'Spotify',
  vlc: 'VLC',
  vmware: 'VMware Workstation',
  virtualbox: 'VirtualBox',
  virtualboxvm: 'VirtualBox VM',
  docker: 'Docker Desktop',
  postman: 'Postman',
  obs64: 'OBS Studio',
  godot: 'Godot',
  unity: 'Unity Hub',
  radeonsoftware: 'AMD Software',
  'nvidia app': 'NVIDIA App',
  nv_container: 'NVIDIA Container',
  wallpaper32: 'Wallpaper Engine',
  utorrent: 'uTorrent',
  qbittorrent: 'qBittorrent',
  winrar: 'WinRAR',
  '7zfg': '7-Zip',
  '7zfm': '7-Zip',
  totalcmd: 'Total Commander',
  doublecmd: 'Double Commander',
  everything: 'Everything',
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint',
  outlook: 'Microsoft Outlook',
  onenote: 'OneNote',
  figma: 'Figma',
  canva: 'Canva',
  hl2: 'Half-Life 2',
  javaw: 'Minecraft: Java Edition',
  zenlesszonezero: 'Zenless Zone Zero',
  minecraft: 'Minecraft',
  minecraftlauncher: 'Minecraft Launcher',
  valorant: 'VALORANT',
  valorant_win64: 'VALORANT',
  leagueclient: 'League of Legends',
  leagueclientux: 'League of Legends',
  cs2: 'Counter-Strike 2',
  csgo: 'Counter-Strike 2',
  gtav: 'Grand Theft Auto V',
  rdr2: 'Red Dead Redemption 2',
  eldenring: 'Elden Ring',
  cyberpunk2077: 'Cyberpunk 2077',
  scpcontbreachdlc: 'SCP: Containment Breach',
  robloxplayerbeta: 'Roblox',
  wt_client: 'Wallpaper Engine',
}

const GENERIC_NAMES = new Set([
  'applicationframehost', 'runtimebroker', 'textinputhost', 'searchhost', 'searchapp',
  'startmenuexperiencehost', 'dllhost', 'conhost', 'svchost', 'csrss', 'winlogon',
  'wininit', 'services', 'lsass', 'smss', 'fontdrvhost', 'dwm', 'ctfmon', 'sihost',
  'taskhostw', 'shellhost', 'msdtc', 'spoolsv', 'wmiprvse', 'audiodg', 'wudfhost',
  'securityhealthservice', 'securityhealthsystray', 'lockapp', 'noise',
])

/** Base name without extension, lowercased (the app "key"). */
export function appKeyFromPath(p: string): string {
  const name = basename(p).toLowerCase()
  const ext = extname(name)
  return name.endsWith(ext) ? name.slice(0, -ext.length) : name
}

/** Human-friendly display name for an app key or full path. */
export function appDisplayName(pathOrKey: string): string {
  const key = appKeyFromPath(pathOrKey)
  if (NAME_MAP[key]) return NAME_MAP[key]
  const base = basename(pathOrKey)
  const stem = base.replace(/\.(exe|dll)$/i, '')
  if (!stem) return pathOrKey || 'Unknown'
  const cleaned = stem.replace(/_+/g, ' ').trim()
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

/** True if this process is a Windows shell/system process (excluded from tracking). */
export function isSystemApp(key: string): boolean {
  return GENERIC_NAMES.has(key)
}

/** Resolve a process image path to a stable identity + display name. */
export function appIdentityFromPath(p: string): AppIdentity {
  const key = appKeyFromPath(p)
  return { key, name: appDisplayName(p), path: p }
}

/** Extract a PNG data URL icon for an executable path (cached by the caller). */
export async function extractIconDataUrl(exePath: string): Promise<string | null> {
  try {
    if (!exePath || !exePath.toLowerCase().endsWith('.exe')) return null
    const icon = await app.getFileIcon(exePath, { size: 'normal' }) // 32x32
    return icon.toDataURL()
  } catch {
    return null
  }
}
