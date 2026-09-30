import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Copy, Pin, PinOff, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { Clip } from '../../shared/types'
import { bridge } from '../bridge'
import { EmptyState } from '../components/ui'

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** Collapse whitespace for the one-line preview. */
function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export default function ClipboardPage() {
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setClips(await bridge.clipsList())
    } catch {
      setClips([])
    }
  }, [])

  useEffect(() => {
    void load()
    // The backend records new clipboard entries continuously; poll so the
    // list fills in while the page is open.
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return clips ?? []
    return (clips ?? []).filter((c) => c.text.toLowerCase().includes(q))
  }, [clips, query])

  const copy = async (c: Clip) => {
    await bridge.clipPaste(c.id)
    setCopied(c.id)
    setTimeout(() => setCopied(null), 1200)
  }

  const pinnedCount = (clips ?? []).filter((c) => c.pinned).length

  return (
    <div className="page clips-page">
      <div className="notes-head">
        <div>
          <h1 className="page-title">Clipboard</h1>
          <p className="page-subtitle">
            {clips?.length ?? 0} entries · {pinnedCount} pinned
          </p>
        </div>
        <div className="notes-head-actions">
          <div className="search-box">
            <Search size={15} />
            <input
              value={query}
              placeholder="Search history…"
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            {query ? (
              <button aria-label="Clear" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            ) : null}
          </div>
          <button
            className="btn btn-secondary"
            onClick={async () => {
              await bridge.clipCapture()
              await load()
            }}
            title="Copy the current clipboard into the history now"
          >
            <RefreshCw size={15} /> Grab now
          </button>
          <button
            className="btn btn-secondary"
            onClick={async () => {
              await bridge.clipsClear()
              await load()
            }}
            disabled={!clips || clips.length === pinnedCount}
          >
            <Trash2 size={15} /> Clear
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        {visible.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={24} />}
            title={clips && clips.length === 0 ? 'Nothing copied yet' : 'No matches'}
            desc={
              clips && clips.length === 0
                ? 'Copy something anywhere in Windows and it shows up here within a second.'
                : 'Try a different search term.'
            }
          />
        ) : (
          <div className="row-list">
            {visible.map((c) => (
              <div key={c.id} className={`clip-row${c.pinned ? ' pinned' : ''}`}>
                <div className="clip-main" onClick={() => void copy(c)} role="button" tabIndex={0}>
                  <div className="clip-text selectable">{preview(c.text, 240)}</div>
                  <div className="clip-meta">
                    {ago(c.createdMs)} · {c.text.length} chars
                  </div>
                </div>
                <div className="clip-actions">
                  <button
                    className="btn btn-ghost"
                    aria-label={c.pinned ? 'Unpin' : 'Pin'}
                    onClick={async () => {
                      await bridge.clipPin(c.id)
                      await load()
                    }}
                  >
                    {c.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                  </button>
                  <button className="btn btn-ghost" aria-label="Copy" onClick={() => void copy(c)}>
                    {copied === c.id ? <ClipboardList size={15} /> : <Copy size={15} />}
                  </button>
                  <button
                    className="btn btn-ghost"
                    aria-label="Delete"
                    onClick={async () => {
                      await bridge.clipDelete(c.id)
                      await load()
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}