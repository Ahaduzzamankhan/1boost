import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  CornerDownLeft,
  ListTodo,
  Plus,
  Search,
  Settings as SettingsIcon,
  Timer,
} from 'lucide-react'
import type { PageId, Task } from '../../shared/types'
import { bridge } from '../bridge'
import { MODULES } from '../modules/registry'
import {
  EMPTY_SEARCH_INDEX,
  KIND_LABEL,
  buildSearchIndex,
  scopesFor,
  type SearchFilter,
  type SearchItem,
} from '../workspace/search'
import { KindIcon, Marked, ScopeChips, appHitsToItems, cycleScope } from './SearchBits'
import { useWorkspace } from '../workspace/store'

/**
 * Ctrl+K — the command center.
 *
 * One box for everything: run an action, jump to a module, reopen something
 * recent, or search the workspace. It is the fastest path to anything in the
 * app, so it has to work without the mouse and feel instant.
 *
 * Pages, projects and tasks are searched locally against the shared workspace
 * cache (see `workspace/search`), so results appear on the same frame as the
 * keystroke. Only tracked applications come from the backend, because the
 * usage history lives there — and that lookup is debounced so it never sits
 * in the path of typing.
 */

/** The palette can show anything, so a row is a tagged union rather than a
 *  search hit. Everything shares the same shape so one renderer covers it. */
type Row =
  | { type: 'action'; id: string; label: string; hint: string; group: string; icon: React.ReactNode; detail?: string; run: () => void }
  | { type: 'module'; id: string; label: string; hint: string; group: string; icon: React.ReactNode; detail?: string; page: PageId }
  | { type: 'hit'; id: string; label: string; hint: string; group: string; icon: React.ReactNode; detail?: string; kind: SearchItem['kind']; target: string }

/** How long to wait after the last keystroke before asking Rust for apps. */
const APP_QUERY_DEBOUNCE_MS = 130

export interface CommandCenterProps {
  open: boolean
  onClose: () => void
  onNavigate: (page: PageId, payload?: { pageId?: string; taskId?: string }) => void
  /** Opens the global search surface, pre-filled with the current query. */
  onOpenSearch?: (query: string) => void
}

