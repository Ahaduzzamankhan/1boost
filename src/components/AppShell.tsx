import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  LayoutDashboard,
  RefreshCw,
  Rocket,
  Clock as ClockIcon,
  Search,
  Plus,
  Settings as SettingsIcon,
  X,
  ChevronDown,
} from 'lucide-react'
import type { PageId, Prefs, ToastMsg, UpdateState } from '../../shared/types'
import { bridge } from '../bridge'
import { useNavigation } from '../state'
import { NavProvider, useFocusTarget } from '../nav'
import { BrandMark, ToastIcon } from './ui'
import {
  ModuleBoundary,
  SettingsPage,
  WORKSPACES,
  moduleById,
  modulesIn,
  type WorkspaceId,
} from '../modules/registry'
import CommandCenter from './CommandCenter'
import QuickCapture from './QuickCapture'
import { WorkspaceProvider } from '../workspace/store'

async function setPrefBridge(key: keyof Prefs, value: string | number | boolean): Promise<void> {
  await bridge.setPref(key, value)
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

/**
 * Global "update ready" prompt: restart now, or later.
 *
 * Deliberately its own black surface rather than a themed modal: this one
 * interrupts, and it should look the same on every theme so it reads as the
 * app speaking rather than as part of whatever the user was looking at. It
 * also explains the idle restart, because silently restarting someone's
 * machine an hour later is the sort of thing that erodes trust in an updater.
 */
function UpdatePrompt({ update }: { update: UpdateState | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const version = update?.availableVersion ?? ''
  const open = update?.status === 'ready' && dismissed !== version
  if (!open) return null

  const restart = async () => {
    setRestarting(true)
    try {
      await bridge.installUpdate()
    } catch {
      setRestarting(false)
    }
  }

  return (
    <div className="update-pop" style={{ zIndex: 400 }}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label="Update ready"
        style={{ width: 'min(400px, calc(100vw - 48px))' }}
      >
        <div className="modal-head">
          <div
            className="section-title"
            style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Rocket size={18} /> Update ready
          </div>
          <button
            className="btn btn-ghost"
            aria-label="Later"
            onClick={() => setDismissed(version || 'ready')}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, lineHeight: 1.55 }}>
            <b style={{ color: 'var(--text-primary)' }}>1Boost {version}</b> has been downloaded
            and verified.
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
            Restart whenever you like — or leave it and 1Boost will restart on its own once you
            have been away from the keyboard for a few minutes.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <button
              className="btn btn-secondary"
              onClick={() => setDismissed(version || 'ready')}
              disabled={restarting}
            >
              <ClockIcon size={15} /> Later
            </button>
            <button className="btn btn-primary" onClick={() => void restart()} disabled={restarting}>
              <RefreshCw size={15} className={restarting ? 'spin' : undefined} />
              {restarting ? 'Restarting…' : 'Restart now'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Workspace picker: which set of modules the sidebar shows. */
function WorkspacePicker({
  value,
  onChange,
}: {
  value: WorkspaceId
  onChange: (w: WorkspaceId) => void
}) {
  const [open, setOpen] = useState(false)
  const current = WORKSPACES.find((w) => w.id === value)
  return (
    <div className="workspace-picker">
      <button className="workspace-current" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>
          <span className="workspace-label">{current?.label ?? 'Workspace'}</span>
          <span className="workspace-blurb">{current?.blurb ?? ''}</span>
        </span>
        <ChevronDown size={15} className={open ? 'flip' : ''} />
      </button>
      {open ? (
        <div className="workspace-menu" role="menu">
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              className={`workspace-option${w.id === value ? ' active' : ''}`}
              onClick={() => {
                onChange(w.id)
                setOpen(false)
              }}
            >
              <span className="workspace-label">{w.label}</span>
              <span className="workspace-blurb">{w.blurb}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Wraps the module area so modules can read focus targets and preferences. */
function ModuleArea({
  page,
  prefs,
  storage,
  onDelete,
  version,
}: {
  page: PageId
  prefs: Prefs
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean } | null
  onDelete: () => Promise<void>
  version: string
}) {
  // Settings is the one module that needs live props from the shell, so it is
  // rendered here instead of through the registry's generic boundary.
  if (page === 'settings') {
    return (
      <Suspense fallback={<div className="module-loading">Loading Settings…</div>}>
        <SettingsPage
          prefs={prefs}
          setPref={setPrefBridge}
          storage={storage}
          onDelete={onDelete}
          version={version}
        />
      </Suspense>
    )
  }
  return <ModuleBoundary id={page} />
}

/** Outer shell: owns the nav context so the sidebar and overlays can hand
 *  focus targets to modules, and the workspace context so every module reads
 *  one shared copy of pages and tasks instead of refetching its own. */
export default function AppShell(props: {
  prefs: Prefs
  toasts: ToastMsg[]
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean } | null
  onDelete: () => Promise<void>
  version: string
}) {
  return (
    <NavProvider>
      <WorkspaceProvider>
        <Shell {...props} />
      </WorkspaceProvider>
    </NavProvider>
  )
}

function Shell({
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
  const { setFocus } = useFocusTarget()
  const ctx = useContextMenu()
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceId>(
    () => (moduleById(page)?.workspace ?? 'insight') as WorkspaceId,
  )
  const [commandOpen, setCommandOpen] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)

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

  // Global shortcuts: Ctrl+K command center, Ctrl+Shift+Space capture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault()
        setCommandOpen((o) => !o)
      } else if (e.shiftKey && e.code === 'Space') {
        e.preventDefault()
        setCaptureOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Follow the module when something navigates from outside the sidebar
  // (tray menu, search hit, quick capture) so the workspace never lies.
  // Footer entries (Settings) have no workspace and must not change it.
  useEffect(() => {
    const def = moduleById(page)
    if (def?.workspace) setWorkspace(def.workspace)
  }, [page])

  const navItems = useMemo(() => modulesIn(workspace), [workspace])

  const go = useCallback(
    (p: PageId, payload?: { pageId?: string; taskId?: string }) => {
      navigate(p)
      if (payload) setFocus(payload)
    },
    [navigate, setFocus],
  )

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

          <WorkspacePicker value={workspace} onChange={setWorkspace} />

          <nav aria-label="Modules">
            {navItems.map((m) => (
              <button
                key={m.id}
                className={`nav-item${page === m.id ? ' active' : ''}`}
                onClick={() => navigate(m.id)}
                aria-current={page === m.id ? 'page' : undefined}
                title={m.keywords.slice(0, 4).join(' · ')}
              >
                {m.icon}
                <span>{m.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-quick">
            <button className="nav-item" onClick={() => setCommandOpen(true)}>
              <Search size={18} />
              <span>Search</span>
              <kbd className="nav-kbd">Ctrl K</kbd>
            </button>
            <button className="nav-item" onClick={() => setCaptureOpen(true)}>
              <Plus size={18} />
              <span>Quick capture</span>
              <kbd className="nav-kbd">⇧⌘S</kbd>
            </button>
          </div>

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
              <SettingsIcon size={18} />
              <span>Settings</span>
            </button>
          </div>
        </aside>

        <main className="content" id="main-content">
          <ModuleArea
            page={page}
            prefs={prefs}
            storage={storage}
            onDelete={onDelete}
            version={version}
          />
        </main>
      </div>

      <CommandCenter
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onNavigate={go}
        onOpenSearch={(q) => {
          setCommandOpen(false)
          navigate('search')
          setFocus({ searchQuery: q })
        }}
      />
      <QuickCapture
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        onCaptured={(kind, id) => {
          // A captured project is a page, so it opens in Pages like any other.
          navigate(kind === 'task' ? 'tasks' : 'notes')
          setFocus(kind === 'task' ? { taskId: id } : { pageId: id })
        }}
      />

      <Toasts toasts={toasts} />
      <UpdatePrompt update={update} />
      {ctx ? (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} role="menu">
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              setCommandOpen(true)
            }}
          >
            <Search size={14} /> Command center
          </button>
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