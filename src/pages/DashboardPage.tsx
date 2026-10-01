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
  HardDrive,
  LayoutDashboard,
  ListChecks,
  MemoryStick,
  PauseCircle,
  Plus,
  Search,
  Timer,
} from 'lucide-react'
import type { MonitorSample, TrendPoint } from '../../shared/types'
import { useDashboard } from '../state'
import { bridge } from '../bridge'
import { formatDuration, formatDayRelative } from '../lib/format'
import { HourChart, TrendChart } from '../components/charts'
import { AppIcon, Bar, Chip, EmptyState, PageHeader, Segmented } from '../components/ui'
import { relative, todaysTasks, recentPages, useWorkspace } from '../workspace/store'
import { useFocusTarget } from '../nav'

type Range = 'today' | '7d' | '30d' | 'all'

/** Days each range asks the backend for. `all` means "every day on record". */
const RANGE_DAYS: Record<Exclude<Range, 'today'>, number> = { '7d': 7, '30d': 30, all: 0 }

/**
 * The dashboard is the home of 1Boost, not a statistics screen.
 *
 * It answers three questions in order: what am I supposed to be doing right
 * now (today's tasks), what have I been doing (time, apps), and is the machine
 * healthy (live system). Everything else is one click away.
 */
export default function DashboardPage() {
  const { dashboard, snapshot } = useDashboard(null)
  const { tasks, pages, toggleTask } = useWorkspace()
  const { setFocus } = useFocusTarget()
  const [range, setRange] = useState<Range>('7d')
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [monitor, setMonitor] = useState<MonitorSample | null>(null)

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

  const totalAppMs = useMemo(
    () => (dashboard?.apps ?? []).reduce((sum, app) => sum + app.ms, 0),
    [dashboard],
  )

  const apps = dashboard?.apps ?? []
  const today = useMemo(() => todaysTasks(tasks ?? []), [tasks])
  const recent = useMemo(() => recentPages(pages ?? [], 5), [pages])

  if (!dashboard) return null

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

      {/* Today: the work, not the statistics. */}
      <div className="home-split">
        <section className="card today-card">
          <div className="card-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              <ListChecks size={15} /> Today
            </h2>
            <button className="btn btn-ghost" onClick={() => bridge.navigate('tasks')}>
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
                <label key={t.id} className="task-row mini">
                  <input
                    type="checkbox"
                    checked={t.status === 'done'}
                    onChange={() => void toggleTask(t.id)}
                    aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Complete ${t.title}`}
                  />
                  <span className="task-title">{t.title}</span>
                  {t.priority > 0 ? <span className={`prio-tag p${t.priority}`}>P{t.priority}</span> : null}
                </label>
              ))}
              {today.length > 7 ? (
                <button className="context-link" onClick={() => bridge.navigate('tasks')}>
                  {today.length - 7} more today <ChevronRight size={12} />
                </button>
              ) : null}
            </div>
          )}
        </section>

        <section className="card today-card">
          <div className="card-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              <FileText size={15} /> Recent work
            </h2>
            <button className="btn btn-ghost" onClick={() => bridge.navigate('notes')}>
              All pages <ChevronRight size={14} />
            </button>
          </div>
          {recent.length === 0 ? (
            <EmptyState
              icon={<FileText size={22} />}
              title="No pages yet"
              desc="Pages hold your notes, plans and the tasks attached to them."
              action={
                <button className="btn btn-secondary" onClick={() => bridge.navigate('notes')}>
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
                  onClick={() => {
                    // Hand the page id along, so "recent work" actually opens
                    // that page rather than whichever one happened to be open.
                    bridge.navigate('notes')
                    setFocus({ pageId: p.id })
                  }}
                >
                  <span>
                    {p.icon ? `${p.icon} ` : ''}
                    {p.title || 'Untitled'}
                  </span>
                  <span className="context-meta">{relative(p.updatedMs)}</span>
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
          <div className="metric-value metric-value-sm">
            {snapshot?.appName || '—'}
          </div>
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
          <h2 className="section-title">Shortcuts</h2>
          <div className="shortcut-list">
            <Shortcut keys="Ctrl K" what="Search everything" onClick={() => bridge.navigate('tasks')} />
            <Shortcut keys="Ctrl ⇧ Space" what="Quick capture" />
            <Shortcut keys="N" what="New task (in Tasks)" onClick={() => bridge.navigate('tasks')} />
            <Shortcut keys="/" what="Block menu in the editor" onClick={() => bridge.navigate('notes')} />
          </div>
          <div className="shortcut-list">
            <button className="btn btn-secondary" onClick={() => bridge.navigate('monitor')}>
              <Activity size={14} /> Full system view
            </button>
            <button className="btn btn-secondary" onClick={() => bridge.navigate('stats')}>
              <Clock size={14} /> Statistics
            </button>
          </div>
        </div>
      </div>
    </div>
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
  const memUsedPct = monitor.memory.totalBytes > 0
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
        <button className="sys-item link" onClick={() => bridge.navigate('monitor')}>
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
          <Search size={13} />
        </button>
      ) : null}
    </div>
  )
}

