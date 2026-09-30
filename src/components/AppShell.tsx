import { ReactNode, useEffect, useState } from 'react'
import {
  LayoutDashboard,
  Activity,
  Grid2X2,
  ChartNoAxesCombined,
  History as HistoryIcon,
  Settings as SettingsIcon,
  X,
  RefreshCw,
  Rocket,
  Clock as ClockIcon,
} from 'lucide-react'
import type { PageId, Prefs, ToastMsg, UpdateState } from '../../shared/types'
import { bridge } from '../bridge'
import { useNavigation } from '../state'
import { BrandMark, ToastIcon } from './ui'

async function setPrefBridge(key: keyof Prefs, value: string | number | boolean): Promise<void> {
  await bridge.setPref(key, value)
}
import DashboardPage from '../pages/DashboardPage'
import MonitorPage from '../pages/MonitorPage'
import AppsPage from '../pages/AppsPage'
import StatsPage from '../pages/StatsPage'
import HistoryPage from '../pages/HistoryPage'
import SettingsPage from '../pages/SettingsPage'

const NAV: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={19} /> },
  { id: 'monitor', label: 'Monitor', icon: <Activity size={19} /> },
  { id: 'apps', label: 'Applications', icon: <Grid2X2 size={19} /> },
  { id: 'stats', label: 'Statistics', icon: <ChartNoAxesCombined size={19} /> },
  { id: 'history', label: 'History', icon: <HistoryIcon size={19} /> },
]

// The window uses the native Windows title bar, so there is no custom
// titlebar to render here — the shell starts straight into the layout.

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

/** Global "update ready" prompt: Restart now or Later. */
function UpdatePrompt({ update }: { update: UpdateState | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const open = update?.status === 'ready' && dismissed !== update.availableVersion
  if (!open) return null
  return (
    <div className="modal-overlay" style={{ zIndex: 400 }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label="Update ready" style={{ width: 'min(420px, calc(100vw - 48px))' }}>
        <div className="modal-head">
          <div className="section-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Rocket size={18} color="var(--accent)" /> Update ready
          </div>
          <button
            className="btn btn-ghost"
            aria-label="Later"
            onClick={() => setDismissed(update!.availableVersion ?? 'ready')}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, lineHeight: 1.55 }}>
            Version <b style={{ color: 'var(--text-primary)' }}>{update!.availableVersion ?? ''}</b> has been downloaded
            and will install the next time 1Boost restarts.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn btn-secondary" onClick={() => setDismissed(update!.availableVersion ?? 'ready')}>
              <ClockIcon size={15} /> Later
            </button>
            <button className="btn btn-primary" onClick={() => void bridge.installUpdate()}>
              <RefreshCw size={15} /> Restart now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
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
  const [update, setUpdate] = useState<UpdateState | null>(null)

  useEffect(() => {
    let alive = true
    bridge.getUpdateState().then((s) => alive && setUpdate(s)).catch(() => undefined)
    const off = bridge.onUpdateState((s) => {
      if (alive) setUpdate(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div className="app">
      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-icon">
              <BrandMark size={16} />
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
          {page === 'monitor' && <MonitorPage />}
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
      <UpdatePrompt update={update} />
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
