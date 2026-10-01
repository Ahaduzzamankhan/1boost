import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Activity, Coffee, Grid2X2, ChevronRight, PauseCircle, Expand, BatteryFull, BatteryCharging, AlertCircle } from 'lucide-react'
import type { TrendPoint } from '../../shared/types'
import { useDashboard } from '../state'
import { bridge } from '../bridge'
import { formatDuration, formatDayRelative } from '../lib/format'
import { HourChart, TrendChart } from '../components/charts'
import { AppIcon, Bar, Chip, EmptyState, PageHeader, Segmented } from '../components/ui'

type Range = 'today' | '7d' | '30d' | 'all'

/** Days each range asks the backend for. `all` means "every day on record". */
const RANGE_DAYS: Record<Exclude<Range, 'today'>, number> = { '7d': 7, '30d': 30, all: 0 }

export default function DashboardPage() {
  const { dashboard, snapshot } = useDashboard(null)
  const [range, setRange] = useState<Range>('7d')
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)

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

  if (!dashboard) return null

  // Live edge: the hourly view is the one place that benefits from a clock of
  // its own, because the payload only refreshes when usage is written.

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
            <Grid2X2 size={13} /> Apps used
          </div>
          <div className="metric-value">{Object.keys(dashboard.today.apps).length}</div>
          <div className="metric-sub">
            {snapshot?.paused ? 'tracking paused' : snapshot?.appName ? `using ${snapshot.appName}` : '—'}
          </div>
        </div>
      </div>

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

      <div className="card" style={{ marginTop: 16 }}>
        <div className="chart-head">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            Application usage
          </h2>
          <span className="app-meta">{formatDayRelative(dashboard.today.date)}</span>
        </div>
        {apps.length === 0 ? (
          <EmptyState
            icon={<Grid2X2 size={24} />}
            title="No application activity recorded yet"
            desc="Apps you actively use will appear here as 1Boost observes your day."
          />
        ) : (
          <div className="row-list">
            {apps.map((a) => (
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
    </div>
  )
}
