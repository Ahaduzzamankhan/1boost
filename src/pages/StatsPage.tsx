import { useEffect, useState } from 'react'
import { ChartNoAxesCombined, Clock, Activity, Timer, Trophy, CalendarDays } from 'lucide-react'
import type { StatsOverview, TrendData, WeekdayAverages } from '../../shared/types'
import { bridge } from '../bridge'
import { formatDuration, formatDayRelative } from '../lib/format'
import { AppIcon, EmptyState } from '../components/ui'
import { DailyBars } from '../components/charts'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function StatsPage() {
  const [overview, setOverview] = useState<StatsOverview | null>(null)
  const [trend, setTrend] = useState<TrendData | null>(null)
  const [weekday, setWeekday] = useState<WeekdayAverages | null>(null)

  useEffect(() => {
    let alive = true
    bridge.getStatsOverview().then((o) => alive && setOverview(o)).catch(() => alive && setOverview(null))
    bridge.getTrend(30).then((t) => alive && setTrend(t)).catch(() => alive && setTrend(null))
    bridge.getWeekdayAverages().then((w) => alive && setWeekday(w)).catch(() => alive && setWeekday(null))
    return () => {
      alive = false
    }
  }, [])

  const hasData = (overview?.totals.activeMs ?? 0) > 0 || (overview?.totals.pcOnMs ?? 0) > 0

  return (
    <div className="page">
      <h1 className="page-title">Statistics</h1>
      <p className="page-subtitle">Trends across your recorded history</p>

      {!overview || !hasData ? (
        <EmptyState
          icon={<ChartNoAxesCombined size={24} />}
          title="Not enough data yet"
          desc="1Boost hasn't collected enough data to display statistics. Your usage data will appear here automatically."
        />
      ) : (
        <>
          <div className="stat-grid" style={{ marginTop: 24 }}>
            <div className="card">
              <div className="metric-label">
                <Activity size={13} /> Average daily usage
              </div>
              <div className="metric-value" style={{ fontSize: 26 }}>
                {formatDuration(overview.avgDayActiveMs)}
              </div>
              <div className="metric-sub">over {overview.activeDays} active {overview.activeDays === 1 ? 'day' : 'days'}</div>
            </div>
            <div className="card">
              <div className="metric-label">
                <Clock size={13} /> Average PC-on time
              </div>
              <div className="metric-value" style={{ fontSize: 26 }}>
                {formatDuration(overview.avgDayOnMs)}
              </div>
              <div className="metric-sub">per day</div>
            </div>
            <div className="card">
              <div className="metric-label">
                <Timer size={13} /> Average session
              </div>
              <div className="metric-value" style={{ fontSize: 26 }}>
                {formatDuration(overview.avgSessionMs)}
              </div>
              <div className="metric-sub">between breaks</div>
            </div>
            <div className="card">
              <div className="metric-label">
                <Trophy size={13} /> Longest session
              </div>
              <div className="metric-value" style={{ fontSize: 26 }}>
                {overview.longestSession ? formatDuration(overview.longestSession.onMs) : '—'}
              </div>
              <div className="metric-sub">
                {overview.longestSession
                  ? `${formatDayRelative(new Date(overview.longestSession.startMs).toISOString().slice(0, 10))}`
                  : 'no sessions yet'}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="chart-head">
              <h2 className="section-title" style={{ marginBottom: 0 }}>
                Daily usage — last 30 days
              </h2>
            </div>
            {trend && trend.points.some((p) => p.activeMs > 0) ? (
              <DailyBars points={trend.points} />
            ) : (
              <EmptyState
                icon={<CalendarDays size={22} />}
                title="No daily data yet"
                desc="Daily usage will chart here once 1Boost records a full day."
              />
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2 className="section-title">Average by weekday</h2>
            {weekday && weekday.buckets.length > 0 ? (
              <div className="row-list">
                {weekday.buckets
                  .slice()
                  .sort((a, b) => a.weekday - b.weekday)
                  .map((b) => {
                    const max = Math.max(...weekday.buckets.map((x) => x.activeMs), 1)
                    return (
                      <div key={b.weekday} className="app-row" style={{ minHeight: 40 }}>
                        <div className="app-name" style={{ width: 44 }}>
                          {WEEKDAY_LABELS[b.weekday]}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div className="bar">
                            <div style={{ width: `${(b.activeMs / max) * 100}%` }} />
                          </div>
                        </div>
                        <div className="app-usage">{formatDuration(b.activeMs)}</div>
                      </div>
                    )
                  })}
              </div>
            ) : (
              <div className="app-meta">Not enough history for weekday averages yet.</div>
            )}
          </div>

          {overview.topApp ? (
            <div className="card" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <AppIcon url={null} name={overview.topApp.name} />
              <div>
                <div className="metric-label">Most used application</div>
                <div style={{ fontWeight: 650 }}>{overview.topApp.name}</div>
              </div>
              <div className="app-usage" style={{ marginLeft: 'auto' }}>
                {formatDuration(overview.topApp.ms)}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
