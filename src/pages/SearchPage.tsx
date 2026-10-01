import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CornerDownLeft,
  Keyboard,
  Search as SearchIcon,
  Sparkles,
  X,
} from 'lucide-react'
import type { SearchHit } from '../../shared/types'
import { bridge } from '../bridge'
import { useNavigation } from '../state'
import { useFocusTarget } from '../nav'
import { EmptyState, PageHeader } from '../components/ui'
import {
  GROUP_LIMIT,
  KindIcon,
  Marked,
  ScopeChips,
  appHitsToItems,
  cycleScope,
} from '../components/SearchBits'
import {
  EMPTY_SEARCH_INDEX,
  KIND_LABEL,
  buildSearchIndex,
  scopesFor,
  type SearchFilter,
  type SearchItem,
} from '../workspace/search'
import { relative } from '../workspace/helpers'
import { useWorkspace } from '../workspace/store'

/**
 * Global search.
 *
 * The command center is the keyboard shortcut; this is the place to stay in
 * when you want to read the whole result set, compare hits, or narrow by kind
 * with the mouse. Both read the same client-side index and render the same
 * rows, so results never disagree between them.
 *
 * Applications come from the backend — the usage history lives in Rust — and
 * are merged into the list behind a debounce, so typing stays at 60fps no
 * matter how much history has accumulated.
 */

/** How long after the last keystroke before asking Rust for application hits. */
const APP_QUERY_DEBOUNCE_MS = 140

/** Anything below this length matches too much history to be useful. */
const MIN_QUERY = 2

