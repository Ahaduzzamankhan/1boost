import type { Block, Page, Recurrence, Task, TaskStatus } from '../../shared/types'

/**
 * Derived helpers over the workspace data.
 *
 * Kept apart from the store's hook so they can be imported (and tested)
 * without pulling in the bridge: these are pure functions over pages and
 * tasks, and every module deriving the same answer from the same helper is what
 * keeps breadcrumbs, backlinks and due labels consistent across the app.
 */

/** A page and its ancestors, root first. Missing links are skipped. */
export function breadcrumbsOf(pages: Page[], id: string): Page[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const chain: Page[] = []
  const seen = new Set<string>()
  let cursor = byId.get(id)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain
}

/** Children of a page, in title order. `''` means top level. */
export function childrenOf(pages: Page[], parentId: string): Page[] {
  return pages
    .filter((p) => (p.parentId || '') === parentId && !p.archived)
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()))
}

/** Every page that references `id`, through a `page` block or a task. */
export function backlinksTo(pages: Page[], tasks: Task[], id: string): Page[] {
  const linked = new Set<string>()
  for (const page of pages) {
    if (page.id === id) continue
    if (page.blocks.some((b) => b.kind === 'page' && b.meta === id)) linked.add(page.id)
  }
  for (const task of tasks) {
    if (task.pageId === id || task.projectId === id) linked.add(task.pageId || task.projectId)
  }
  return pages.filter((p) => linked.has(p.id))
}

/** Tasks written on a page, or belonging to it as a project. */
export function tasksOfPage(tasks: Task[], pageId: string): Task[] {
  return tasks.filter((t) => t.pageId === pageId || t.projectId === pageId)
}

/** Tasks nested under `id`. */
export function subtasksOf(tasks: Task[], id: string): Task[] {
  return tasks.filter((t) => t.parentId === id)
}

/** The most recently edited pages, for the dashboard's "recent work". */
export function recentPages(pages: Page[], limit: number): Page[] {
  return pages
    .filter((p) => !p.archived && p.updatedMs > 0)
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, limit)
}

/** Blocks of a kind that point at `id` — used to highlight a reference. */
export function referencingBlocks(page: Page, id: string): Block[] {
  return page.blocks.filter((b) => b.meta === id && (b.kind === 'page' || b.kind === 'task'))
}

/** A page's text, for search fallbacks and the search index label. */
export function pageText(page: Page): string {
  return page.blocks
    .map((b) => (b.kind === 'todo' ? `${b.checked ? '[x]' : '[ ]'} ${b.text}` : b.text))
    .filter(Boolean)
    .join('\n')
}

export const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'blocked', 'done']

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  doing: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
}

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  '': 'Never',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

/** "Today" / "Tomorrow" / "3d overdue" / a date, plus whether it is late. */
export function dueLabel(dueMs?: number | null): { text: string; late: boolean } {
  if (!dueMs) return { text: '', late: false }
  const today = startOfDay(Date.now())
  const due = startOfDay(dueMs)
  const days = Math.round((due - today) / 86_400_000)
  if (days === 0) return { text: 'Today', late: false }
  if (days === 1) return { text: 'Tomorrow', late: false }
  if (days === -1) return { text: 'Yesterday', late: true }
  if (days < 0) return { text: `${-days}d overdue`, late: true }
  if (days <= 6) return { text: new Date(dueMs).toLocaleDateString(undefined, { weekday: 'short' }), late: false }
  return { text: new Date(dueMs).toLocaleDateString(), late: false }
}

/** Local midnight of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Tasks due today or overdue, in the order they need attention. */
export function todaysTasks(tasks: Task[]): Task[] {
  const end = startOfDay(Date.now()) + 86_399_999
  return tasks
    .filter((t) => t.status !== 'done' && t.dueMs != null && t.dueMs <= end)
    .sort((a, b) => (a.dueMs ?? 0) - (b.dueMs ?? 0) || b.priority - a.priority)
}

/** Local YYYY-MM-DD, matching the backend's day keys. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

/** "just now" / "12m ago" / "3h ago" / a date. */
export function relative(ts: number): string {
  if (!ts) return ''
  const min = Math.round((Date.now() - ts) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}