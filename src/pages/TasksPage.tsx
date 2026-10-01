import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  Link2,
  ListChecks,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { Page, Recurrence, Task, TaskStatus } from '../../shared/types'
import { EmptyState, ErrorState, Segmented } from '../components/ui'
import { useFocusTarget } from '../nav'
import {
  RECURRENCE_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  dayKey,
  dueLabel,
  relative,
  startOfDay,
  subtasksOf,
  useWorkspace,
} from '../workspace/store'

type View = 'list' | 'board' | 'calendar'
type FilterKey = 'open' | 'today' | 'done' | 'all' | 'overdue'
type SortKey = 'due' | 'priority' | 'created' | 'title'

const FILTERS: { value: FilterKey; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'today', label: 'Today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
]

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'created', label: 'Newest' },
  { value: 'title', label: 'Title' },
]

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Tasks — the doing half of the workspace.
 *
 * Reads from the same store as Pages, so completing a task here updates the
 * editor's linked tasks and the dashboard's list at once.
 */
export default function TasksPage() {
  const {
    tasks,
    pages,
    loading,
    error,
    saveTask,
    toggleTask,
    deleteTask,
    clearDoneTasks,
    reload,
  } = useWorkspace()
  const [view, setView] = useState<View>('list')
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState<FilterKey>('open')
  const [sort, setSort] = useState<SortKey>('due')
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState('')
  const [tag, setTag] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [highlight, setHighlight] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const { focus, clearFocus } = useFocusTarget()
  const quickRef = useRef<HTMLInputElement | null>(null)

  const taskList = useMemo(() => tasks ?? [], [tasks])
  const pageList = useMemo(() => pages ?? [], [pages])

  useEffect(() => {
    if (focus?.taskId) setHighlight(focus.taskId)
    clearFocus()
  }, [focus, clearFocus])

  // "n" starts a task from anywhere in this module; it is the only global-ish
  // shortcut added here, and it stands down while a field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = !!target?.closest('input, textarea, [contenteditable="true"]')
      if (typing || (e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        quickRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const add = async () => {
    const title = draft.trim()
    if (!title || saving) return
    setSaving(true)
    setLocalError(null)
    try {
      await saveTask(blankTask({ title, projectId, pageId: '' }))
      setDraft('')
      // A saved task the list cannot show back reads as a dead button, so say
      // so rather than leaving an empty screen.
      setHighlight('')
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'That task could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of taskList) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [taskList])

  // Projects are pages that have tasks attached as a project, plus any page the
  // user explicitly picked — a task can belong to a page without it being a
  // project, so the filter lists the pages that actually carry tasks.
  const projectOptions = useMemo(() => {
    const withTasks = new Set(taskList.map((t) => t.projectId).filter(Boolean))
    return pageList.filter((p) => withTasks.has(p.id) && !p.archived)
  }, [pageList, taskList])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const end = startOfDay(Date.now()) + 86_399_999
    const filtered = taskList.filter((t) => {
      if (projectId && t.projectId !== projectId) return false
      if (tag && !t.tags.includes(tag)) return false
      if (q && !t.title.toLowerCase().includes(q) && !t.tags.some((x) => x.includes(q))) return false
      switch (filter) {
        case 'open':
          return t.status !== 'done'
        case 'done':
          return t.status === 'done'
        case 'today':
          return t.status !== 'done' && t.dueMs != null && t.dueMs <= end
        case 'overdue':
          return t.status !== 'done' && t.dueMs != null && t.dueMs < startOfDay(Date.now())
        default:
          return true
      }
    })
    const sorted = filtered.slice()
    sorted.sort((a, b) => {
      if (sort === 'title') return a.title.toLowerCase().localeCompare(b.title.toLowerCase())
      if (sort === 'created') return b.createdMs - a.createdMs
      if (sort === 'priority') return b.priority - a.priority || (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity)
      // Undated tasks sort last rather than first: an empty due date used to
      // win every comparison and bury everything that actually had a date.
      const av = a.dueMs ?? Infinity
      const bv = b.dueMs ?? Infinity
      return av === bv ? b.priority - a.priority : av - bv
    })
    return sorted
  }, [taskList, query, filter, sort, projectId, tag])

  const openCount = taskList.filter((t) => t.status !== 'done').length
  const doneCount = taskList.length - openCount

  if (error && !tasks) {
    return (
      <div className="page">
        <ErrorState title="Tasks could not be loaded" desc={error} onRetry={() => void reload()} />
      </div>
    )
  }

  return (
    <div className="page tasks-page">
      <div className="tasks-head">
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-subtitle">
            {openCount} open · {doneCount} done
          </p>
        </div>
        <div className="workspace-head-actions">
          <Segmented<View>
            options={[
              { value: 'list', label: 'List' },
              { value: 'board', label: 'Board' },
              { value: 'calendar', label: 'Calendar' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      <div className="tasks-add card">
        <Plus size={17} />
        <input
          ref={quickRef}
          value={draft}
          placeholder="Add a task and press Enter…  (press N to jump here)"
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

      {localError || error ? (
        <div className="setting-note bad" role="alert">
          <AlertCircle size={14} />
          <span className="grow">{localError ?? error}</span>
          <button className="btn btn-ghost" onClick={() => setLocalError(null)}>
            <X size={14} /> Dismiss
          </button>
        </div>
      ) : null}

      <div className="tasks-controls">
        <Segmented<FilterKey> options={FILTERS} value={filter} onChange={setFilter} />
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
        <label className="select-box">
          <Filter size={14} />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort tasks">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {projectOptions.length ? (
          <label className="select-box">
            <Link2 size={14} />
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Filter by project">
              <option value="">All projects</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.icon ? `${p.icon} ` : ''}
                  {p.title || 'Untitled'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="grow" />
        <button
          className="btn btn-secondary"
          onClick={async () => {
            await clearDoneTasks()
          }}
          disabled={doneCount === 0}
        >
          <Trash2 size={14} /> Clear done
        </button>
      </div>

      {allTags.length ? (
        <div className="chip-row">
          <button className={`chip${tag === '' ? ' active' : ''}`} onClick={() => setTag('')}>
            All tags
          </button>
          {allTags.map(([t, count]) => (
            <button key={t} className={`chip${tag === t ? ' active' : ''}`} onClick={() => setTag(tag === t ? '' : t)}>
              #{t} <span className="chip-count">{count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {view === 'list' ? (
        <ListView
          tasks={visible}
          all={taskList}
          pages={pageList}
          loading={loading}
          highlight={highlight}
          expanded={expanded}
          onToggleExpand={(id) => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
          onToggle={toggleTask}
          onDelete={deleteTask}
          onSave={saveTask}
        />
      ) : view === 'board' ? (
        <BoardView tasks={visible} onToggle={toggleTask} onStatus={saveTask} />
      ) : (
        <CalendarView tasks={visible} onToggle={toggleTask} onOpenDay={(ms) => {
          setFilter('today')
          void ms
        }} />
      )}
    </div>
  )
}

/** One row, with the detail drawer that holds everything else about a task. */
function ListView({
  tasks,
  all,
  pages,
  loading,
  highlight,
  expanded,
  onToggleExpand,
  onToggle,
  onDelete,
  onSave,
}: {
  tasks: Task[]
  all: Task[]
  pages: Page[]
  loading: boolean
  highlight: string | null
  expanded: Record<string, boolean>
  onToggleExpand: (id: string) => void
  onToggle: (id: string) => Promise<Task | null>
  onDelete: (id: string) => Promise<boolean>
  onSave: (task: Task) => Promise<Task>
}) {
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])

  if (loading && all.length === 0) {
    return <div className="module-loading">Loading tasks…</div>
  }
  if (tasks.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <EmptyState
          icon={<ListChecks size={24} />}
          title={all.length > 0 ? 'Nothing here' : 'No tasks yet'}
          desc={
            all.length > 0
              ? 'Try another filter.'
              : 'Add one above, or press Ctrl+Shift+Space and start with “!” anywhere in 1Boost.'
          }
        />
      </div>
    )
  }

  return (
    <div className="card" style={{ marginTop: 16, padding: 0 }}>
      <div className="row-list">
        {tasks.map((t) => {
          const due = dueLabel(t.dueMs)
          const open = expanded[t.id]
          const subs = subtasksOf(all, t.id)
          const doneSubs = subs.filter((s) => s.status === 'done').length
          const blockers = t.blockedBy.map((id) => all.find((x) => x.id === id)).filter(Boolean) as Task[]
          const project = pageById.get(t.projectId)
          return (
            <div key={t.id} className={`task-wrap${highlight === t.id ? ' flash' : ''}`}>
              <div className={`task-row${t.status === 'done' ? ' done' : ''}`}>
                <button
                  className={`task-check${t.status === 'done' ? ' checked' : ''}`}
                  aria-label={t.status === 'done' ? 'Mark as open' : 'Mark as done'}
                  onClick={() => void onToggle(t.id)}
                >
                  {t.status === 'done' ? <Check size={13} /> : null}
                </button>
                <button
                  className="task-title-btn"
                  onClick={() => onToggleExpand(t.id)}
                  aria-expanded={open}
                  title="Task details"
                >
                  <span className="task-title selectable">{t.title}</span>
                </button>

                {t.status !== 'todo' ? (
                  <span className={`status-tag s-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                ) : null}

                <span className="task-priority" title="Priority">
                  {([0, 1, 2, 3] as const).map((p) => (
                    <button
                      key={p}
                      className={`prio-dot p${p}${t.priority === p ? ' active' : ''}`}
                      aria-label={`Priority ${p}`}
                      onClick={() => void onSave({ ...t, priority: p })}
                    />
                  ))}
                </span>

                {subs.length ? (
                  <span className="task-subcount" title={`${doneSubs} of ${subs.length} done`}>
                    {doneSubs}/{subs.length}
                  </span>
                ) : null}

                {project ? (
                  <span className="task-project" title={`Project: ${project.title || 'Untitled'}`}>
                    {project.icon ? `${project.icon} ` : ''}
                    {project.title || 'Untitled'}
                  </span>
                ) : null}

                <button
                  className={`due-btn${due.late ? ' late' : ''}`}
                  onClick={() => void onSave({ ...t, dueMs: t.dueMs ? null : Date.now() + 86_400_000 })}
                  title={t.dueMs ? 'Clear the due date' : 'Due tomorrow'}
                >
                  <CalendarClock size={13} /> {due.text || 'Set due'}
                </button>

                <button
                  className="btn btn-ghost task-del"
                  aria-label="Delete task"
                  onClick={() => void onDelete(t.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>

              {open ? (
                <div className="task-detail">
                  <div className="detail-row">
                    <span className="detail-label">Status</span>
                    <div className="segmented">
                      {STATUS_ORDER.map((s) => (
                        <button
                          key={s}
                          className={t.status === s ? 'active' : ''}
                          onClick={() => void onSave({ ...t, status: s as TaskStatus, done: s === 'done' })}
                        >
                          {STATUS_LABEL[s]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="detail-row">
                    <span className="detail-label">Due</span>
                    <input
                      type="date"
                      className="tool-input"
                      value={t.dueMs ? dayKey(t.dueMs) : ''}
                      onChange={(e) =>
                        void onSave({ ...t, dueMs: e.target.value ? new Date(`${e.target.value}T09:00:00`).getTime() : null })
                      }
                    />
                    <label className="detail-check">
                      <input
                        type="checkbox"
                        checked={t.recurrence !== ''}
                        onChange={(e) => void onSave({ ...t, recurrence: e.target.checked ? 'weekly' : '' })}
                      />
                      Repeats
                    </label>
                    {t.recurrence !== '' ? (
                      <select
                        className="tool-input"
                        value={t.recurrence}
                        aria-label="Recurrence"
                        onChange={(e) => void onSave({ ...t, recurrence: e.target.value as Recurrence })}
                      >
                        {(['daily', 'weekdays', 'weekly', 'monthly'] as Recurrence[]).map((r) => (
                          <option key={r} value={r}>
                            {RECURRENCE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>

                  <div className="detail-row">
                    <span className="detail-label">Project</span>
                    <select
                      className="tool-input"
                      value={t.projectId}
                      aria-label="Project"
                      onChange={(e) => void onSave({ ...t, projectId: e.target.value })}
                    >
                      <option value="">No project</option>
                      {pages
                        .filter((p) => !p.archived)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title || 'Untitled'}
                          </option>
                        ))}
                    </select>
                    <span className="detail-label">Source page</span>
                    <select
                      className="tool-input"
                      value={t.pageId}
                      aria-label="Source page"
                      onChange={(e) => void onSave({ ...t, pageId: e.target.value })}
                    >
                      <option value="">No page</option>
                      {pages
                        .filter((p) => !p.archived)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title || 'Untitled'}
                          </option>
                        ))}
                    </select>
                  </div>

                  {blockers.length ? (
                    <div className="detail-row">
                      <span className="detail-label">Blocked by</span>
                      <span className="detail-blockers">
                        {blockers.map((b) => (
                          <span key={b.id} className="tag-pill">
                            {b.title}
                            <button
                              aria-label={`Remove blocker ${b.title}`}
                              onClick={() => void onSave({ ...t, blockedBy: t.blockedBy.filter((x) => x !== b.id) })}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                      </span>
                    </div>
                  ) : null}

                  {subs.length ? (
                    <div className="detail-row">
                      <span className="detail-label">Subtasks</span>
                      <div className="detail-subs">
                        {subs.map((s) => (
                          <label key={s.id} className="task-row mini">
                            <input
                              type="checkbox"
                              checked={s.status === 'done'}
                              onChange={() => void onToggle(s.id)}
                            />
                            <span className="task-title">{s.title}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="detail-row">
                    <span className="detail-label">Created</span>
                    <span className="detail-note">{relative(t.createdMs)}</span>
                    {t.completedMs ? <span className="detail-note">done {relative(t.completedMs)}</span> : null}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Kanban: one column per status, dragged between. */
function BoardView({
  tasks,
  onToggle,
  onStatus,
}: {
  tasks: Task[]
  onToggle: (id: string) => Promise<Task | null>
  onStatus: (task: Task) => Promise<Task>
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<TaskStatus | null>(null)

  const columns = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>(STATUS_ORDER.map((s) => [s, [] as Task[]]))
    for (const t of tasks) map.get(t.status)?.push(t)
    return map
  }, [tasks])

  if (tasks.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <EmptyState icon={<ListChecks size={24} />} title="Nothing to show" desc="No task matches the current filter." />
      </div>
    )
  }

  return (
    <div className="board" role="list">
      {STATUS_ORDER.map((status) => {
        const items = columns.get(status) ?? []
        return (
          <div
            key={status}
            className={`board-column card${overCol === status ? ' over' : ''}`}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              setOverCol(status)
            }}
            onDragEnd={() => {
              setDragId(null)
              setOverCol(null)
            }}
            onDrop={(e) => {
              // A drop on the column body (rather than on a card) moves the
              // dragged task into this status.
              e.preventDefault()
              if (dragId) {
                const moved = tasks.find((x) => x.id === dragId)
                if (moved && moved.status !== status) {
                  void onStatus({ ...moved, status, done: status === 'done' })
                }
              }
              setDragId(null)
              setOverCol(null)
            }}
            role="listitem"
          >
            <div className="board-head">
              <span className="board-title">{STATUS_LABEL[status]}</span>
              <span className="board-count">{items.length}</span>
            </div>
            <div className="board-list">
              {items.length === 0 ? (
                <div className="board-empty">Nothing</div>
              ) : (
                items.map((t) => {
                  const due = dueLabel(t.dueMs)
                  return (
                    <div
                      key={t.id}
                      className={`board-card${dragId === t.id ? ' dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragId(t.id)}
                      onDrop={(e) => {
                        e.stopPropagation()
                        if (!dragId || dragId === t.id) return
                        const moved = tasks.find((x) => x.id === dragId)
                        setDragId(null)
                        if (moved) void onStatus({ ...moved, status: t.status, done: t.status === 'done' })
                      }}
                    >
                      <div className="board-card-title selectable">{t.title}</div>
                      <div className="board-card-meta">
                        <button
                          className={`task-check small${t.status === 'done' ? ' checked' : ''}`}
                          aria-label={t.status === 'done' ? 'Mark as open' : 'Mark as done'}
                          onClick={() => void onToggle(t.id)}
                        >
                          {t.status === 'done' ? <Check size={11} /> : null}
                        </button>
                        {t.priority > 0 ? <span className={`prio-tag p${t.priority}`}>P{t.priority}</span> : null}
                        {due.text ? (
                          <span className={`due-tag${due.late ? ' late' : ''}`}>{due.text}</span>
                        ) : null}
                        {t.recurrence ? <span className="due-tag">{RECURRENCE_LABEL[t.recurrence]}</span> : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="board-actions">
              {/* Keyboard/click path for moving a card, so the board is
                  usable without a pointer — drag-and-drop alone is not. */}
              {items.length > 0 && STATUS_ORDER.filter((s) => s !== status).length > 0 ? (
                <select
                  className="board-move"
                  value=""
                  aria-label={`Move a card out of ${STATUS_LABEL[status]}`}
                  onChange={(e) => {
                    const first = items[0]
                    const next = e.target.value as TaskStatus | ''
                    if (first && next) void onStatus({ ...first, status: next, done: next === 'done' })
                  }}
                >
                  <option value="">Move to…</option>
                  {STATUS_ORDER.filter((s) => s !== status).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Month grid of everything with a due date, plus an agenda for the day. */
function CalendarView({
  tasks,
  onToggle,
  onOpenDay,
}: {
  tasks: Task[]
  onToggle: (id: string) => Promise<Task | null>
  onOpenDay: (ms: number) => void
}) {
  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selected, setSelected] = useState(() => dayKey(Date.now()))

  const grid = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7
    const start = new Date(first)
    start.setDate(first.getDate() - offset)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return d
    })
  }, [anchor])

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (t.dueMs == null) continue
      const k = dayKey(t.dueMs)
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
  const undated = useMemo(() => tasks.filter((t) => t.dueMs == null).slice(0, 20), [tasks])
  const todayKey = dayKey(Date.now())

  return (
    <div className="card calendar-layout" style={{ marginTop: 16 }}>
      <div className="calendar-grid-card">
        <div className="calendar-head">
          <button className="btn btn-ghost" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))} aria-label="Previous month">
            <ChevronLeft size={16} />
          </button>
          <div className="section-title" style={{ margin: 0 }}>
            {anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => {
              const now = new Date()
              setAnchor(new Date(now.getFullYear(), now.getMonth(), 1))
              setSelected(todayKey)
            }}
          >
            Today
          </button>
          <button className="btn btn-ghost" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))} aria-label="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="calendar-weekdays">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {grid.map((d) => {
            const k = dayKey(d.getTime())
            const inMonth = d.getMonth() === anchor.getMonth()
            const items = byDay.get(k) ?? []
            return (
              <button
                key={k}
                className={`calendar-day${inMonth ? '' : ' muted'}${k === todayKey ? ' today' : ''}${k === selected ? ' selected' : ''}`}
                onClick={() => setSelected(k)}
              >
                <span className="calendar-daynum">{d.getDate()}</span>
                {items.length ? (
                  <span className="calendar-dots">
                    {items.slice(0, 3).map((t) => (
                      <span key={t.id} className={`calendar-dot${t.status === 'done' ? ' done' : ''}`} title={t.title} />
                    ))}
                    {items.length > 3 ? <span className="calendar-more">+{items.length - 3}</span> : null}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className="calendar-agenda">
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
              <label key={t.id} className={`task-row mini${t.status === 'done' ? ' done' : ''}`}>
                <input
                  type="checkbox"
                  checked={t.status === 'done'}
                  onChange={() => void onToggle(t.id)}
                  aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Complete ${t.title}`}
                />
                <span className="task-title">{t.title}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="agenda-empty">Nothing scheduled.</div>
        )}

        <div className="section-title" style={{ marginTop: 22 }}>
          Upcoming
        </div>
        {agenda.length === 0 ? (
          <div className="agenda-empty">Give a task a due date and it appears here.</div>
        ) : (
          <div className="agenda-list">
            {agenda.slice(0, 12).map(([day, items]) => (
              <div key={day} className="agenda-day">
                <span className="agenda-date">
                  {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <span className="agenda-items">
                  {items.map((t) => (
                    <span key={t.id} className={t.status === 'done' ? 'done' : ''}>
                      {t.title}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}

        {undated.length ? (
          <>
            <div className="section-title" style={{ marginTop: 22 }}>
              No date
            </div>
            <div className="agenda-list">
              {undated.map((t) => (
                <div key={t.id} className="agenda-day">
                  <span className="agenda-date">—</span>
                  <span className="agenda-items">
                    <span>{t.title}</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => onOpenDay(Date.now())}>
          Show only what is due today
        </button>
      </div>
    </div>
  )
}

/** A task with everything filled in, for quick create. */
export function blankTask(patch: Partial<Task> = {}): Task {
  return {
    id: '',
    title: '',
    done: false,
    status: 'todo',
    priority: 0,
    dueMs: null,
    tags: [],
    projectId: '',
    pageId: '',
    parentId: '',
    blockedBy: [],
    recurrence: '',
    order: 0,
    createdMs: 0,
    updatedMs: 0,
    completedMs: null,
    ...patch,
  }
}