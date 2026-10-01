import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  BatteryCharging,
  BatteryFull,
  ChevronRight,
  Clock,
  Coffee,
  Cpu,
  Expand,
  FileText,
  FolderGit2,
  HardDrive,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  MemoryStick,
  PauseCircle,
  Plus,
  Search,
  Timer,
} from 'lucide-react'
import type { MonitorSample, Task, TrendPoint } from '../../shared/types'
import { useDashboard, useNavigation } from '../state'
import { bridge } from '../bridge'
import { formatDuration, formatDayRelative } from '../lib/format'
import { HourChart, TrendChart } from '../components/charts'
import { AppIcon, Bar, Chip, EmptyState, PageHeader, Segmented } from '../components/ui'
import { useFocusTarget } from '../nav'
import { useWorkspace } from '../workspace/store'
import { dueLabel, recentPages, relative, todaysTasks, upcomingTasks } from '../workspace/helpers'
import { projectProgress, projectRollups, type ProjectRollup } from '../workspace/projects'

type Range = 'today' | '7d' | '30d' | 'all'

/** Days each range asks the backend for. `all` means "every day on record". */
const RANGE_DAYS: Record<Exclude<Range, 'today'>, number> = { '7d': 7, '30d': 30, all: 0 }

/** How far ahead "upcoming" reaches. A week is a planning horizon people use. */
const UPCOMING_DAYS = 7

/**
 * The dashboard is the home of 1Boost, not a statistics screen.
 *
 * It answers four questions in order: what am I supposed to be doing right
 * now, what is coming, what have I been working on, and is the machine
 * healthy. Everything else — pages, projects, the full statistics, the system
 * view — is one click away through the cross-links.
 *
 * Nothing here fetches its own copy of the workspace: it reads the shared
 * store, so completing a task anywhere in the app is reflected here on the
 * next paint rather than after a reload.
 */
