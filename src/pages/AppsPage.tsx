import { useCallback, useEffect, useState } from 'react'
import { Grid2X2, CalendarDays } from 'lucide-react'
import type { AppUsageItem } from '../../shared/types'
import { bridge } from '../bridge'
import { formatDuration, formatDayLabelFull, formatPercent, formatDayRelative } from '../lib/format'
import { AppIcon, EmptyState, Modal } from '../components/ui'
import { HBar } from '../components/charts'

interface AppDetail {
  identity: { key: string; name: string }
  totalMs: number
  activeShare: number
  lastUsedMs: number | null
  perDay: { date: string; ms: number }[]
  iconDataUrl: string | null
}

export default function AppsPage() {
  const [apps, setApps] = useState<AppUsageItem[] | null>(null)
  const [detail, setDetail] = useState<AppDetail | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await bridge.getAppsList()
      setApps(list)
    } catch {
      setApps([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openDetail = async (key: string) => {
    try {
      const d = await bridge.getAppDetail(key)
      setDetail(d)
    } catch {
      setDetail(null)
    }
  }

  const total = (apps ?? []).reduce((a, b) => a + b.ms, 0)

  return (
    <div className="page">
      <h1 className="page-title">Applications</h1>
      <p className="page-subtitle">All-time usage across every app 1Boost has seen</p>

      {!apps || apps.length === 0 ? (
        <EmptyState
          icon={<Grid2X2 size={24} />}
          title="No applications yet"
          desc="Once you start using your PC, the apps you focus will be listed here with their usage."
        />
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row-list">
            {apps.map((a) => (
              <div key={a.key} className="app-row">
                <button
                  className="row-main"
                  onClick={() => void openDetail(a.key)}
                  aria-label={`Open details for ${a.name}`}
                >
                  <AppIcon url={a.iconDataUrl} name={a.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="app-name">{a.name}</div>
                    <div className="app-meta">
                      {a.lastUsedMs ? `Last used ${formatDayRelative(new Date(a.lastUsedMs).toISOString().slice(0, 10))}` : ''}
                    </div>
                    <div style={{ marginTop: 5 }}>
                      <HBar fraction={total > 0 ? a.ms / total : 0} />
                    </div>
                  </div>
                  <div className="app-usage">{formatDuration(a.ms)}</div>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal open={!!detail} title={detail?.identity.name ?? ''} onClose={() => setDetail(null)}>
        {detail ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
              <AppIcon url={detail.iconDataUrl} name={detail.identity.name} size={44} />
              <div>
                <div style={{ fontWeight: 650, fontSize: 16 }}>{detail.identity.name}</div>
                <div className="app-meta">
                  {detail.lastUsedMs
                    ? `Last used ${formatDayLabelFull(new Date(detail.lastUsedMs).toISOString().slice(0, 10))}`
                    : '—'}
                </div>
              </div>
            </div>
            <div className="stat-grid" style={{ marginBottom: 14 }}>
              <div className="card">
                <div className="metric-label">Total usage</div>
                <div className="metric-value" style={{ fontSize: 24 }}>
                  {formatDuration(detail.totalMs)}
                </div>
              </div>
              <div className="card">
                <div className="metric-label">Share of active time</div>
                <div className="metric-value" style={{ fontSize: 24 }}>
                  {formatPercent(detail.activeShare, 1)}
                </div>
              </div>
            </div>
            <div className="section-title" style={{ fontSize: 15 }}>
              Usage by day
            </div>
            {detail.perDay.length === 0 ? (
              <div className="app-meta">No daily data yet.</div>
            ) : (
              <div className="row-list">
                {detail.perDay
                  .slice(-14)
                  .reverse()
                  .map((d) => (
                    <div key={d.date} className="app-row" style={{ minHeight: 44 }}>
                      <CalendarDays size={15} color="var(--text-muted)" />
                      <div className="app-name" style={{ flex: 1 }}>
                        {formatDayLabelFull(d.date)}
                      </div>
                      <div style={{ width: 140, marginRight: 12 }}>
                        <HBar
                          fraction={
                            detail.perDay.length > 0 ? d.ms / Math.max(...detail.perDay.map((x) => x.ms)) : 0
                          }
                        />
                      </div>
                      <div className="app-usage">{formatDuration(d.ms)}</div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
