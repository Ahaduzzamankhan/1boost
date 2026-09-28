import { useEffect, useState } from 'react'
import { History as HistoryIcon, ChevronDown } from 'lucide-react'
import type { HistoryPage as HistoryPageData } from '../../shared/types'
import { bridge } from '../bridge'
import { formatDuration, formatDayLabelFull, formatDayRelative } from '../lib/format'
import { EmptyState } from '../components/ui'

const PAGE_SIZE = 10

export default function HistoryPage() {
  const [data, setData] = useState<HistoryPageData | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = async (o: number) => {
    try {
      const res = await bridge.getHistoryPage(o, PAGE_SIZE)
      setData((prev) => {
        if (o === 0 || !prev) return res
        return { items: [...prev.items, ...res.items], hasMore: res.hasMore }
      })
      setOffset(o)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasData = !!data && data.items.length > 0

  return (
    <div className="page">
      <h1 className="page-title">History</h1>
      <p className="page-subtitle">Your recorded days, newest first</p>

      {!hasData ? (
        loading ? null : (
          <EmptyState
            icon={<HistoryIcon size={24} />}
            title="No usage history yet"
            desc="1Boost will start collecting your PC usage as you use your computer."
          />
        )
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <div>
            {data.items.map((item) => (
              <div key={item.day.date} className="history-day">
                <div className="history-head">
                  <div>
                    <div className="history-title">{formatDayRelative(item.day.date)}</div>
                    <div className="history-date">{formatDayLabelFull(item.day.date)}</div>
                  </div>
                  <div className="history-stats">
                    <span>
                      <b>{formatDuration(item.day.pcOnMs)}</b> PC ON
                    </span>
                    <span>
                      <b>{formatDuration(item.day.activeMs)}</b> ACTIVE
                    </span>
                  </div>
                </div>
                {item.topApps.length > 0 ? (
                  <>
                    <div className="metric-label" style={{ marginBottom: 6 }}>
                      Top apps
                    </div>
                    <div className="row-list">
                      {item.topApps.map((a) => (
                        <div key={a.key} className="app-row" style={{ minHeight: 40 }}>
                          <div className="app-name" style={{ flex: 1 }}>
                            {a.name}
                          </div>
                          <div className="app-usage">{formatDuration(a.ms)}</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="app-meta">No app activity recorded this day.</div>
                )}
              </div>
            ))}
          </div>
          {data.hasMore ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
              <button className="btn btn-secondary" onClick={() => void load(offset + PAGE_SIZE)}>
                <ChevronDown size={15} /> Load more days
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
