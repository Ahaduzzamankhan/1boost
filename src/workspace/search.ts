import type { Page, SearchKind, Task } from '../../shared/types'
import { STATUS_LABEL, pageText, startOfDay } from './helpers'

/**
 * One search index, shared by the command center, the global search surface
 * and anything else that needs to find something.
 *
 * The backend still ranks and searches tracked applications (it owns the usage
 * history), but pages, projects and tasks are all already in memory here.
 * Scoring them locally is what makes typing feel instant: no IPC per
 * keystroke, no debounce round trip, and results update on the same frame as
 * the input event.
 */

export interface SearchItem {
  kind: SearchKind
  id: string
  title: string
  /** The line under the title. */
  subtitle: string
  /** Extra context, e.g. the project a task belongs to. */
  detail?: string
  score: number
  updatedMs: number
}

export interface SearchGroup {
  kind: SearchKind
  label: string
  items: SearchItem[]
}

export const KIND_LABEL: Record<SearchKind, string> = {
  page: 'Pages',
  project: 'Projects',
  task: 'Tasks',
  app: 'Applications',
}

/**
 * A filter chip. `calendar` is not a backend kind — it is a view over the
 * tasks that carry a due date, so it lives here rather than in the Rust
 * searcher's vocabulary.
 */
export type SearchScope = SearchKind | 'calendar'

/** A chip value. `all` is not a scope, it means "no filter". */
export type SearchFilter = SearchScope | 'all'

export const SCOPES: { value: SearchFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Projects' },
  { value: 'page', label: 'Pages' },
  { value: 'task', label: 'Tasks' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'app', label: 'Apps' },
]

/** The backend scopes a chip searches, or `[]` for "everything local". */
export function scopesFor(scope: SearchFilter): SearchKind[] {
  if (scope === 'all') return []
  if (scope === 'calendar') return ['task']
  return [scope]
}

/** The order groups appear in. Pages before tasks: writing outranks doing. */
const KIND_ORDER: SearchKind[] = ['project', 'page', 'task', 'app']

/**
 * Score one query against one candidate.
 *
 * Deliberately simple and predictable rather than clever: an exact title hit
 * always wins, a prefix beats a substring, and a substring beats a scattered
 * subsequence. The backend's fuzzy scorer does the same thing in Rust; this
 * only has to agree with it closely enough that the two result sets blend.
 */
export function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (!h) return -1
  if (h === n) return 1000
  if (h.startsWith(n)) return 800 - Math.min(200, h.length - n.length)
  const at = h.indexOf(n)
  if (at >= 0) {
    // A match in the middle of a long string is a weaker signal than one at
    // the start, but still far better than a scattered match.
    return 600 - Math.min(200, at * 4) - Math.min(200, h.length - n.length)
  }
  // Word-prefix: "road" matching "Roadmap" as a whole word.
  const words = h.split(/[\s\-_/.,:;!?()[\]]+/)
  for (const w of words) {
    if (w.startsWith(n)) return 500 - Math.min(200, w.length - n.length)
  }
  if (subsequence(h, n)) return 240
  return -1
}

/** Every character of `needle` appears in `haystack`, in order. */
function subsequence(haystack: string, needle: string): boolean {
  let i = 0
  for (const c of haystack) {
    if (c === needle[i]) i += 1
    if (i === needle.length) return true
  }
  return needle.length === 0
}

/** Everything searchable in the workspace, built once per data change. */
export interface SearchIndex {
  items: SearchItem[]
  /** Recency-sorted items of one kind, for "recent pages" style lists. */
  recent: (kind: SearchKind, limit: number) => SearchItem[]
  search: (query: string, scopes?: SearchKind[], limit?: number) => SearchGroup[]
  byId: (kind: SearchKind, id: string) => SearchItem | undefined
  /**
   * Dated tasks as calendar entries, bucketed the way a person thinks about
   * them: overdue first, then today, tomorrow, the rest of the week, later.
   * With no query this is the agenda; with one it is a filtered agenda.
   */
  calendar: (query?: string, limit?: number) => CalendarGroup[]
}

/** A dated-task bucket, e.g. "Overdue" or "Tomorrow". */
export interface CalendarGroup {
  label: string
  items: SearchItem[]
  /** Bucket ordering key; lower sorts first. */
  order: number
}

