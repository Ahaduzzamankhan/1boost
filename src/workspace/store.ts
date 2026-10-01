import {
  createContext,
  // `createElement` rather than JSX: this module is a `.ts` file (tests and
  // importers reach it by that path) and must stay free of markup.
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Page, Task } from '../../shared/types'
import { bridge } from '../bridge'

/**
 * One cache for the workspace, shared by every module.
 *
 * Three surfaces used to each call `bridge.tasksList()` on mount and keep
 * their own copy, so completing a task in one module left the others showing
 * stale rows until a reload — and every navigation between them refetched the
 * whole workspace. This is mounted once in the shell instead, so:
 *
 *  - the data is fetched exactly once per session,
 *  - every module reads the same objects, and a mutation is visible everywhere
 *    immediately, and
 *  - navigation is instant because there is nothing to wait for.
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
  /** True once a project page is being created, so the UI can disable itself. */
  busy: boolean
  /** Create a page and return it, optionally nested and marked as a project. */
  createPage: (patch?: Partial<Page>) => Promise<Page>
}

const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [pages, setPages] = useState<Page[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * A load that started before the newest one. Without this a slow first load
   * can land after a reload and resurrect stale data — the classic
   * "I deleted that and it came back" bug.
   */
  const loadSeq = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const [p, t] = await Promise.all([bridge.pagesList(), bridge.tasksList()])
      if (seq !== loadSeq.current) return
      setPages(p)
      setTasks(t)
      setError(null)
    } catch (e) {
      if (seq !== loadSeq.current) return
      setError(e instanceof Error ? e.message : 'The workspace could not be loaded.')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // A workspace import rewrote the files behind this cache. Refetching on the
  // event is what makes "Import workspace" appear to work: without it every
  // module would keep showing the pre-import list until a reload.
  useEffect(() => bridge.onWorkspaceChanged(() => void reload()), [reload])

  const savePage = useCallback(async (page: Page) => {
    setPages((cur) => upsert(cur ?? [], page))
    try {
      const saved = await bridge.pageSave(page)
      setPages((cur) => upsert(cur ?? [], saved))
      setError(null)
      return saved
    } catch (e) {
      // Roll back to what we had, so a failed save does not leave the UI
      // showing something the disk does not contain.
      await reload()
      setError(e instanceof Error ? e.message : 'That page could not be saved.')
      throw e
    }
  }, [reload])

  const deletePage = useCallback(
    async (id: string) => {
      const ok = await bridge.pageDelete(id)
      if (ok) {
        // Mirror the backend: a deleted page takes its descendants with it, and
        // its tasks lose the reference without being deleted.
        const gone = descendantsOf(pages ?? [], id)
        setPages((cur) => (cur ?? []).filter((p) => !gone.has(p.id)))
        setTasks((cur) =>
          (cur ?? []).map((t) =>
            gone.has(t.pageId) || gone.has(t.projectId)
              ? {
                  ...t,
                  pageId: gone.has(t.pageId) ? '' : t.pageId,
                  projectId: gone.has(t.projectId) ? '' : t.projectId,
                }
              : t,
          ),
        )
      }
      return ok
    },
    [pages],
  )

  const saveTask = useCallback(async (task: Task) => {
    setTasks((cur) => upsert(cur ?? [], task))
    try {
      const saved = await bridge.taskSave(task)
      setTasks((cur) => upsert(cur ?? [], saved))
      setError(null)
      return saved
    } catch (e) {
      await reload()
      setError(e instanceof Error ? e.message : 'That task could not be saved.')
      throw e
    }
  }, [reload])

  const toggleTask = useCallback(
    async (id: string) => {
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
    },
    [tasks, reload],
  )

  const deleteTask = useCallback(
    async (id: string) => {
      const ok = await bridge.taskDelete(id)
      if (ok) {
        // A subtask dies with its parent, so the subtree goes too.
        const gone = taskDescendants(tasks ?? [], id)
        setTasks((cur) =>
          (cur ?? [])
            .filter((t) => !gone.has(t.id))
            .map((t) => ({ ...t, blockedBy: t.blockedBy.filter((b) => !gone.has(b)) })),
        )
      }
      return ok
    },
    [tasks],
  )

  const clearDoneTasks = useCallback(async () => {
    const removed = await bridge.tasksClearDone()
    if (removed > 0) setTasks((cur) => (cur ?? []).filter((t) => t.status !== 'done'))
    return removed
  }, [])

  const createPage = useCallback(
    async (patch: Partial<Page> = {}) => {
      setBusy(true)
      try {
        return await savePage({
          id: '',
          title: '',
          icon: '',
          parentId: '',
          blocks: [],
          tags: [],
          favorite: false,
          archived: false,
          isProject: false,
          createdMs: 0,
          updatedMs: 0,
          ...patch,
        })
      } finally {
        setBusy(false)
      }
    },
    [savePage],
  )

  const value = useMemo<Workspace>(
    () => ({
      pages,
      tasks,
      loading,
      error,
      busy,
      reload,
      savePage,
      deletePage,
      saveTask,
      toggleTask,
      deleteTask,
      clearDoneTasks,
      createPage,
    }),
    [
      pages,
      tasks,
      loading,
      error,
      busy,
      reload,
      savePage,
      deletePage,
      saveTask,
      toggleTask,
      deleteTask,
      clearDoneTasks,
      createPage,
    ],
  )

  return createElement(WorkspaceContext.Provider, { value }, children)
}

/**
 * The shared workspace. Must be used under [`WorkspaceProvider`]; the error is
 * deliberate — silently falling back to a private cache is how the duplicate
 * state came back in the first place.
 */
export function useWorkspace(): Workspace {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return ctx
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  if (!item.id) return list
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

/** A page and every page beneath it. */
function descendantsOf(pages: Page[], id: string): Set<string> {
  const gone = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const p of pages) {
      if (!gone.has(p.id) && p.parentId && gone.has(p.parentId)) {
        gone.add(p.id)
        changed = true
      }
    }
  }
  return gone
}

/** A task and every task nested under it. */
function taskDescendants(tasks: Task[], id: string): Set<string> {
  const gone = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const t of tasks) {
      if (!gone.has(t.id) && t.parentId && gone.has(t.parentId)) {
        gone.add(t.id)
        changed = true
      }
    }
  }
  return gone
}

// The derived helpers live in their own module so they can be used without the
// bridge; re-exported here because "import the workspace helpers from the
// workspace module" is the obvious thing for a caller to do.
export * from './helpers'