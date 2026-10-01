import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, FileText, ListChecks, Plus, X } from 'lucide-react'
import { bridge } from '../bridge'

/**
 * Ctrl+Shift+Space — capture without leaving whatever you were doing.
 *
 * One input, routed by the first character:
 *   `buy milk #shopping`  → page
 *   `!call the dentist`   → task
 *   `>raw capture`        → page, explicit
 * Tags are any `#word` tokens; everything else becomes the title.
 */
export default function QuickCapture({
  open,
  onClose,
  onCaptured,
}: {
  open: boolean
  onClose: () => void
  onCaptured: (kind: 'page' | 'task', id: string, title: string) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setText('')
      setError(null)
      setSaving(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  if (!open) return null

  const route = text.trim().startsWith('!') ? 'task' : 'page'

  const submit = async () => {
    const value = text.trim()
    if (!value || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await bridge.quickCapture(value)
      onCaptured(res.kind, res.id, res.title)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.')
      setSaving(false)
    }
  }

  return createPortal(
    <div className="palette-overlay capture" onMouseDown={onClose} role="presentation">
      <div
        className="capture-box"
        role="dialog"
        aria-modal="true"
        aria-label="Quick capture"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="capture-head">
          <span className="capture-route">
            {route === 'task' ? <ListChecks size={14} /> : <FileText size={14} />}
            {route === 'task' ? 'Task' : 'Page'}
          </span>
          <span className="capture-hint">
            <kbd>!</kbd> task · <kbd>&gt;</kbd> page · <kbd>#tag</kbd> tags
          </span>
          <button className="btn btn-ghost" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <textarea
          ref={inputRef}
          className="capture-input"
          value={text}
          placeholder="What's on your mind?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          spellCheck
        />
        <div className="capture-foot">
          <span className={error ? 'capture-error' : 'capture-count'}>
            {error ?? `${text.trim().length} characters`}
          </span>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving || !text.trim()}>
            <Plus size={15} /> Save <CornerDownLeft size={13} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}