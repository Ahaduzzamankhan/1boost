import { useMemo, useState } from 'react'
import { Clock, Activity, Coffee, Grid2X2, ChevronRight, PauseCircle } from 'lucide-react'
import type { TrendPoint } from '../../shared/types'
import { useDashboard } from '../state'
import { bridge } from '../bridge'
import { formatDuration, formatDayRelative } from '../lib/format'
import { TrendChart } from '../components/charts'
import { AppIcon, Bar, EmptyState, Segmented } from '../components/ui'

type Range = 'today' | '7d' | '30d' | 'all'

export default function DashboardPage() {
  const { dashboard, snapshot } = useDashboard(null)
  const [range, setRange] = useState<Range>('7d')

  const points = useMemo<TrendPoint[]>(() => {
    const daily = dashboard?.daily ?? []
    if (range === 'today') return daily.slice(-1)
    if (range === '7d') return daily.slice(-7)
    if (range === '30d') return daily.slice(-30)
    return daily
  }, [dashboard, range])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 5) return 'Good night'
    if (h < 12) return 'Good morning'
    if (h < 18) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const totalAppMs = (dashboard?.today?.apps
    ? dashboard.apps.reduce((a, b) => a + b.ms, 0)
    : 0)

  const apps = dashboard?.apps ?? []

  if (!dashboard) return null

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{greeting}</h1>
          <p className="page-subtitle">Your PC usage today</p>
        </div>
        {snapshot?.paused ? (
          <div className="card" style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <PauseCircle size={16} color="#f59e0b" />
            <span style={{ fontSize: 13 }}>Tracking paused</span>
          </div>
        ) : null}
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
            <Grid2X2 size={13} /> Apps used
          </div>
          <div className="metric-value">{Object.keys(dashboard.today.apps).length}</div>
          <div className="metric-sub">
            {snapshot?.paused ? 'tracking paused' : snapshot?.appName ? `using ${snapshot.appName}` : '—'}
          </div>
        </div>
      </div>

      <div className="card chart-card">
        <div className="chart-head">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            PC Usage
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
