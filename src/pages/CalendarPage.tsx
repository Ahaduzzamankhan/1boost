import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Task } from '../../shared/types'
import { bridge } from '../bridge'
import { EmptyState } from '../components/ui'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function dayKey(d: Date): string {
  // Local date, unlike toISOString() which shifts across the UTC boundary.
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

/** Six-week grid starting on the Monday on or before the 1st. */
function monthGrid(anchor: Date): Date[] {
  const first = startOfMonth(anchor)
  const offset = (first.getDay() + 6) % 7 // Monday = 0
  const start = new Date(first)
  start.setDate(first.getDate() - offset)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

export default function CalendarPage() {
  const [anchor, setAnchor] = useState(() => startOfMonth(new Date()))
  const [selected, setSelected] = useState(() => dayKey(new Date()))
  const [tasks, setTasks] = useState<Task[]>([])

  // Tasks with a due date are the app's calendar events; deadlines from any
  // module land here without a second store to keep in sync.
  useEffect(() => {
    let cancelled = false
    void bridge.tasksList().then((list) => {
      if (!cancelled) setTasks(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const grid = useMemo(() => monthGrid(anchor), [anchor])
  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.dueMs) continue
      const k = dayKey(new Date(t.dueMs))
      const list = map.get(k) ?? []
      list.push(t)
      map.set(k, list)
    }
    return map
  }, [tasks])

  const agenda = useMemo(
    () => [...byDay.entries()].filter(([, v]) => v.length).sort((a, b) => a[0].localeCompare(b[0])),
    [byDay],
  )

  const shift = (months: number) =>
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + months, 1))

  const todayKey = dayKey(new Date())

  return (
    <div className="page calendar-page">
      <div className="notes-head">
        <div>
          <h1 className="page-title">Calendar</h1>
          <p className="page-subtitle">
            {anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} ·{' '}
            {tasks.filter((t) => t.dueMs).length} scheduled
          </p>
        </div>
        <div className="notes-head-actions">
          <button className="btn btn-secondary" onClick={() => shift(-1)} aria-label="Previous month">
            <ChevronLeft size={16} />
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setAnchor(startOfMonth(new Date()))
              setSelected(todayKey)
            }}
          >
            Today
          </button>
          <button className="btn btn-secondary" onClick={() => shift(1)} aria-label="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="calendar-layout" style={{ marginTop: 16 }}>
        <div className="card calendar-grid-card">
          <div className="calendar-weekdays">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {grid.map((d) => {
              const k = dayKey(d)
              const inMonth = d.getMonth() === anchor.getMonth()
              const items = byDay.get(k) ?? []
              return (
                <button
                  key={k}
                  className={`calendar-day${inMonth ? '' : ' muted'}${k === todayKey ? ' today' : ''}${
                    k === selected ? ' selected' : ''
                  }`}
                  onClick={() => setSelected(k)}
                >
                  <span className="calendar-daynum">{d.getDate()}</span>
                  {items.length ? (
                    <span className="calendar-dots">
                      {items.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          className={`calendar-dot${t.done ? ' done' : ''}`}
                          title={t.title}
                        />
                      ))}
                      {items.length > 3 ? <span className="calendar-more">+{items.length - 3}</span> : null}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>

        <div className="card calendar-agenda">
          <div className="section-title">
            {new Date(`${selected}T00:00:00`).toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </div>
          {byDay.get(selected)?.length ? (
            <div className="row-list">
              {byDay.get(selected)!.map((t) => (
                <div key={t.id} className={`agenda-row${t.done ? ' done' : ''}`}>
                  <span className={`prio-dot p${t.priority} active`} />
                  <span className="task-title">{t.title}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="agenda-empty">Nothing scheduled.</div>
          )}

          <div className="section-title" style={{ marginTop: 22 }}>
            Upcoming
          </div>
          {agenda.length === 0 ? (
            <EmptyState
              icon={<CalendarDays size={22} />}
              title="Nothing scheduled"
              desc="Give a task a due date in Tasks and it appears here."
            />
          ) : (
            <div className="agenda-list">
              {agenda.slice(0, 12).map(([day, items]) => (
                <div key={day} className="agenda-day">
                  <span className="agenda-date">
                    {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <span className="agenda-items">
                    {items.map((t) => (
                      <span key={t.id} className={t.done ? 'done' : ''}>
                        {t.title}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}