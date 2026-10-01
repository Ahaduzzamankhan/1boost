import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CalendarClock, Check, ListChecks, Plus, Search, Trash2, X } from 'lucide-react'
import type { Task } from '../../shared/types'
import { bridge } from '../bridge'
import { useFocusTarget } from '../nav'
import { EmptyState } from '../components/ui'

type Filter = 'open' | 'today' | 'done' | 'all'

const PRIORITIES = ['None', 'Low', 'Medium', 'High'] as const

function dueLabel(dueMs?: number | null): { text: string; late: boolean } {
  if (!dueMs) return { text: '', late: false }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(dueMs)
  due.setHours(0, 0, 0, 0)
  const days = Math.round((due.getTime() - today.getTime()) / 86400000)
  if (days === 0) return { text: 'Today', late: false }
  if (days === 1) return { text: 'Tomorrow', late: false }
  if (days === -1) return { text: 'Yesterday', late: true }
  if (days < 0) return { text: `${-days}d overdue`, late: true }
  if (days <= 6) return { text: due.toLocaleDateString(undefined, { weekday: 'short' }), late: false }
  return { text: due.toLocaleDateString(), late: false }
}

const emptyTask = (): Task => ({
  id: '',
  title: '',
  done: false,
  dueMs: null,
  priority: 0,
  tags: [],
  createdMs: 0,
  updatedMs: 0,
  completedMs: null,
})

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState<Filter>('open')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { focus, clearFocus } = useFocusTarget()

  const load = useCallback(async () => {
    try {
      setTasks(await bridge.tasksList())
      return true
    } catch {
      setTasks([])
      return false
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (focus?.taskId) setHighlight(focus.taskId)
    clearFocus()
  }, [focus, clearFocus])

  /**
   * Every failure here used to end in an unhandled rejection: the draft kept
   * its text, the list never changed, and the button looked like it was just
   * not wired up. It now says what went wrong and stays usable.
   */
  const add = async () => {
    const title = draft.trim()
    if (!title || saving) return
    setSaving(true)
    setError(null)
    try {
      await bridge.taskSave(emptyTask0(title))
      setDraft('')
      // A saved task that the list cannot show back reads as a dead button,
      // so say so rather than leaving an empty screen.
      if (!(await load())) setError('Saved, but the task list could not be refreshed.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That task could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (id: string) => {
    try {
      await bridge.taskToggle(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That task could not be updated.')
    }
  }

  const setPriority = async (task: Task, priority: number) => {
    await bridge.taskSave({ ...task, priority })
    await load()
  }

  const setDue = async (task: Task, days: number | null) => {
    const dueMs = days === null ? null : Date.now() + days * 86400000
    await bridge.taskSave({ ...task, dueMs })
    await load()
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const todayEnd = new Date()
    todayEnd.setHours(23, 59, 59, 999)
    return (tasks ?? []).filter((t) => {
      if (q && !t.title.toLowerCase().includes(q) && !t.tags.some((x) => x.includes(q))) return false
      if (filter === 'open') return !t.done
      if (filter === 'done') return t.done
      if (filter === 'today') return !t.done && !!t.dueMs && t.dueMs <= todayEnd.getTime()
      return true
    })
  }, [tasks, query, filter])

  const openCount = (tasks ?? []).filter((t) => !t.done).length
  const doneCount = (tasks ?? []).filter((t) => t.done).length

  return (
    <div className="page tasks-page">
      <h1 className="page-title">Tasks</h1>
      <p className="page-subtitle">
        {openCount} open · {doneCount} done
      </p>

      <div className="tasks-add card">
        <Plus size={17} />
        <input
          value={draft}
          placeholder="Add a task and press Enter…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // Otherwise the keypress can submit twice in some webview builds.
            e.preventDefault()
            void add()
          }}
        />
        <button className="btn btn-primary" onClick={() => void add()} disabled={!draft.trim() || saving}>
          {saving ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? (
        <div className="setting-note bad" role="alert">
          <AlertCircle size={14} />
          <span className="grow">{error}</span>
          <button className="btn btn-ghost" onClick={() => setError(null)}>
            <X size={14} /> Dismiss
          </button>
        </div>
      ) : null}

      <div className="tasks-controls">
        <div className="segmented">
          {(['open', 'today', 'done', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}
            >
              {f === 'open' ? 'Open' : f === 'today' ? 'Today' : f === 'done' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
        <div className="search-box">
          <Search size={15} />
          <input
            value={query}
            placeholder="Filter…"
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query ? (
            <button aria-label="Clear" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          ) : null}
        </div>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            await bridge.tasksClearDone()
            await load()
          }}
          disabled={doneCount === 0}
        >
          <Trash2 size={14} /> Clear done
        </button>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        {visible.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={24} />}
            title={tasks && tasks.length > 0 ? 'Nothing here' : 'No tasks yet'}
            desc={
              tasks && tasks.length > 0
                ? 'Try another filter.'
                : 'Add one above, or press Ctrl+Shift+Space and start with "!" anywhere in 1Boost.'
            }
          />
        ) : (
          <div className="row-list">
            {visible.map((t) => {
              const due = dueLabel(t.dueMs)
              return (
                <div
                  key={t.id}
                  className={`task-row${highlight === t.id ? ' flash' : ''}${t.done ? ' done' : ''}`}
                >
                  <button
                    className={`task-check${t.done ? ' checked' : ''}`}
                    aria-label={t.done ? 'Mark as open' : 'Mark as done'}
                    onClick={() => void toggle(t.id)}
                  >
                    {t.done ? <Check size={13} /> : null}
                  </button>
                  <span className="task-title">{t.title}</span>

                  <span className="task-priority" title="Priority">
                    {([0, 1, 2, 3] as const).map((p) => (
                      <button
                        key={p}
                        className={`prio-dot p${p}${t.priority === p ? ' active' : ''}`}
                        aria-label={`Priority ${PRIORITIES[p]}`}
                        onClick={() => void setPriority(t, p)}
                      />
                    ))}
                  </span>

                  <span className="task-due">
                    <button
                      className={`due-btn${due.late ? ' late' : ''}`}
                      onClick={() => void setDue(t, t.dueMs ? null : 1)}
                      title="Toggle due tomorrow"
                    >
                      <CalendarClock size={13} /> {due.text || 'Set due'}
                    </button>
                  </span>

                  <button
                    className="btn btn-ghost task-del"
                    aria-label="Delete task"
                    onClick={async () => {
                      await bridge.taskDelete(t.id)
                      await load()
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function emptyTask0(title: string): Task {
  return { ...emptyTask(), title }
}