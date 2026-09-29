import { ReactNode, useEffect, useState } from 'react'
import {
  LayoutDashboard,
  Grid2X2,
  ChartNoAxesCombined,
  History as HistoryIcon,
  Settings as SettingsIcon,
  Zap,
  Minus,
  Square,
  Copy,
  X,
} from 'lucide-react'
import type { PageId, Prefs, ToastMsg } from '../../shared/types'
import { bridge } from '../bridge'
import { useNavigation } from '../state'
import { ToastIcon } from './ui'

async function setPrefBridge(key: keyof Prefs, value: string | number | boolean): Promise<void> {
  await bridge.setPref(key, value)
}
import DashboardPage from '../pages/DashboardPage'
import AppsPage from '../pages/AppsPage'
import StatsPage from '../pages/StatsPage'
import HistoryPage from '../pages/HistoryPage'
import SettingsPage from '../pages/SettingsPage'

const NAV: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={19} /> },
  { id: 'apps', label: 'Applications', icon: <Grid2X2 size={19} /> },
  { id: 'stats', label: 'Statistics', icon: <ChartNoAxesCombined size={19} /> },
  { id: 'history', label: 'History', icon: <HistoryIcon size={19} /> },
]

function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let alive = true
    bridge.isMaximized().then((m) => {
      if (alive) setMaximized(m)
    })
    const off = bridge.windowState((s) => {
      if (alive) setMaximized(s.maximized)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div className="titlebar">
      <div className="titlebar-title">
        <Zap size={15} />
        <span>1Boost</span>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => bridge.minimize()} aria-label="Minimize">
          <Minus size={15} />
        </button>
        <button
          className="titlebar-btn"
          onClick={() => bridge.toggleMaximize()}
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button className="titlebar-btn close" onClick={() => bridge.close()} aria-label="Close">
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

function Toasts({ toasts }: { toasts: ToastMsg[] }) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <ToastIcon message={t.message} /> {t.message}
        </div>
      ))}
    </div>
  )
}

/** Suppress the default Chromium context menu; provide a minimal custom one. */
function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const block = (e: MouseEvent) => {
      e.preventDefault()
      const el = e.target as HTMLElement
      const selectable = el.closest('.selectable')
      if (!selectable) setMenu({ x: e.clientX, y: e.clientY })
    }
    const close = () => setMenu(null)
    window.addEventListener('contextmenu', block)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('contextmenu', block)
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [])
  return menu
}

export default function AppShell({
  prefs,
  toasts,
  storage,
  onDelete,
  version,
}: {
  prefs: Prefs
  toasts: ToastMsg[]
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean } | null
  onDelete: () => Promise<void>
  version: string
}) {
  const { page, navigate } = useNavigation()
  const ctx = useContextMenu()

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-icon">
              <Zap size={16} strokeWidth={2.4} />
            </div>
            <span className="brand-name">1Boost</span>
          </div>
          <nav aria-label="Primary">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={`nav-item${page === n.id ? ' active' : ''}`}
                onClick={() => navigate(n.id)}
                aria-current={page === n.id ? 'page' : undefined}
              >
                {n.icon}
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className="sidebar-status">
              <span className={`status-dot${prefs.pauseTracking ? ' paused' : ''}`} />
              <span className="status-text">{prefs.pauseTracking ? 'Paused' : 'Tracking'}</span>
            </div>
            <button
              className={`nav-item${page === 'settings' ? ' active' : ''}`}
              onClick={() => navigate('settings')}
              aria-current={page === 'settings' ? 'page' : undefined}
            >
              <SettingsIcon size={19} />
              <span>Settings</span>
            </button>
          </div>
        </aside>
        <main className="content" id="main-content">
          {page === 'dashboard' && <DashboardPage />}
          {page === 'apps' && <AppsPage />}
          {page === 'stats' && <StatsPage />}
          {page === 'history' && <HistoryPage />}
          {page === 'settings' && (
            <SettingsPage
              prefs={prefs}
              setPref={setPrefBridge}
              storage={storage}
              onDelete={onDelete}
              version={version}
            />
          )}
        </main>
      </div>
      <Toasts toasts={toasts} />
      {ctx ? (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} role="menu">
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              navigate('dashboard')
            }}
          >
            <LayoutDashboard size={14} /> Open Dashboard
          </button>
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              navigate('settings')
            }}
          >
            <SettingsIcon size={14} /> Settings
          </button>
        </div>
      ) : null}
    </div>
  )
}
