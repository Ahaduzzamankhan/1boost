import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  NotebookPen,
  Pin,
  PinOff,
  Search,
  Trash2,
  Tag,
  X,
  Check,
} from 'lucide-react'
import type { Note } from '../../shared/types'
import { bridge } from '../bridge'
import { useFocusTarget } from '../nav'
import { EmptyState } from '../components/ui'

function relative(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

const emptyDraft = (): Note => ({
  id: '',
  title: '',
  body: '',
  tags: [],
  pinned: false,
  createdMs: 0,
  updatedMs: 0,
})

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [selected, setSelected] = useState<Note>(emptyDraft())
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const { focus, clearFocus } = useFocusTarget()

  const load = useCallback(async () => {
    try {
      const list = await bridge.notesList()
      setNotes(list)
      // Nothing open yet: start on the first note, or a fresh draft.
      if (list.length > 0) setSelected((cur) => (cur.id ? cur : list[0]))
    } catch {
      setNotes([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A search hit from the palette opens that note directly.
  useEffect(() => {
    if (!focus?.noteId) return
    const found = notes?.find((n) => n.id === focus.noteId)
    if (found) {
      setSelected(found)
      setDirty(false)
    }
    clearFocus()
  }, [focus, notes, clearFocus])

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of notes ?? []) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [notes])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (notes ?? []).filter((n) => {
      if (tag && !n.tags.includes(tag)) return false
      if (!q) return true
      return (
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q) ||
        n.tags.some((t) => t.includes(q))
      )
    })
  }, [notes, query, tag])

  const save = async () => {
    const saved = await bridge.noteSave(selected)
    setSelected(saved)
    setDirty(false)
    await load()
  }

  const newNote = () => {
    setSelected(emptyDraft())
    setDirty(false)
  }

  const remove = async (id: string) => {
    await bridge.noteDelete(id)
    const next = (notes ?? []).find((n) => n.id !== id)
    if (selected.id === id) setSelected(next ?? emptyDraft())
    await load()
  }

  const togglePin = async () => {
    const next = { ...selected, pinned: !selected.pinned }
    setSelected(next)
    setDirty(true)
    if (next.id) await bridge.noteSave(next).then((saved) => setSelected(saved))
    await load()
  }

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, '').toLowerCase()
    if (!t || selected.tags.includes(t)) return setTagInput('')
    setSelected({ ...selected, tags: [...selected.tags, t].sort() })
    setTagInput('')
    setDirty(true)
  }

  const removeTag = (t: string) => {
    setSelected({ ...selected, tags: selected.tags.filter((x) => x !== t) })
    setDirty(true)
  }

  // Ctrl+S saves, matching every other editor on the planet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (notes && notes.length === 0 && !selected.title) {
    return (
      <div className="page">
        <h1 className="page-title">Notes</h1>
        <p className="page-subtitle">Scratchpads, lists and anything worth keeping</p>
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            icon={<NotebookPen size={24} />}
            title="No notes yet"
            desc="Press Ctrl+Shift+Space anywhere to capture one without leaving what you were doing."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="page notes-page">
      <div className="notes-head">
        <div>
          <h1 className="page-title">Notes</h1>
          <p className="page-subtitle">
            {visible.length} of {notes?.length ?? 0} notes
          </p>
        </div>
        <div className="notes-head-actions">
          <div className="search-box">
            <Search size={15} />
            <input
              value={query}
              placeholder="Filter notes…"
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            {query ? (
              <button aria-label="Clear" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            ) : null}
          </div>
          <button className="btn btn-primary" onClick={newNote}>
            <NotebookPen size={15} /> New
          </button>
        </div>
      </div>

      {tags.length > 0 ? (
        <div className="chip-row">
          <button className={`chip${tag === null ? ' active' : ''}`} onClick={() => setTag(null)}>
            All
          </button>
          {tags.map(([t, count]) => (
            <button key={t} className={`chip${tag === t ? ' active' : ''}`} onClick={() => setTag(t)}>
              <Tag size={12} /> {t} <span className="chip-count">{count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="notes-split">
        <div className="notes-list card">
          {visible.length === 0 ? (
            <div className="notes-empty">No notes match this filter.</div>
          ) : (
            visible.map((n) => (
              <button
                key={n.id}
                className={`note-row${selected.id === n.id ? ' active' : ''}`}
                onClick={() => {
                  setSelected(n)
                  setDirty(false)
                }}
              >
                <div className="note-row-head">
                  <span className="note-row-title">{n.title || 'Untitled'}</span>
                  {n.pinned ? <Pin size={12} className="note-pin" /> : null}
                </div>
                <div className="note-row-meta">
                  {relative(n.updatedMs)}
                  {n.tags.length ? ` · ${n.tags.join(' ')}` : ''}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="note-editor card">
          <div className="note-editor-bar">
            <input
              className="note-title-input"
              value={selected.title}
              placeholder="Title"
              onChange={(e) => {
                setSelected({ ...selected, title: e.target.value })
                setDirty(true)
              }}
            />
            <div className="note-editor-actions">
              <button
                className="btn btn-ghost"
                onClick={togglePin}
                title={selected.pinned ? 'Unpin' : 'Pin'}
                aria-label={selected.pinned ? 'Unpin' : 'Pin'}
              >
                {selected.pinned ? <PinOff size={16} /> : <Pin size={16} />}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void remove(selected.id)}
                disabled={!selected.id}
                title="Delete"
                aria-label="Delete note"
              >
                <Trash2 size={16} />
              </button>
              <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty}>
                <Check size={15} /> {dirty ? 'Save' : 'Saved'}
              </button>
            </div>
          </div>

          <textarea
            className="note-body"
            value={selected.body}
            placeholder="Write anything…"
            onChange={(e) => {
              setSelected({ ...selected, body: e.target.value })
              setDirty(true)
            }}
            spellCheck
          />

          <div className="note-tags">
            {selected.tags.map((t) => (
              <span key={t} className="tag-pill">
                {t}
                <button aria-label={`Remove tag ${t}`} onClick={() => removeTag(t)}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <input
              className="tag-input"
              value={tagInput}
              placeholder="+ tag"
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag()
                } else if (e.key === 'Backspace' && !tagInput && selected.tags.length) {
                  removeTag(selected.tags[selected.tags.length - 1])
                }
              }}
              onBlur={addTag}
            />
          </div>
        </div>
      </div>
    </div>
  )
}