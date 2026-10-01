import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page, Task } from '../../shared/types'
import { bridge } from '../bridge'

/**
 * One cache for the workspace, shared by Pages, Tasks and the Dashboard.
 *
 * Three surfaces used to each call `bridge.tasksList()` on mount and keep their
 * own copy, so completing a task in one module left the others showing stale
 * rows until a reload. There is a single load here and every module reads
 * from it, which is also why the "no duplicated state systems" rule matters:
 * this module is the only place the workspace lives in the renderer.
 *
 * Saves are optimistic — the local copy updates first and the backend result
 * replaces it — because the editor autosaves on every pause in typing and a
 * round trip before the next keystroke would drop characters.
 */

export interface Workspace {
  /** `null` until the first load settles. */
  pages: Page[] | null
  tasks: Task[] | null
  loading: boolean
  /** Set when the last load failed; the UI shows it rather than an empty list. */
  error: string | null
  reload: () => Promise<void>
  savePage: (page: Page) => Promise<Page>
  deletePage: (id: string) => Promise<boolean>
  saveTask: (task: Task) => Promise<Task>
  toggleTask: (id: string) => Promise<Task | null>
  deleteTask: (id: string) => Promise<boolean>
  clearDoneTasks: () => Promise<number>
}

export function useWorkspace(): Workspace {
  const [pages, setPages] = useState<Page[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([bridge.pagesList(), bridge.tasksList()])
      setPages(p)
      setTasks(t)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The workspace could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const savePage = useCallback(async (page: Page) => {
    // Optimistic: the editor renders from this immediately.
    setPages((cur) => upsert(cur ?? [], page))
    try {
      const saved = await bridge.pageSave(page)
      setPages((cur) => upsert(cur ?? [], saved))
      setError(null)
      return saved
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That page could not be saved.')
      throw e
    }
  }, [])

  const deletePage = useCallback(async (id: string) => {
    const ok = await bridge.pageDelete(id)
    if (ok) {
      // Mirror the backend: a deleted page takes its descendants with it, and
      // its tasks lose the reference without being deleted.
      const gone = new Set<string>()
      let changed = true
      while (changed) {
        changed = false
        for (const p of pages ?? []) {
          if (!gone.has(p.id) && p.parentId && gone.has(p.parentId)) {
            gone.add(p.id)
            changed = true
          }
        }
      }
      gone.add(id)
      setPages((cur) => (cur ?? []).filter((p) => !gone.has(p.id)))
      setTasks((cur) =>
        (cur ?? []).map((t) =>
          gone.has(t.pageId) || gone.has(t.projectId)
            ? { ...t, pageId: gone.has(t.pageId) ? '' : t.pageId, projectId: gone.has(t.projectId) ? '' : t.projectId }
            : t,
        ),
      )
    }
    return ok
  }, [pages])

  const saveTask = useCallback(async (task: Task) => {
    setTasks((cur) => upsert(cur ?? [], task))
    try {
      const saved = await bridge.taskSave(task)
      setTasks((cur) => upsert(cur ?? [], saved))
      setError(null)
      return saved
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That task could not be saved.')
      throw e
    }
  }, [])

  const toggleTask = useCallback(async (id: string) => {
    const before = (tasks ?? []).find((t) => t.id === id) ?? null
    if (before) {
      // Same rule the backend applies, so the row does not flicker back.
      const next: Task = {
        ...before,
        done: before.status !== 'done',
        status: before.status === 'done' ? 'todo' : 'done',
        completedMs: before.status === 'done' ? null : Date.now(),
      }
      setTasks((cur) => upsert(cur ?? [], next))
    }
    try {
      const saved = await bridge.taskToggle(id)
      if (saved) setTasks((cur) => upsert(cur ?? [], saved))
      else await reload()
      return saved
    } catch (e) {
      if (before) setTasks((cur) => upsert(cur ?? [], before))
      setError(e instanceof Error ? e.message : 'That task could not be updated.')
      return null
    }
  }, [tasks, reload])

  const deleteTask = useCallback(async (id: string) => {
    const ok = await bridge.taskDelete(id)
    if (ok) {
      // A subtask dies with its parent, so the subtree goes too.
      const gone = new Set<string>([id])
      let changed = true
      while (changed) {
        changed = false
        for (const t of tasks ?? []) {
          if (!gone.has(t.id) && t.parentId && gone.has(t.parentId)) {
            gone.add(t.id)
            changed = true
          }
        }
      }
      setTasks((cur) =>
        (cur ?? [])
          .filter((t) => !gone.has(t.id))
          .map((t) => ({ ...t, blockedBy: t.blockedBy.filter((b) => !gone.has(b)) })),
      )
    }
    return ok
  }, [tasks])

  const clearDoneTasks = useCallback(async () => {
    const removed = await bridge.tasksClearDone()
    if (removed > 0) setTasks((cur) => (cur ?? []).filter((t) => t.status !== 'done'))
    return removed
  }, [])

  return useMemo(
    () => ({
      pages,
      tasks,
      loading,
      error,
      reload,
      savePage,
      deletePage,
      saveTask,
      toggleTask,
      deleteTask,
      clearDoneTasks,
    }),
    [
      pages,
      tasks,
      loading,
      error,
      reload,
      savePage,
      deletePage,
      saveTask,
      toggleTask,
      deleteTask,
      clearDoneTasks,
    ],
  )
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  if (!item.id) return list
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

// The derived helpers live in their own module so they can be used without the
// bridge; re-exported here because "import the workspace helpers from the
// workspace module" is the obvious thing for a caller to do.
export * from './helpers'