export default function CommandCenter({
  open,
  onClose,
  onNavigate,
  onOpenSearch,
}: CommandCenterProps) {
  const { pages, tasks, createPage, saveTask, busy } = useWorkspace()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [scope, setScope] = useState<SearchFilter>('all')
  const [appHits, setAppHits] = useState<SearchItem[]>([])
  const [appError, setAppError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Set while a row's action is still running, so it cannot be run twice. */
  const creating = useRef(false)

  // One index for every panel, rebuilt only when the underlying data changes
  // rather than on each keystroke. Gated on `open` so a task toggle elsewhere
  // does not rebuild an index nobody is looking at.
  const index = useMemo(
    () => (open ? buildSearchIndex(pages ?? [], tasks ?? []) : EMPTY_SEARCH_INDEX),
    [open, pages, tasks],
  )

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setScope('all')
      setAppHits([])
      setAppError(false)
      creating.current = false
      // Focus after paint so the caret lands in the field on Windows too.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Applications live in the usage history, so they are the one kind that has
  // to come from the backend. Skipped for short queries and for scopes that
  // exclude apps, which keeps this off the critical path.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2 || (scope !== 'all' && scope !== 'app')) {
      setAppHits([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      bridge
        .searchApps(q)
        .then((r) => {
          if (cancelled) return
          setAppHits(appHitsToItems(r))
          setAppError(false)
        })
        .catch(() => {
          if (!cancelled) {
            setAppHits([])
            // Only worth saying when apps are the thing being searched; a
            // failed app lookup should not look like "no results".
            setAppError(true)
          }
        })
    }, APP_QUERY_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open, scope])

  const go = useCallback(
    (page: PageId, payload?: { pageId?: string; taskId?: string }) => {
      onNavigate(page, payload)
      onClose()
    },
    [onNavigate, onClose],
  )

  const newPage = useCallback(
    async (isProject: boolean) => {
      if (creating.current) return
      creating.current = true
      onClose()
      try {
        const page = await createPage({ isProject })
        onNavigate('notes', { pageId: page.id })
      } finally {
        creating.current = false
      }
    },
    [createPage, onClose, onNavigate],
  )

  /**
   * A task captured straight from what was typed.
   *
   * It goes into the first live project when there is one, because an unfiled
   * task is the thing that gets forgotten; with no projects it stays loose
   * rather than inventing a container.
   */
  const newTask = useCallback(
    async (title: string) => {
      if (creating.current) return
      creating.current = true
      onClose()
      const project = (pages ?? []).find((p) => p.isProject && !p.archived)
      const task: Task = {
        id: '',
        title,
        done: false,
        status: 'todo',
        priority: 0,
        dueMs: null,
        tags: [],
        projectId: project?.id ?? '',
        pageId: '',
        parentId: '',
        blockedBy: [],
        recurrence: '',
        order: 0,
        createdMs: 0,
        updatedMs: 0,
        completedMs: null,
      }
      try {
        // Through the shared store, not the bridge directly: the Tasks page
        // and the dashboard read that cache, so writing behind their backs
        // would leave a task nobody can see until a reload.
        await saveTask(task)
        onNavigate('tasks')
      } catch {
        // The store records the failure and the Tasks page shows it; the
        // capture simply does not happen, rather than failing silently.
      } finally {
        creating.current = false
      }
    },
    [pages, saveTask, onClose, onNavigate],
  )

  const actions = useMemo(
    () => [
      {
        id: 'action:new-page',
        label: 'New page',
        hint: 'Create a page and start writing',
        group: 'Actions',
        icon: <KindIcon kind="page" />,
        run: () => void newPage(false),
      },
      {
        id: 'action:new-project',
        label: 'New project',
        hint: 'A page that owns its tasks',
        group: 'Actions',
        icon: <KindIcon kind="project" />,
        run: () => void newPage(true),
      },
      {
        id: 'action:new-task',
        label: query.trim() && !query.trim().startsWith('>') ? `New task “${query.trim()}”` : 'New task',
        hint: 'Create a task from what you typed',
        group: 'Actions',
        icon: <KindIcon kind="task" />,
        run: () => (query.trim() ? void newTask(query.trim()) : go('tasks')),
      },
      {
        id: 'action:capture',
        label: 'Quick capture',
        hint: 'Ctrl+Shift+Space',
        group: 'Actions',
        icon: <Plus size={15} />,
        run: () => {
          onClose()
          // The shell owns the capture overlay, so dispatch the shortcut the
          // user would press rather than duplicating its state here.
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, shiftKey: true }),
          )
        },
      },
      {
        id: 'action:today',
        label: "Go to today's tasks",
        hint: 'Open Tasks',
        group: 'Actions',
        icon: <Timer size={15} />,
        run: () => go('tasks'),
      },
      {
        id: 'action:toggle-tracking',
        label: 'Pause tracking',
        hint: 'Stop recording usage without quitting',
        group: 'Actions',
        icon: <ListTodo size={15} />,
        run: () => {
          onClose()
          void (async () => {
            try {
              // Read the current value rather than guessing: this pref is
              // toggled from the tray too, so hardcoding "pause" would
              // silently resume a paused session.
              const data = await bridge.getSettingsData()
              await bridge.setPref('pauseTracking', !data.prefs.pauseTracking)
            } catch {
              // Nothing to do here; the shell's status indicator still shows
              // the real value, so the worst case is a no-op.
            }
          })()
        },
      },
      {
        id: 'action:settings',
        label: 'Open settings',
        hint: 'Theme, tracking, data',
        group: 'Actions',
        icon: <SettingsIcon size={15} />,
        run: () => go('settings'),
      },
    ],
    [query, newPage, newTask, go, onClose],
  )

  const moduleRows = useMemo<Row[]>(
    () =>
      // `hidden` only keeps a module out of the *sidebar*; it still belongs
      // here, or the Search page would be reachable only once you had
      // already typed something into search.
      MODULES.filter((m) => !m.footer).map((m) => ({
        type: 'module',
        id: `module:${m.id}`,
        label: m.label,
        hint: m.keywords.slice(0, 3).join(' · '),
        group: 'Go to',
        icon: m.icon,
        page: m.id,
      })),
    [],
  )

  const rows = useMemo(() => {
    const q = query.trim()
    const scopes = scopesFor(scope)
    // Recents only make sense when nothing specific was typed; otherwise they
    // crowd out the results the user is actually looking for.
    const hits = q
      ? index.search(q, scopes).flatMap((g) => g.items)
      : [...index.recent('project', 4), ...index.recent('page', 5)]

    const out: Row[] = q ? [] : actions.map((a) => ({ ...a, type: 'action' as const, run: a.run }))

    for (const h of hits) {
      out.push({
        type: 'hit',
        id: `${h.kind}:${h.id}`,
        label: h.title,
        hint: h.subtitle,
        detail: h.detail,
        group: q ? KIND_LABEL[h.kind] : h.kind === 'project' ? 'Recent projects' : 'Recent pages',
        icon: <KindIcon kind={h.kind} />,
        kind: h.kind,
        target: h.id,
      })
    }

    if (!q) {
      for (const m of moduleRows) out.push(m)
    } else {
      // Apps are appended rather than interleaved: their ranking is the
      // backend's, and mixing them in would reshuffle while typing.
      if (scope === 'all' || scope === 'app') {
        for (const a of appHits.slice(0, 5)) {
          out.push({
            type: 'hit',
            id: `app:${a.id}`,
            label: a.title,
            hint: a.subtitle,
            group: KIND_LABEL.app,
            icon: <KindIcon kind="app" />,
            kind: 'app',
            target: a.id,
          })
        }
      }
    }
    return out
  }, [query, scope, index, actions, moduleRows, appHits])

  // Group boundaries, so the list can render headers and carries the flat
  // index of its first row — the highlight then agrees with the screen
  // without an O(n^2) lookup per rendered row.
  const sections = useMemo(() => {
    const out: { label: string; rows: Row[]; start: number }[] = []
    rows.forEach((row, i) => {
      const last = out[out.length - 1]
      if (last && last.label === row.group) last.rows.push(row)
      else out.push({ label: row.group, rows: [row], start: i })
    })
    return out
  }, [rows])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)))
  }, [rows.length])

  // Keep the active row visible while arrowing through a long list.
  // Every hook must run before the `if (!open)` early return below — an effect
  // declared after it changes React's hook count when the palette opens and
  // tears down the whole tree (a black screen).
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const openHit = useCallback(
    (kind: SearchItem['kind'], id: string) => {
      if (kind === 'app') {
        // Straight to that application's detail rather than the list, which is
        // what picking a search result means everywhere else.
        void bridge.openAppDetail(id)
        onClose()
        return
      }
      if (kind === 'task') go('tasks', { taskId: id })
      else go('notes', { pageId: id })
    },
    [go, onClose],
  )

  const activate = useCallback(
    (row: Row | undefined) => {
      if (!row) return
      if (row.type === 'action') row.run()
      else if (row.type === 'module') go(row.page)
      else openHit(row.kind, row.target)
      onClose()
    },
    [go, openHit, onClose],
  )

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (rows.length ? (c + 1) % rows.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(Math.max(0, rows.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(rows[cursor])
    } else if (e.key === 'Tab') {
      // Tab cycles the scope filter: it is the only other control up here.
      e.preventDefault()
      setScope(cycleScope(scope, e.shiftKey ? -1 : 1))
      setCursor(0)
    } else if (e.key === '>' && !query) {
      // A leading ">" jumps to Tasks, the way it does in quick capture.
      e.preventDefault()
      go('tasks')
    }
  }

  return createPortal(
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="palette palette-center"
        role="dialog"
        aria-modal="true"
        aria-label="Command center"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search everything, or type a command…"
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Search or run a command"
          />
          {busy ? <span className="palette-busy">…</span> : <kbd>Esc</kbd>}
        </div>

        <ScopeChips
          value={scope}
          onChange={(v) => {
            setScope(v)
            setCursor(0)
          }}
          trailing={
            query.trim() && onOpenSearch ? (
              <button className="palette-scope more" onClick={() => onOpenSearch(query.trim())}>
                All results
              </button>
            ) : null
          }
        />

        <div className="palette-rows" ref={listRef} role="listbox" aria-label="Results">
          {rows.length === 0 ? (
            <div className="palette-empty">
              {query.trim() ? (
                <>
                  Nothing matches <b>{query.trim()}</b>. Press <kbd>Enter</kbd> to capture it as a
                  task.
                </>
              ) : (
                <>
                  Type to search, or press <kbd>&gt;</kbd> for tasks.
                </>
              )}
              {appError ? (
                <span className="palette-note">
                  Application search is unavailable right now — pages, projects and tasks still work.
                </span>
              ) : null}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.label} className="palette-section" role="group" aria-label={section.label}>
                <div className="palette-section-label">{section.label}</div>
                {section.rows.map((row, n) => {
                  const i = section.start + n
                  return (
                    <button
                      key={`${row.type}-${row.id}`}
                      role="option"
                      aria-selected={i === cursor}
                      data-idx={i}
                      className={`palette-row${i === cursor ? ' active' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => activate(row)}
                    >
                      <span className="palette-row-icon">{row.icon}</span>
                      <span className="palette-row-main">
                        <span className="palette-row-label">
                          <Marked text={row.label} query={query} />
                        </span>
                        {row.hint ? (
                          <span className="palette-row-hint">
                            <Marked text={row.hint} query={query} />
                          </span>
                        ) : null}
                      </span>
                      <span className="palette-row-tail">
                        {row.detail ? <span className="palette-badge subtle">{row.detail}</span> : null}
                        {i === cursor ? <CornerDownLeft size={13} /> : <ArrowRight size={13} />}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>Tab</kbd> filter
          </span>
          <span className="palette-foot-target">
            {rows[cursor] ? `→ ${rows[cursor].label}` : null}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}