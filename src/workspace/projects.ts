import type { Page, Task } from '../../shared/types'

/**
 * Project rollups.
 *
 * A project is not a second entity — it is a page with `isProject` set. What
 * the UI needs on top of that is *derived*: how much of its work is done, how
 * many pages hang under it, what is still open. Deriving it here, from the
 * shared store's arrays, means:
 *
 *  - there is exactly one definition of "how done is this project", so the
 *    dashboard, the page view and the sidebar can never disagree;
 *  - the numbers are always current, because they are recomputed from the same
 *    objects every surface is already rendering. A server-side rollup would
 *    need its own refresh and would show a stale count until it happened.
 *
 * A project's pages include its own descendants, so nesting a page under a
 * project really does put it inside the project.
 */

export interface ProjectRollup {
  /** Same id as the underlying page. */
  id: string
  title: string
  icon: string
  /** The page itself, so callers can open it without a second lookup. */
  page: Page
  /** Tasks whose `projectId` is this project, including subtasks. */
  taskCount: number
  taskDone: number
  /** Tasks that are not done. */
  taskOpen: number
  /** The next due date among its open tasks, for "next deadline". */
  nextDueMs: number | null
  /** Live project pages beneath it, excluding itself. */
  pageCount: number
  /** Ids of those pages, in title order. */
  pageIds: string[]
  updatedMs: number
}

/**
 * Every live project page, most recently touched first.
 *
 * Archived pages are excluded: they are out of the user's way on purpose, and
 * an archived project should not appear on the dashboard or in search.
 */
export function projectRollups(pages: Page[], tasks: Task[]): ProjectRollup[] {
  const live = pages.filter((p) => !p.archived)

  // One pass over the tasks, bucketed by project. Cheaper than filtering the
  // whole list once per project, and the dashboard renders this on every
  // workspace change.
  const byProject = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.projectId) continue
    const list = byProject.get(t.projectId)
    if (list) list.push(t)
    else byProject.set(t.projectId, [t])
  }

  const out: ProjectRollup[] = []
  for (const page of live) {
    if (!page.isProject) continue
    const owned = byProject.get(page.id) ?? []
    const pageIds = descendants(live, page.id).filter((id) => id !== page.id)
    let taskDone = 0
    let nextDueMs: number | null = null
    for (const t of owned) {
      if (t.status === 'done') taskDone += 1
      if (t.status !== 'done' && t.dueMs != null && (nextDueMs === null || t.dueMs < nextDueMs)) {
        nextDueMs = t.dueMs
      }
    }
    out.push({
      id: page.id,
      title: page.title || 'Untitled project',
      icon: page.icon,
      page,
      taskCount: owned.length,
      taskDone,
      taskOpen: owned.length - taskDone,
      nextDueMs,
      pageCount: pageIds.length,
      pageIds,
      updatedMs: page.updatedMs,
    })
  }
  out.sort((a, b) => b.updatedMs - a.updatedMs)
  return out
}

/** Ids of `id` and everything beneath it. Cycles cannot happen, but a
 *  corrupted file must not hang the UI either. */
function descendants(pages: Page[], id: string): string[] {
  const byParent = new Map<string, string[]>()
  for (const p of pages) {
    if (!p.parentId) continue
    const list = byParent.get(p.parentId)
    if (list) list.push(p.id)
    else byParent.set(p.parentId, [p.id])
  }
  const out: string[] = []
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift() as string
    out.push(current)
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return out
}

/** 0..1, for a progress bar. An empty project reads as "not started", not done. */
export function projectProgress(p: ProjectRollup): number {
  return p.taskCount > 0 ? p.taskDone / p.taskCount : 0
}