export default function SearchPage() {
  const { pages, tasks } = useWorkspace()
  const { navigate } = useNavigation()
  const { focus, setFocus, clearFocus } = useFocusTarget()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchFilter>('all')
  const [appHits, setAppHits] = useState<SearchItem[]>([])
  const [appFailed, setAppFailed] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Built once per data change, and not at all until something is typed: the
// sidebar-style field above is empty most of the time, and a task toggle
// elsewhere should not pay for an index nobody reads.
  const index = useMemo(
    () => (query.trim() ? buildSearchIndex(pages ?? [], tasks ?? []) : EMPTY_SEARCH_INDEX),
    [pages, tasks, query],
  )

  // A query handed over from the command center's "All results". The nonce
  // makes re-running the same handoff re-seed the field.
  const handed = focus?.searchQuery
  const nonce = focus?.nonce ?? 0
  useEffect(() => {
    if (handed === undefined) return
    setQuery(handed)
    setScope('all')
    setCursor(0)
    clearFocus()
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [handed, nonce, clearFocus])

  const q = query.trim()
  const wantsApps = q.length >= MIN_QUERY && (scope === 'all' || scope === 'app')

  // Debounced, and only for the one kind the renderer cannot answer itself.
  useEffect(() => {
    if (!wantsApps) {
      setAppHits([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      bridge
        .searchApps(q)
        .then((hits: SearchHit[]) => {
          if (cancelled) return
          setAppHits(appHitsToItems(hits))
          setAppFailed(false)
        })
        .catch(() => {
          if (cancelled) return
          setAppHits([])
          setAppFailed(true)
        })
    }, APP_QUERY_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, wantsApps])

  const open = useCallback(
    (item: SearchItem) => {
      if (item.kind === 'app') {
        // Straight to that application's detail rather than the list, which is
        // what picking a search result means everywhere else.
        void bridge.openAppDetail(item.id)
        return
      }
      if (item.kind === 'task') {
        navigate('tasks')
        setFocus({ taskId: item.id })
        return
      }
      navigate('notes')
      setFocus({ pageId: item.id })
    },
    [navigate, setFocus],
  )

  const sections = useMemo(() => {
    const groups: { key: string; label: string; items: SearchItem[] }[] = []

    if (scope === 'calendar') {
      // The agenda is the answer, with or without a query; showing "recently
      // touched" while the Calendar chip is on would be a filter that lies.
      for (const group of index.calendar(q, GROUP_LIMIT)) {
        groups.push({ key: `cal-${group.label}`, label: group.label, items: group.items })
      }
    } else if (!q) {
      // Nothing typed: the useful thing is what you touched most recently,
      // across every kind, so the page is useful on open rather than blank.
      const recent: SearchItem[] = [
        ...index.recent('project', 3),
        ...index.recent('page', 6),
        ...index.recent('task', 5),
      ]
      if (recent.length > 0) {
        groups.push({ key: 'recent', label: 'Recently touched', items: recent })
      }
      const agenda = index.calendar()
      if (agenda.length > 0) {
        groups.push({
          key: 'cal',
          label: 'On your calendar',
          items: agenda.flatMap((g) => g.items).slice(0, 6),
        })
      }
    } else {
      for (const group of index.search(q, scopesFor(scope))) {
        groups.push({ key: group.kind, label: group.label, items: group.items })
      }
      if (wantsApps && appHits.length > 0) {
        groups.push({ key: 'app', label: KIND_LABEL.app, items: appHits.slice(0, GROUP_LIMIT) })
      }
    }

    // Each group carries where it starts in the flat list, so arrow keys and
    // the highlight agree with what is on screen without an O(n^2) lookup.
    let at = 0
    return groups.map((g) => {
      const start = at
      at += g.items.length
      return { ...g, start }
    })
  }, [q, scope, index, appHits, wantsApps])

  const total = useMemo(() => sections.reduce((n, s) => n + s.items.length, 0), [sections])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, total - 1)))
  }, [total])

  // Keep the highlighted row on screen while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  // "/" anywhere on the page returns to the field, the way it does in every
  // list surface in 1Boost.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else inputRef.current?.blur()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (total ? (c + 1) % total : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (total ? (c - 1 + total) % total : 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(Math.max(0, total - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = sections.flatMap((s) => s.items)[cursor]
      if (item) open(item)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      setScope(cycleScope(scope, e.shiftKey ? -1 : 1))
      setCursor(0)
    }
  }

  const searching = q.length > 0

  return (
    <div className="page page-search">
      <PageHeader
        title="Search"
        subtitle={
          searching
            ? `${total} result${total === 1 ? '' : 's'} across pages, projects, tasks and applications`
            : 'Everything 1Boost knows about — one field, no setup'
        }
        action={
          <span className="search-kbd">
            Press <kbd>/</kbd> to search
          </span>
        }
      />

      <div className="search-bar">
        <SearchIcon size={17} />
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          autoComplete="off"
          aria-label="Search everything"
          placeholder="Search pages, projects, tasks and applications…"
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button className="btn btn-ghost" onClick={() => setQuery('')} aria-label="Clear search">
            <X size={15} />
          </button>
        ) : (
          <kbd>Esc</kbd>
        )}
      </div>

      <ScopeChips
        value={scope}
        onChange={(v) => {
          setScope(v)
          setCursor(0)
        }}
      />

      <div className="search-results" ref={listRef} role="listbox" aria-label="Search results">
        {total === 0 ? (
          <EmptyState
            icon={searching ? <SearchIcon size={22} /> : <Sparkles size={22} />}
            title={searching ? `Nothing matches “${q}”` : 'Nothing here yet'}
            desc={
              searching
                ? scope === 'all'
                  ? 'Try fewer words, or Tab to narrow the filter to one kind.'
                  : `No ${scope} results. Tab to widen the filter.`
                : 'Write a page or capture a task and it will show up here, newest first.'
            }
          />
        ) : (
          sections.map((section) => (
            <section
              key={section.key}
              className="search-section"
              role="group"
              aria-label={section.label}
            >
              <h2 className="search-section-label">
                {section.label}
                <span className="search-section-count">{section.items.length}</span>
              </h2>
              {section.items.map((item, n) => {
                const i = section.start + n
                return (
                  <button
                    key={`${item.kind}:${item.id}`}
                    role="option"
                    aria-selected={i === cursor}
                    data-idx={i}
                    className={`search-row${i === cursor ? ' active' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => open(item)}
                  >
                    <span className="search-row-icon">
                      <KindIcon kind={item.kind} />
                    </span>
                    <span className="search-row-main">
                      <span className="search-row-label">
                        <Marked text={item.title} query={q} />
                      </span>
                      <span className="search-row-sub">
                        {item.subtitle ? <Marked text={item.subtitle} query={q} /> : null}
                        {item.subtitle && item.detail ? <span className="search-row-dot">·</span> : null}
                        {item.detail ? <Marked text={item.detail} query={q} /> : null}
                      </span>
                    </span>
                    <span className="search-row-tail">
                      {item.updatedMs ? (
                        <span className="search-row-time">{relative(item.updatedMs)}</span>
                      ) : null}
                      {i === cursor ? <CornerDownLeft size={13} /> : null}
                    </span>
                  </button>
                )
              })}
              {section.items.length >= GROUP_LIMIT ? (
                <p className="search-section-more">
                  Narrow the filter to see the rest of {section.label.toLowerCase()}.
                </p>
              ) : null}
            </section>
          ))
        )}
        {appFailed && searching ? (
          <p className="search-note" role="status">
            Application history could not be searched. Pages, projects and tasks are unaffected.
          </p>
        ) : null}
      </div>

      <div className="search-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>Tab</kbd> filter
        </span>
        <span className="grow" />
        <span className="search-foot-hint">
          <Keyboard size={13} /> Ctrl+K from anywhere
        </span>
      </div>
    </div>
  )
}