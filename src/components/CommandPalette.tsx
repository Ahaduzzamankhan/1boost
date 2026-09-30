import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  CornerDownLeft,
  FileText,
  ListChecks,
  Search,
  Boxes,
} from 'lucide-react'
import type { PageId, SearchHit } from '../../shared/types'
import { bridge } from '../bridge'
import { MODULES } from '../modules/registry'

type Row =
  | { type: 'module'; id: PageId; label: string; hint: string; icon: React.ReactNode }
  | { type: 'hit'; id: string; label: string; hint: string; hit: SearchHit; icon: React.ReactNode }

/**
 * Ctrl+K — the one place to go. It searches modules (jump), then notes,
 * tasks and tracked apps (universal search). Results are ranked locally for
 * modules and by the Rust scorer for content, so typing feels instant.
 */
export default function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean
  onClose: () => void
  onNavigate: (page: PageId, payload?: { noteId?: string; taskId?: string }) => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setHits([])
      // Focus after paint so the caret lands in the field on Windows too.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Content search is debounced: the local module filter stays synchronous.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      bridge
        .searchEverything(q)
        .then((r) => {
          if (!cancelled) setHits(r)
        })
        .catch(() => {
          if (!cancelled) setHits([])
        })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open])

  const moduleRows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const list = MODULES.filter((m) => !m.footer)
    const scored = list
      .map((m) => {
        if (!q) return { m, s: 1 }
        const label = m.label.toLowerCase()
        const keywords = m.keywords.join(' ')
        if (label.startsWith(q)) return { m, s: 100 }
        if (label.includes(q)) return { m, s: 60 }
        if (keywords.includes(q)) return { m, s: 40 }
        return { m, s: 0 }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
    return scored.map(({ m }) => ({
      type: 'module' as const,
      id: m.id,
      label: m.label,
      hint: `Go to ${m.label}`,
      icon: m.icon,
    }))
  }, [query])

  const contentRows = useMemo<Row[]>(
    () =>
      hits.map((h) => ({
        type: 'hit' as const,
        id: h.id,
        label: h.title,
        hint: h.subtitle,
        hit: h,
        icon:
          h.kind === 'note' ? (
            <FileText size={15} />
          ) : h.kind === 'task' ? (
            <ListChecks size={15} />
          ) : (
            <Boxes size={15} />
          ),
      })),
    [hits],
  )

  const rows = useMemo<Row[]>(() => [...moduleRows, ...contentRows], [moduleRows, contentRows])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)))
  }, [rows.length])

  const activate = useCallback(
    (row: Row | undefined) => {
      if (!row) return
      if (row.type === 'module') {
        onNavigate(row.id)
      } else if (row.hit.kind === 'note') {
        onNavigate('notes', { noteId: row.hit.id })
      } else if (row.hit.kind === 'task') {
        onNavigate('tasks', { taskId: row.hit.id })
      } else {
        onNavigate('apps')
      }
      onClose()
    },
    [onNavigate, onClose],
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
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(rows[cursor])
    }
  }

  // Keep the active row visible while arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return createPortal(
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search modules, notes, tasks and apps…"
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-rows" ref={listRef}>
          {rows.length === 0 ? (
            <div className="palette-empty">
              {query.trim() ? (
                <>
                  Nothing matches <b>{query}</b>.
                </>
              ) : (
                <>
                  Type to search. <b>!</b> captures a task, <b>&gt;</b> a note — from quick
                  capture (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>).
                </>
              )}
            </div>
          ) : (
            rows.map((row, i) => (
              <button
                key={`${row.type}-${row.id}`}
                data-idx={i}
                className={`palette-row${i === cursor ? ' active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => activate(row)}
              >
                <span className="palette-row-icon">{row.icon}</span>
                <span className="palette-row-main">
                  <span className="palette-row-label">{row.label}</span>
                  {row.hint ? <span className="palette-row-hint">{row.hint}</span> : null}
                </span>
                <span className="palette-row-tail">
                  {row.type === 'hit' ? (
                    <span className="palette-badge">{row.hit.kind}</span>
                  ) : null}
                  {i === cursor ? <CornerDownLeft size={13} /> : <ArrowRight size={13} />}
                </span>
              </button>
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
          <span className="palette-foot-target">
            {rows[cursor] ? `→ ${rows[cursor].label}` : null}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}