export default function DashboardPage() {
  const { dashboard, snapshot } = useDashboard()
  const { tasks, pages, toggleTask, createPage, busy } = useWorkspace()
  const { navigate } = useNavigation()
  const { setFocus } = useFocusTarget()
  const [range, setRange] = useState<Range>('7d')
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [monitor, setMonitor] = useState<MonitorSample | null>(null)

  const openPage = useCallback(
    (id: string) => {
      navigate('notes')
      setFocus({ pageId: id })
    },
    [navigate, setFocus],
  )

  const openTask = useCallback(
    (id: string) => {
      navigate('tasks')
      setFocus({ taskId: id })
    },
    [navigate, setFocus],
  )

  /**
   * Create a page (or a project) and open it.
   *
   * The store already records why a save failed; the catch here exists so a
   * failed quick action does not surface as an unhandled rejection with no
   * feedback at all — the page simply does not appear, and the store's error
   * is what the user sees in the module that failed.
   */
  const newPage = useCallback(
    (isProject: boolean) => {
      void createPage({ isProject })
        .then((page) => openPage(page.id))
        .catch(() => undefined)
    },
    [createPage, openPage],
  )

  // Ask the backend for exactly the window that was chosen. Slicing the
  // dashboard payload capped the chart at whatever the retention pref
  // happened to be, so "All Time" silently showed less than all of it.
  const loadTrend = useCallback(async (r: Range) => {
    if (r === 'today') {
      setTrend(null)
      return
    }
    try {
      const data = await bridge.getTrend(RANGE_DAYS[r])
      setTrend(data.points)
    } catch {
      setTrend(null)
    }
  }, [])

  useEffect(() => {
    void loadTrend(range)
    // Re-pull when the day advances: `lastMs` moves with every recorded
    // sample, so this fires exactly when the window behind the chart changed.
  }, [range, loadTrend, dashboard?.today?.lastMs])

  // One live subscription for the system strip. It unsubscribes with the
  // component, so leaving the dashboard stops the work rather than leaving a
  // listener running in the background.
  useEffect(() => {
    let cancelled = false
    void bridge
      .getMonitorSample()
      .then((s) => {
        if (!cancelled) setMonitor(s)
      })
      .catch(() => undefined)
    const off = bridge.monitor((s) => setMonitor(s))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const fallbackPoints = useMemo<TrendPoint[]>(() => {
    const daily = dashboard?.daily ?? []
    if (range === '7d') return daily.slice(-7)
    if (range === '30d') return daily.slice(-30)
    return daily
  }, [dashboard, range])

  const points = trend ?? fallbackPoints

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 5) return 'Good night'
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const apps = dashboard?.apps ?? []
  const totalAppMs = useMemo(() => apps.reduce((sum, app) => sum + app.ms, 0), [apps])

  const today = useMemo(() => todaysTasks(tasks ?? []), [tasks])
  const upcoming = useMemo(() => upcomingTasks(tasks ?? [], UPCOMING_DAYS), [tasks])
  const recent = useMemo(() => recentPages(pages ?? [], 5), [pages])
  const projects = useMemo<ProjectRollup[]>(() => projectRollups(pages ?? [], tasks ?? []), [pages, tasks])
  const overdue = useMemo(
    () => (tasks ?? []).filter((t) => t.status !== 'done' && dueLabel(t.dueMs).late).length,
    [tasks],
  )

  if (!dashboard) {
    return (
      <div className="page">
        <div className="module-loading">Loading your day…</div>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title={greeting}
        subtitle="Your PC usage today"
        action={
          snapshot?.paused ? (
            <Chip tone="warn" icon={<PauseCircle size={14} />}>
              Tracking paused
            </Chip>
          ) : null
        }
      />

      {/* One click from any state the user is most likely to be in. */}
      <div className="quick-row">
        <QuickAction
          icon={<Search size={15} />}
          label="Search"
          hint="Ctrl K"
          onClick={() => navigate('search')}
        />
        <QuickAction
          icon={<Plus size={15} />}
          label="New page"
          hint={busy ? 'Saving…' : 'Ctrl K'}
          disabled={busy}
          onClick={() => newPage(false)}
        />
        <QuickAction
          icon={<FolderGit2 size={15} />}
          label="New project"
          hint={busy ? 'Saving…' : 'Ctrl K'}
          disabled={busy}
          onClick={() => newPage(true)}
        />
        <QuickAction
          icon={<ListChecks size={15} />}
          label="Tasks"
          hint="N"
          onClick={() => navigate('tasks')}
        />
        <QuickAction
          icon={<Activity size={15} />}
          label="System"
          hint={monitor ? `${Math.round(monitor.cpu.usage ?? 0)}% CPU` : 'Live'}
          onClick={() => navigate('monitor')}
        />
      </div>

      {/* Today: the work, not the statistics. */}
      <div className="home-split">
        <section className="card today-card">
          <div className="card-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              <ListChecks size={15} /> Today
              {overdue > 0 ? <span className="card-count warn">{overdue} overdue</span> : null}
            </h2>
            <button className="btn btn-ghost" onClick={() => navigate('tasks')}>
              All tasks <ChevronRight size={14} />
            </button>
          </div>
          {today.length === 0 ? (
            <EmptyState
              icon={<ListChecks size={22} />}
              title="Nothing due"
              desc="You are clear for today. Press Ctrl+Shift+Space anywhere in 1Boost to capture something new."
            />
          ) : (
            <div className="row-list">
              {today.slice(0, 7).map((t) => (
                <TaskRow key={t.id} task={t} onToggle={toggleTask} onOpen={openTask} />
              ))}
              {today.length > 7 ? (
                <button className="context-link" onClick={() => navigate('tasks')}>
                  {today.length - 7} more today <ChevronRight size={12} />
                </button>
              ) : null}
            </div>
          )}
        </section>

        <section className="card today-card">
          <div className="card-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              <Timer size={15} /> Upcoming
            </h2>
            <button className="btn btn-ghost" onClick={() => navigate('calendar')}>
              Calendar <ChevronRight size={14} />
            </button>
          </div>
          {upcoming.length === 0 ? (
            <EmptyState
              icon={<Timer size={22} />}
              title={`Nothing in the next ${UPCOMING_DAYS} days`}
              desc="Give a task a due date and it will appear here the day before it is due."
            />
          ) : (
            <div className="row-list">
              {upcoming.slice(0, 7).map((t) => (
                <TaskRow key={t.id} task={t} onToggle={toggleTask} onOpen={openTask} />
              ))}
              {upcoming.length > 7 ? (
                <button className="context-link" onClick={() => navigate('tasks')}>
                  {upcoming.length - 7} more coming up <ChevronRight size={12} />
                </button>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <div className="home-split">
        <section className="card today-card">
          <div className="card-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              <FileText size={15} /> Recent work
            </h2>
            <button className="btn btn-ghost" onClick={() => navigate('notes')}>
              All pages <ChevronRight size={14} />
            </button>
          </div>
          {recent.length === 0 ? (
            <EmptyState
              icon={<FileText size={22} />}
              title="No pages yet"
              desc="Pages hold your notes, plans and the tasks attached to them."
              action={
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => newPage(false)}
                >
                  <Plus size={14} /> Write one
                </button>
              }
            />
          ) : (
            <div className="row-list">
              {recent.map((p) => (
                <button
                  key={p.id}
                  className="context-link"
                  title={p.isProject ? 'Open project' : 'Open page'}
                  onClick={() => openPage(p.id)}
                >
                  <span>
                    {p.icon ? `${p.icon} ` : ''}
                    {p.title || 'Untitled'}
                    {p.isProject ? (
                      <span className="row-tag">Project</span>
                    ) : null}
                  </span>
                  <span className="context-meta">{relative(p.updatedMs)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card today-card">
          <div className="card-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              <FolderGit2 size={15} /> Projects
            </h2>
            <button className="btn btn-ghost" onClick={() => navigate('notes')}>
              Open pages <ChevronRight size={14} />
            </button>
          </div>
          {projects.length === 0 ? (
            <EmptyState
              icon={<FolderGit2 size={22} />}
              title="No projects yet"
              desc="A project is a page that owns tasks, so plans and the work behind them stay together."
              action={
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => newPage(true)}
                >
                  <Plus size={14} /> Start one
                </button>
              }
            />
          ) : (
            <div className="row-list">
              {projects.slice(0, 6).map((p) => (
                <button key={p.id} className="project-row" onClick={() => openPage(p.id)}>
                  <span className="project-row-head">
                    <span className="project-row-title">
                      {p.icon ? `${p.icon} ` : ''}
                      {p.title || 'Untitled project'}
                    </span>
                    <span className="project-row-count">
                      {p.taskDone}/{p.taskCount}
                    </span>
                  </span>
                  <Bar fraction={projectProgress(p)} />
                  <span className="project-row-meta">
                    {p.pageCount > 0 ? `${p.pageCount} page${p.pageCount === 1 ? '' : 's'}` : 'No pages yet'}
                    <span className="context-meta">{relative(p.updatedMs)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="grid-metrics">
        <div className="card">
          <div className="metric-label">
            <Clock size={13} /> PC on time
          </div>
          <div className="metric-value">{formatDuration(dashboard.today.pcOnMs)}</div>
          <div className="metric-sub">today</div>
        </div>
        <div className="card">
          <div className="metric-label">
            <Activity size={13} /> Active usage
          </div>
          <div className="metric-value">{formatDuration(dashboard.today.activeMs)}</div>
          <div className="metric-sub">
            {dashboard.today.pcOnMs > 0
              ? `${Math.round((dashboard.today.activeMs / dashboard.today.pcOnMs) * 100)}% of PC-on time`
              : '—'}
          </div>
        </div>
        <div className="card">
          <div className="metric-label">
            <Coffee size={13} /> Idle time
          </div>
          <div className="metric-value">{formatDuration(dashboard.today.idleMs)}</div>
          <div className="metric-sub">
            {dashboard.today.pcOnMs > 0
              ? `${Math.round((dashboard.today.idleMs / dashboard.today.pcOnMs) * 100)}% of PC-on time`
              : '—'}
          </div>
        </div>
        <div className="card">
          <div className="metric-label">
            <Timer size={13} /> Current app
          </div>
          <div className="metric-value metric-value-sm">{snapshot?.appName || '—'}</div>
          <div className="metric-sub">
            {snapshot?.appStartMs
              ? `${formatDuration(Math.max(0, Date.now() - snapshot.appStartMs))} in it`
              : snapshot?.paused
                ? 'tracking paused'
                : 'nothing focused'}
          </div>
        </div>
      </div>

      {/* System: the strip that makes this a desktop app rather than a notes app. */}
      <SystemStrip monitor={monitor} snapshotError={snapshot?.lastError ?? null} />

      {dashboard.today.focusMs > 0 || snapshot?.batteryRemainingMin != null || snapshot?.lastError ? (
        <div className="chip-row">
          {dashboard.today.focusMs > 0 ? (
            <Chip icon={<Expand size={14} />}>
              Fullscreen focus <b>{formatDuration(dashboard.today.focusMs)}</b> today
            </Chip>
          ) : null}
          {snapshot?.batteryRemainingMin != null ? (
            <Chip tone={snapshot.battery.charging ? 'good' : 'neutral'}>
              {snapshot.battery.charging ? (
                <BatteryCharging size={14} />
              ) : (
                <BatteryFull size={14} />
              )}
              {snapshot.battery.pct}%{' '}
              {snapshot.battery.charging
                ? 'charging'
                : ` · ~${Math.floor(snapshot.batteryRemainingMin / 60)}h ${snapshot.batteryRemainingMin % 60}m left`}
            </Chip>
          ) : null}
          {snapshot?.lastError ? (
            <Chip tone="warn" icon={<AlertCircle size={14} />}>
              {snapshot.lastError}
            </Chip>
          ) : null}
        </div>
      ) : null}

      <div className="card chart-card">
        <div className="chart-head">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            {range === 'today' ? "Today's PC usage" : 'PC Usage'}
          </h2>
          <Segmented<Range>
            options={[
              { value: 'today', label: 'Today' },
              { value: '7d', label: '7 Days' },
              { value: '30d', label: '30 Days' },
              { value: 'all', label: 'All Time' },
            ]}
            value={range}
            onChange={setRange}
          />
        </div>
        {dashboard.totals.days === 0 ? (
          <EmptyState
            icon={<Clock size={24} />}
            title="No usage history yet"
            desc="1Boost will start collecting your PC usage as you use your computer."
          />
        ) : range === 'today' ? (
          <HourChart hours={dashboard.hourly} activeHours={dashboard.hourlyActive} />
        ) : points.length === 0 ? (
          <EmptyState
            icon={<Clock size={24} />}
            title="Not enough data yet"
            desc="Come back after 1Boost has collected some usage for a while."
          />
        ) : (
          <TrendChart points={points} />
        )}
      </div>

      <div className="home-split">
        <div className="card" style={{ padding: 0 }}>
          <div className="chart-head" style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
            <h2 className="section-title" style={{ marginBottom: 0 }}>
              Application usage
            </h2>
            <span className="app-meta">{formatDayRelative(dashboard.today.date)}</span>
          </div>
          {apps.length === 0 ? (
            <EmptyState
              icon={<LayoutDashboard size={24} />}
              title="No application activity recorded yet"
              desc="Apps you actively use will appear here as 1Boost observes your day."
            />
          ) : (
            <div className="row-list">
              {apps.slice(0, 6).map((a) => (
                <div key={a.key} className="app-row">
                  <button
                    className="row-main"
                    onClick={() => bridge.openAppDetail(a.key)}
                    aria-label={`Open details for ${a.name}`}
                  >
                    <AppIcon url={a.iconDataUrl} name={a.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="app-name">{a.name}</div>
                      <div style={{ marginTop: 5 }}>
                        <Bar fraction={totalAppMs > 0 ? a.ms / totalAppMs : 0} />
                      </div>
                    </div>
                    <div className="app-usage">{formatDuration(a.ms)}</div>
                    <ChevronRight size={15} color="var(--text-muted)" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card shortcuts-card">
          <h2 className="section-title">
            <Keyboard size={15} /> Shortcuts
          </h2>
          <div className="shortcut-list">
            <Shortcut keys="Ctrl K" what="Command center" onClick={() => navigate('search')} />
            {/* No jump target: capture is an overlay the shell owns, so the
                shortcut itself is the only thing that can open it. */}
            <Shortcut keys="Ctrl ⇧ Space" what="Quick capture" />
            <Shortcut keys="N" what="New task (in Tasks)" onClick={() => navigate('tasks')} />
            <Shortcut keys="/" what="Block menu in the editor" onClick={() => navigate('notes')} />
          </div>
          <div className="shortcut-list">
            <button className="btn btn-secondary" onClick={() => navigate('monitor')}>
              <Activity size={14} /> Full system view
            </button>
            <button className="btn btn-secondary" onClick={() => navigate('stats')}>
              <Clock size={14} /> Statistics
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A dashboard task, with the project it belongs to as a cross-link. */
function TaskRow({
  task,
  onToggle,
  onOpen,
}: {
  task: Task
  onToggle: (id: string) => void | Promise<unknown>
  onOpen: (id: string) => void
}) {
  const due = dueLabel(task.dueMs)
  return (
    <div className="task-row mini">
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={() => void onToggle(task.id)}
        aria-label={task.status === 'done' ? `Reopen ${task.title}` : `Complete ${task.title}`}
      />
      <button className="task-title task-title-button" onClick={() => onOpen(task.id)} title={task.title}>
        {task.title}
      </button>
      {task.priority > 0 ? <span className={`prio-tag p${task.priority}`}>P{task.priority}</span> : null}
      {due.text ? (
        <span className={`due-tag${due.late ? ' late' : ''}`}>{due.text}</span>
      ) : null}
    </div>
  )
}

function QuickAction({
  icon,
  label,
  hint,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  hint: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button className="quick-action" onClick={onClick} disabled={disabled}>
      <span className="quick-action-icon">{icon}</span>
      <span className="quick-action-label">{label}</span>
      <kbd className="quick-action-hint">{hint}</kbd>
    </button>
  )
}

/** The live system read-out. Values the OS cannot provide are shown as such. */
function SystemStrip({
  monitor,
  snapshotError,
}: {
  monitor: MonitorSample | null
  snapshotError: string | null
}) {
  const { navigate } = useNavigation()
  if (!monitor) {
    return (
      <div className="system-strip">
        <div className="sys-item muted">
          <Cpu size={14} /> System metrics unavailable on this machine
        </div>
      </div>
    )
  }
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v)}%`)
  const memUsedPct =
    monitor.memory.totalBytes > 0
      ? Math.round((monitor.memory.usedBytes / monitor.memory.totalBytes) * 100)
      : 0
  const tightest = [...monitor.drives]
    .filter((d) => d.totalBytes > 0)
    .sort((a, b) => a.freeBytes / a.totalBytes - b.freeBytes / b.totalBytes)[0]
  return (
    <div className="system-strip">
      <div className="sys-item" title={monitor.cpu.name}>
        <Cpu size={14} /> CPU {pct(monitor.cpu.usage)}
        {monitor.cpu.tempC != null ? <span className="sys-sub">{Math.round(monitor.cpu.tempC)}°C</span> : null}
      </div>
      <div className="sys-item">
        <MemoryStick size={14} /> RAM {pct(monitor.memory.totalBytes > 0 ? memUsedPct : null)}
        <span className="sys-sub">{formatDuration(monitor.memory.usedBytes)}</span>
      </div>
      {tightest ? (
        <div className="sys-item">
          <HardDrive size={14} /> {tightest.letter}: {formatDuration(tightest.freeBytes)} free
        </div>
      ) : null}
      <span className="grow" />
      {snapshotError ? (
        <span className="sys-item warn">
          <AlertCircle size={14} /> {snapshotError}
        </span>
      ) : (
        <button className="sys-item link" onClick={() => navigate('monitor')}>
          Open Monitor <ChevronRight size={13} />
        </button>
      )}
    </div>
  )
}

function Shortcut({ keys, what, onClick }: { keys: string; what: string; onClick?: () => void }) {
  return (
    <div className="shortcut-row">
      <kbd>{keys}</kbd>
      <span className="grow">{what}</span>
      {onClick ? (
        <button className="btn btn-ghost" onClick={onClick} aria-label={`Go to ${what}`}>
          <ChevronRight size={13} />
        </button>
      ) : null}
    </div>
  )
}