export function buildSearchIndex(pages: Page[], tasks: Task[]): SearchIndex {
  const pageTitles = new Map(pages.map((p) => [p.id, p.title || 'Untitled']))

  const items: SearchItem[] = []

  for (const p of pages) {
    if (p.archived) continue
    const body = pageText(p)
    items.push({
      kind: p.isProject ? 'project' : 'page',
      id: p.id,
      title: p.title || 'Untitled',
      subtitle: body ? firstLine(body) : 'Empty page',
      score: 0,
      updatedMs: p.updatedMs,
    })
  }

  for (const t of tasks) {
    const project = t.projectId ? pageTitles.get(t.projectId) : undefined
    const source = t.pageId ? pageTitles.get(t.pageId) : undefined
    const detail = [project && `in ${project}`, source && `from ${source}`].filter(Boolean).join(' · ')
    items.push({
      kind: 'task',
      id: t.id,
      title: t.title,
      subtitle: STATUS_LABEL[t.status],
      detail: detail || undefined,
      score: 0,
      updatedMs: t.updatedMs,
    })
  }

  const byKind = new Map<string, SearchItem>()
  for (const item of items) byKind.set(`${item.kind}:${item.id}`, item)

  // Recency lists are sorted once here rather than on every render.
  const sortedByRecency = [...items].sort((a, b) => b.updatedMs - a.updatedMs)

  // Calendar entries are the dated tasks. `dueMs` lives on the task, so the
  // day bucket is derived here instead of being stored twice.
  const calendarItems: (SearchItem & { due: number })[] = []
  for (const t of tasks) {
    if (t.dueMs == null) continue
    const item = byKind.get(`task:${t.id}`)
    if (item) calendarItems.push({ ...item, due: t.dueMs })
  }
  calendarItems.sort((a, b) => a.due - b.due || b.updatedMs - a.updatedMs)

  return {
    items,

    recent(kind, limit) {
      return sortedByRecency.filter((i) => i.kind === kind).slice(0, limit)
    },

    byId(kind, id) {
      return byKind.get(`${kind}:${id}`)
    },

    calendar(query = '', limit = 8) {
      const q = query.trim()
      const groups = new Map<string, CalendarGroup>()
      for (const entry of calendarItems) {
        if (q) {
          const best = Math.max(scoreMatch(entry.title, q), scoreMatch(entry.subtitle, q) - 60)
          if (best < 0) continue
        }
        const bucket = dayBucket(entry.due)
        const group = groups.get(bucket.label)
        if (group) {
          if (group.items.length < limit) group.items.push(entry)
        } else {
          groups.set(bucket.label, { label: bucket.label, order: bucket.order, items: [entry] })
        }
      }
      return [...groups.values()].sort((a, b) => a.order - b.order)
    },

    search(query, scopes = [], limit = 30) {
      const q = query.trim()
      if (!q) return []
      const wanted = new Set(scopes)
      const hits: SearchItem[] = []
      for (const item of items) {
        if (wanted.size > 0 && !wanted.has(item.kind)) continue
        const title = scoreMatch(item.title, q)
        const subtitle = scoreMatch(item.subtitle, q)
        const detail = item.detail ? scoreMatch(item.detail, q) : -1
        const best = Math.max(title, subtitle - 60, detail - 120)
        if (best < 0) continue
        hits.push({ ...item, score: best })
      }
      // Recency only breaks ties: a strong title match must not lose to a weak
      // one that happens to be recent, or results reshuffle while typing.
      hits.sort((a, b) => b.score - a.score || b.updatedMs - a.updatedMs)

      const groups: SearchGroup[] = []
      for (const kind of KIND_ORDER) {
        const groupItems = hits.filter((h) => h.kind === kind).slice(0, limit)
        if (groupItems.length > 0) groups.push({ kind, label: KIND_LABEL[kind], items: groupItems })
      }
      return groups
    },
  }
}

/**
 * A shared empty index, for surfaces that should not pay to build one until
 * something is actually typed. Building it is cheap but not free, and a task
 * toggle re-runs the memo that holds it.
 */
export const EMPTY_SEARCH_INDEX: SearchIndex = buildSearchIndex([], [])

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.trim().slice(0, 90)
}

/** Which agenda bucket a due date falls into. */
function dayBucket(dueMs: number): { label: string; order: number } {
  const today = startOfDay(Date.now())
  const days = Math.round((startOfDay(dueMs) - today) / 86_400_000)
  if (days < 0) return { label: 'Overdue', order: 0 }
  if (days === 0) return { label: 'Today', order: 1 }
  if (days === 1) return { label: 'Tomorrow', order: 2 }
  if (days <= 7) return { label: 'This week', order: 3 }
  return { label: 'Later', order: 4 }
}

/**
 * Splits `text` around every case-insensitive occurrence of `query`, so a
 * match can be marked without dangerouslySetInnerHTML.
 *
 * Falls back to highlighting nothing rather than throwing when the query has
 * been mangled into a regex metacharacter stream by a fast typist.
 */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim()
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  // A handful of matches is enough to show the shape without flooding the row.
  for (let n = 0; n < 6; n += 1) {
    const found = lower.indexOf(needle, at)
    if (found === -1) break
    if (found > at) parts.push({ text: text.slice(at, found), hit: false })
    parts.push({ text: text.slice(found, found + needle.length), hit: true })
    at = found + needle.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}