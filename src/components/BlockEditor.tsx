import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  Copy,
  GripVertical,
  Link2,
  ListChecks,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import type { Block, BlockKind, Page, Task } from '../../shared/types'
import {
  BLOCK_HELP,
  EMPTY_TABLE,
  backspaceOnEmpty,
  deleteBlocks,
  duplicateBlocks,
  ensureBlocks,
  filterSlashItems,
  indentBlocks,
  joinTableRows,
  makeBlock,
  markdownShortcut,
  moveBlocks,
  newBlockId,
  parseTableRows,
  setBlockKind,
  slashQuery,
  splitBlock,
  toggleChecked,
  BlockHistory,
  type SlashItem,
} from '../workspace/blocks'

/**
 * The block editor.
 *
 * One `textarea` per block rather than one big contenteditable: a textarea
 * gives real IME and spellcheck behaviour on Windows for free, keeps undo
 * inside the browser's own model for the caret, and means a bug here can at
 * worst lose a paragraph rather than corrupt the whole document.
 *
 * Autosave is debounced and lives in the parent (PagesPage), which owns the
 * page record; the editor only reports changes.
 */

export interface BlockEditorProps {
  blocks: Block[]
  onChange: (blocks: Block[]) => void
  /** Pages available to link to, for `page` blocks. */
  pages: Page[]
  /** Tasks available to link to, for `task` blocks. */
  tasks: Task[]
  /** Called when a task block's checkbox is toggled. */
  onToggleTask?: (taskId: string) => void
  /** Editor is read-only (no editing affordances rendered). */
  readOnly?: boolean
}

export default function BlockEditor({
  blocks,
  onChange,
  pages,
  tasks,
  onToggleTask,
  readOnly,
}: BlockEditorProps) {
  const list = useMemo(() => ensureBlocks(blocks), [blocks])
  const inputs = useRef(new Map<string, HTMLTextAreaElement>())
  const history = useRef(new BlockHistory())
  /** Focus request: the block to focus and where in its text. */
  const pending = useRef<{ id: string; caret?: number } | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  /**
   * Bumped whenever the history stack changes. The history itself lives in a
   * ref so it survives re-renders, but the undo/redo buttons have to re-render
   * to pick up their new enabled state — a ref change alone draws nothing.
   */
  const [historyRev, setHistoryRev] = useState(0)
  /**
   * True once the user has pressed Escape (or Tabbed past the nesting limit):
   * the block stops claiming editing keys so Tab can move on to the rest of
   * the page. Any keystroke that changes the text re-arms it.
   */
  const [detached, setDetached] = useState(false)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [slash, setSlash] = useState<{ index: number; query: string } | null>(null)
  const [slashCursor, setSlashCursor] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [linkPick, setLinkPick] = useState<{ index: number; kind: 'page' | 'task' } | null>(null)

  const focusBlock = useCallback((id: string, caret?: number) => {
    pending.current = { id, caret }
    // A block that does not exist yet (newly inserted) only exists after the
    // next paint, so the request is retried on the next frame.
    requestAnimationFrame(() => {
      const el = inputs.current.get(id)
      if (!el) {
        requestAnimationFrame(() => {
          const retry = inputs.current.get(id)
          if (!retry) return
          retry.focus()
          const pos = pending.current?.caret ?? retry.value.length
          retry.setSelectionRange(pos, pos)
        })
        return
      }
      el.focus()
      const pos = pending.current?.caret ?? el.value.length
      el.setSelectionRange(pos, pos)
    })
  }, [])

  useEffect(() => {
    if (!slash) return
    const q = slash.query
    if (filterSlashItems(q).length === 0) setSlashCursor(0)
    else setSlashCursor((c) => Math.min(c, filterSlashItems(q).length - 1))
  }, [slash])

  const commit = useCallback(
    (next: Block[], focus?: { id: string; caret?: number }) => {
      if (focus) focusBlock(focus.id, focus.caret)
      setHistoryRev((r) => r + 1)
      onChange(next)
    },
    [onChange, focusBlock],
  )

  const setText = useCallback(
    (index: number, text: string) => {
      // Recorded as typing so a run of keystrokes becomes one undo step.
      history.current.pushTyping(list)
      const next = list.slice()
      next[index] = { ...next[index], text }
      setHistoryRev((r) => r + 1)
      onChange(next)
    },
    [list, onChange],
  )

  const applySlash = useCallback(
    (index: number, item: SlashItem) => {
      const next = list.slice()
      const block: Block = { ...makeBlock(item.kind, '', ''), id: next[index]?.id ?? newBlockId() }
      if (item.kind === 'callout') block.extra = 'note'
      if (item.kind === 'table') block.extra = joinTableRows(EMPTY_TABLE)
      next[index] = block
      history.current.push(list)
      setSlash(null)
      commit(next, { id: block.id })
    },
    [list, commit],
  )

  const onKeyDown = useCallback(
    (index: number, block: Block, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const mod = e.ctrlKey || e.metaKey
      // While detached, the block behaves like a plain field: browser Tab
      // navigation works again, and re-entering it re-arms the editor keys.
      if (detached && !mod && !e.altKey && ['Tab', 'Enter', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        return
      }
      const items = filterSlashItems(slash?.query ?? '')

      // The slash menu owns the keyboard while it is open.
      if (slash && slash.index === index) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashCursor((c) => (items.length ? (c + 1) % items.length : 0))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashCursor((c) => (items.length ? (c - 1 + items.length) % items.length : 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const item = items[slashCursor]
          if (item) applySlash(index, item)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setSlash(null)
          return
        }
      }

      // Undo / redo. Only claimed when the stack actually has something, so the
      // browser's own text undo keeps working inside a block otherwise — and
      // because this is bound to the textarea rather than the window, Ctrl+Z
      // anywhere else in the app is never intercepted.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && history.current.canUndo) {
        e.preventDefault()
        const restored = history.current.undo(list)
        if (restored) {
          setSelection([])
          const first = restored[Math.min(index, restored.length - 1)]
          commit(restored, first ? { id: first.id } : undefined)
        }
        return
      }
      if (
        mod &&
        (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')) &&
        history.current.canRedo
      ) {
        e.preventDefault()
        const redone = history.current.redo(list)
        if (redone) {
          const first = redone[Math.min(index, redone.length - 1)]
          commit(redone, first ? { id: first.id } : undefined)
        }
        return
      }

      if (mod && e.key.toLowerCase() === 'a' && selection.length > 0) {
        // Select-all inside the document means "every block", but only once a
        // block is already selected; otherwise the text selection is expected.
        e.preventDefault()
        setSelection(list.map((_, i) => i))
        setAnchor(list.length - 1)
        return
      }

      if (e.key === 'Enter' && !e.shiftKey && !mod) {
        e.preventDefault()
        // A markdown shortcut fires on space, so by the time Enter arrives the
        // marker text has already been consumed.
        const { next, replaceText } = splitBlock(block)
        const nextList = list.slice()
        if (replaceText !== null) {
          const cleared = { ...block, text: replaceText }
          if (cleared.kind === 'todo') cleared.checked = false
          nextList[index] = cleared
          history.current.push(list)
          commit(nextList, { id: next.id })
          return
        }
        nextList.splice(index + 1, 0, next)
        history.current.push(list)
        setSelection([])
        commit(nextList, { id: next.id })
        return
      }

      if (e.key === 'Backspace' && block.text === '' && !slash) {
        const result = backspaceOnEmpty(list, index)
        if (result) {
          e.preventDefault()
          history.current.push(list)
          setSelection([])
          const target = result.blocks[result.focus]
          commit(result.blocks, target ? { id: target.id } : undefined)
        }
        return
      }

      if (e.key === 'Tab') {
        const targets = selection.includes(index) && selection.length > 1 ? selection : [index]
        const next = indentBlocks(list, targets, e.shiftKey ? -1 : 1)
        if (next === list) {
          // Already at the nesting limit (or already at the top level going
          // out): let the browser move focus. Capturing Tab unconditionally
          // would trap a keyboard user inside the editor forever.
          setDetached(true)
          e.currentTarget.blur()
          return
        }
        e.preventDefault()
        history.current.push(list)
        setHistoryRev((r) => r + 1)
        onChange(next)
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setSelection([])
        setAnchor(null)
        // Escape lifts the block's keyboard shortcuts so Tab can reach the
        // rest of the page; typing or re-entering the editor puts them back.
        setDetached(true)
        e.currentTarget.blur()
        return
      }

      if (e.key === 'ArrowUp' && e.shiftKey) {
        e.preventDefault()
        extendSelectionRef.current(anchor ?? index, index - 1)
        return
      }
      if (e.key === 'ArrowDown' && e.shiftKey) {
        e.preventDefault()
        extendSelectionRef.current(anchor ?? index, index + 1)
        return
      }
      if (e.key === 'ArrowUp') {
        const prev = list[index - 1]
        if (prev) {
          e.preventDefault()
          focusBlock(prev.id)
          setSelection([])
        }
        return
      }
      if (e.key === 'ArrowDown') {
        const nxt = list[index + 1]
        if (nxt) {
          e.preventDefault()
          focusBlock(nxt.id, 0)
          setSelection([])
        }
      }
    },
    [list, selection, anchor, slash, slashCursor, commit, focusBlock, applySlash, detached],
  )

  /**
   * Shift-arrow selection. Held in a ref because the keydown handler is a
   * `useCallback` and a plain function declared in the body would be a new
   * identity on every render, forcing it to be rebuilt on each keystroke.
   */
  const extendSelectionRef = useRef((from: number, to: number) => {
    const lo = Math.max(0, Math.min(from, to))
    const hi = Math.min(list.length - 1, Math.max(from, to))
    const picked: number[] = []
    for (let i = lo; i <= hi; i += 1) picked.push(i)
    setSelection(picked)
    setAnchor(from)
  })
  extendSelectionRef.current = (from: number, to: number) => {
    const lo = Math.max(0, Math.min(from, to))
    const hi = Math.min(list.length - 1, Math.max(from, to))
    const picked: number[] = []
    for (let i = lo; i <= hi; i += 1) picked.push(i)
    setSelection(picked)
    setAnchor(from)
  }

  const onInput = useCallback(
    (index: number, block: Block, value: string, caret: number) => {
      setDetached(false)
      // Markdown shortcut: the marker is consumed the moment the space lands.
      const shortcut = markdownShortcut(value.slice(0, caret))
      if (shortcut) {
        const next = list.slice()
        const updated = setBlockKind(block, shortcut.kind)
        updated.text = value.slice(caret).replace(/^\s/, '')
        next[index] = updated
        history.current.pushTyping(list)
        setSlash(null)
        commit(next, { id: updated.id, caret: updated.text.length })
        return
      }
      setText(index, value)
      // The menu opens on `/` and closes as soon as the query stops matching
      // the pattern (a space, or any other character before it).
      const q = slashQuery(value, caret)
      setSlash(q === null ? null : { index, query: q })
    },
    [list, commit, setText],
  )

  // ---- selection actions ------------------------------------------------

  const targets = selection.length ? selection : []
  const runOnSelection = useCallback(
    (fn: (blocks: Block[], indexes: number[]) => Block[] | { blocks: Block[]; focus: number }, focusIndex?: number) => {
      if (targets.length === 0) return
      const result = fn(list, targets)
      const next = Array.isArray(result) ? result : result.blocks
      history.current.push(list)
      setSelection([])
      const at = Array.isArray(result) ? focusIndex ?? targets[0] : result.focus
      const target = next[Math.min(at, next.length - 1)]
      commit(next, target ? { id: target.id } : undefined)
    },
    [list, targets, commit],
  )

  const autoGrow = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  const addBlock = useCallback(() => {
    const block = makeBlock('paragraph')
    const next = [...list, block]
    history.current.push(list)
    setSelection([])
    commit(next, { id: block.id })
  }, [list, commit])

  // Reading `historyRev` here is what makes the two buttons re-render (and so
  // pick up their new enabled state) when the stack changes; the ref alone
  // would never cause a paint.
  const canUndo = history.current.canUndo && historyRev >= 0
  const canRedo = history.current.canRedo && historyRev >= 0

  const slashItems = slash ? filterSlashItems(slash.query) : []
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  return (
    <div
      className="editor"
      onMouseDown={(e) => {
        // A click on the editor's padding clears a multi-block selection.
        if (e.target === e.currentTarget) setSelection([])
      }}
    >
      {!readOnly && selection.length > 1 ? (
        <div className="block-selbar" role="toolbar" aria-label="Block actions">
          <span className="block-selcount">{selection.length} blocks</span>
          <button
            className="btn btn-ghost"
            onClick={() => runOnSelection((b, i) => moveBlocks(b, i, -1), Math.max(0, selection[0] - 1))}
            title="Move up"
          >
            <ChevronRight size={14} className="flip" />
          </button>
          <button className="btn btn-ghost" onClick={() => runOnSelection((b, i) => moveBlocks(b, i, 1), Math.min(selection[0] + 1, list.length - 1))} title="Move down">
            <ChevronRight size={14} />
          </button>
          <button className="btn btn-ghost" onClick={() => runOnSelection((b, i) => indentBlocks(b, i, 1))} title="Indent">
            <ChevronRight size={14} />
          </button>
          <button className="btn btn-ghost" onClick={() => runOnSelection((b, i) => indentBlocks(b, i, -1))} title="Outdent">
            <ChevronRight size={14} className="flip" />
          </button>
          <button className="btn btn-ghost" onClick={() => runOnSelection(duplicateBlocks)} title="Duplicate">
            <Copy size={14} />
          </button>
          <button className="btn btn-ghost" onClick={() => runOnSelection(deleteBlocks)} title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}

      {list.map((block, index) => {
        const depth = Math.min(6, (/^\t*/.exec(block.text)?.[0].length ?? 0))
        const selected = selection.includes(index)
        const linked = linkPick?.index === index ? linkPick : null
        return (
          <div
            key={block.id}
            className={`block block-${block.kind}${selected ? ' selected' : ''}`}
            style={{ ['--depth' as string]: depth }}
            data-index={index}
            draggable={!readOnly}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => {
              if (dragIndex === null) return
              e.preventDefault()
            }}
            onDragEnd={() => setDragIndex(null)}
            onDrop={(e) => {
              if (dragIndex === null || dragIndex === index) return
              e.preventDefault()
              const next = moveBlocks(list, [dragIndex], index - dragIndex)
              history.current.push(list)
              setDragIndex(null)
              const target = next[Math.min(index, next.length - 1)]
              commit(next, target ? { id: target.id } : undefined)
            }}
            onMouseDown={(e) => {
              // Shift-click extends the selection across blocks.
              if (e.shiftKey && anchor !== null) {
                e.preventDefault()
                extendSelectionRef.current(anchor, index)
              } else {
                setAnchor(index)
                if (!e.shiftKey) setSelection([])
              }
            }}
          >
            {!readOnly ? (
              <button
                className="block-grip"
                aria-label={`Reorder block ${index + 1}`}
                title="Drag to reorder · click for options"
                onClick={() => {
                  setSelection([index])
                  setAnchor(index)
                }}
              >
                <GripVertical size={14} />
              </button>
            ) : null}

            <div className="block-body">
              {block.kind === 'divider' ? (
                <hr className="block-divider" />
              ) : block.kind === 'image' ? (
                <div className="block-image">
                  {block.extra ? (
                    <img src={block.extra} alt={block.text || ''} onError={() => undefined} />
                  ) : (
                    <span className="block-image-empty">Paste an image URL above</span>
                  )}
                  {block.text ? <span className="block-caption">{block.text}</span> : null}
                </div>
              ) : block.kind === 'table' ? (
                <TableBlock
                  rows={parseTableRows(block.extra)}
                  readOnly={readOnly}
                  onChange={(rows) => {
                    const next = list.slice()
                    next[index] = { ...block, extra: joinTableRows(rows) }
                    history.current.push(list)
                    onChange(next)
                  }}
                />
              ) : block.kind === 'task' ? (
                <TaskReference
                  task={taskById.get(block.meta)}
                  page={pageById.get(block.meta)}
                  onToggle={() => onToggleTask?.(block.meta)}
                  onClear={() => setText(index, '')}
                  onPick={() => setLinkPick({ index, kind: 'task' })}
                />
              ) : block.kind === 'page' ? (
                <PageReference
                  page={pageById.get(block.meta)}
                  onClear={() => setText(index, '')}
                  onPick={() => setLinkPick({ index, kind: 'page' })}
                />
              ) : (
                <>
                  {block.kind === 'todo' ? (
                    <button
                      className={`block-check${block.checked ? ' checked' : ''}`}
                      aria-label={block.checked ? 'Mark as not done' : 'Mark as done'}
                      onClick={() => {
                        const next = toggleChecked(list, [index])
                        history.current.push(list)
                        onChange(next)
                      }}
                    >
                      {block.checked ? <Check size={12} /> : null}
                    </button>
                  ) : null}
                  <textarea
                    ref={(el) => {
                      if (el) {
                        inputs.current.set(block.id, el)
                        autoGrow(el)
                      } else {
                        inputs.current.delete(block.id)
                      }
                    }}
                    className="block-text selectable"
                    value={block.text}
                    rows={1}
                    placeholder={placeholderFor(block.kind)}
                    spellCheck={block.kind !== 'code'}
                    readOnly={readOnly}
                    onChange={(e) => onInput(index, block, e.target.value, e.target.selectionStart ?? e.target.value.length)}
                    onKeyDown={(e) => onKeyDown(index, block, e)}
                    onFocus={() => {
                      // Focus coming back into the editor re-arms its keys.
                      setDetached(false)
                      if (!selection.length) setAnchor(index)
                    }}
                    aria-label={`Block ${index + 1}, ${BLOCK_HELP[block.kind]}`}
                  />
                </>
              )}

              {block.kind === 'code' && !readOnly ? (
                <input
                  className="block-extra"
                  value={block.extra}
                  placeholder="Language (optional)"
                  onChange={(e) => {
                    const next = list.slice()
                    next[index] = { ...block, extra: e.target.value }
                    onChange(next)
                  }}
                />
              ) : null}

              {slash && slash.index === index ? (
                <SlashMenu items={slashItems} cursor={slashCursor}onPick={(item) => applySlash(index, item)}
        />
              ) : null}

              {linked ? (
                <ReferencePicker
                  kind={linked.kind}
                  pages={pages}
                  tasks={tasks}
                  onPick={(id) => {
                    const next = list.slice()
                    next[index] = { ...block, meta: id }
                    history.current.push(list)
                    setLinkPick(null)
                    onChange(next)
                  }}
                  onClose={() => setLinkPick(null)}
                />
              ) : null}
            </div>
          </div>
        )
      })}

      {!readOnly ? (
        <div className="editor-foot">
          <button className="btn btn-ghost" onClick={addBlock} title="Add a block">
            <Plus size={14} /> Add block
          </button>
          <span className="editor-hint">
            <kbd>/</kbd> commands · <kbd>Tab</kbd> nest · <kbd>Enter</kbd> new block ·{' '}
            <kbd>Shift</kbd>+<kbd>↑↓</kbd> select
          </span>
          <span className="grow" />
          {/* `canUndo`/`canRedo` are read from `historyRev` so these re-render when
              the stack changes; the ref itself would never trigger that. */}
          <button
            className="btn btn-ghost"
            disabled={!canUndo}
            onClick={() => {
              const restored = history.current.undo(list)
              if (restored) commit(restored, { id: restored[0]?.id })
            }}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 size={14} />
          </button>
          <button
            className="btn btn-ghost"
            disabled={!canRedo}
            onClick={() => {
              const redone = history.current.redo(list)
              if (redone) commit(redone, { id: redone[0]?.id })
            }}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            <Redo2 size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** One slash-menu row set. Portal-free: it lives inside the block it belongs to. */
function SlashMenu({
  items,
  cursor,
  onPick,
}: {
  items: SlashItem[]
  cursor: number
  onPick: (item: SlashItem) => void
}) {
  if (items.length === 0) {
    return <div className="slash-menu empty">No matching block type</div>
  }
  return (
    <div className="slash-menu" role="listbox" aria-label="Insert block">
      {items.map((item, i) => (
        <button
          key={item.kind}
          role="option"
          aria-selected={i === cursor}
          className={`slash-item${i === cursor ? ' active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(item)
          }}
          onMouseEnter={() => undefined}
        >
          <span className="slash-label">{item.label}</span>
          <span className="slash-hint">{item.hint}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * A simple editable table.
 *
 * Rows are stored in the block's `extra` as newline-separated, tab-separated
 * cells — the same flat format the backend uses — so there is exactly one
 * representation on both sides. Tab and newline are Tab's own move keys, which
 * is why the arrow keys stand in for them.
 */
function TableBlock({
  rows,
  onChange,
  readOnly,
}: {
  rows: string[][]
  onChange: (rows: string[][]) => void
  readOnly?: boolean
}) {
  const grid = rows.length > 0 ? rows : EMPTY_TABLE
  const width = Math.max(...grid.map((r) => r.length), 2)

  const setCell = (r: number, c: number, value: string) => {
    const next = grid.map((row) => row.slice())
    while (next.length <= r) next.push([])
    while (next[r].length < width) next[r].push('')
    next[r][c] = value
    onChange(next)
  }

  const addRow = () => onChange([...grid, new Array(width).fill('')])

  const removeRow = (r: number) => {
    if (grid.length <= 1) return
    onChange(grid.filter((_, i) => i !== r))
  }

  const addColumn = () => onChange(grid.map((row) => [...row, '']))

  const removeColumn = (c: number) => {
    if (width <= 1) return
    onChange(grid.map((row) => row.filter((_, i) => i !== c)))
  }

  return (
    <div className="block-table">
      <table>
        <tbody>
          {grid.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: width }, (_, c) => (
                <td key={c}>
                  <input
                    className="block-cell selectable"
                    value={row[c] ?? ''}
                    readOnly={readOnly}
                    aria-label={`Row ${r + 1}, column ${c + 1}`}
                    onChange={(e) => setCell(r, c, e.target.value)}
                    onKeyDown={(e) => {
                      if (readOnly) return
                      // Tab moves right, wrapping onto the next row, which is
                      // what a grid is expected to do without a mouse.
                      if (e.key === 'Tab' && !e.shiftKey) {
                        e.preventDefault()
                        if (c + 1 < width) {
                          setCell(r, c + 1, row[c] ?? '')
                        } else if (r + 1 < grid.length) {
                          setCell(r + 1, 0, grid[r + 1][0] ?? '')
                        } else {
                          addRow()
                          setCell(grid.length, 0, '')
                        }
                      } else if (e.key === 'Tab' && e.shiftKey) {
                        e.preventDefault()
                        if (c > 0) setCell(r, c - 1, row[c] ?? '')
                        else if (r > 0) {
                          const prev = grid[r - 1]
                          setCell(r - 1, width - 1, prev[width - 1] ?? '')
                        }
                      }
                    }}
                  />
                </td>
              ))}
              {!readOnly && grid.length > 1 ? (
                <td className="block-table-tools">
                  <button aria-label={`Delete row ${r + 1}`} onClick={() => removeRow(r)}>
                    <X size={12} />
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly ? (
        <div className="block-table-actions">
          <button className="btn btn-ghost" onClick={addRow}>
            <Plus size={12} /> Row
          </button>
          <button className="btn btn-ghost" onClick={addColumn}>
            <Plus size={12} /> Column
          </button>
          {width > 1 ? (
            <button className="btn btn-ghost" onClick={() => removeColumn(width - 1)}>
              <X size={12} /> Last column
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A `task` block: a live task, or an empty one to be linked. */
function TaskReference({
  task,
  page,
  onToggle,
  onClear,
  onPick,
}: {
  task: Task | undefined
  page: Page | undefined
  onToggle: () => void
  onClear: () => void
  onPick: () => void
}) {
  if (page && !task) {
    return (
      <div className="block-ref">
        <Link2 size={14} />
        <span className="block-ref-title">Linked page: {page.title || 'Untitled'}</span>
        <button className="btn btn-ghost" onClick={onClear} aria-label="Unlink">
          ×
        </button>
      </div>
    )
  }
  if (!task) {
    return (
      <button className="block-ref empty" onClick={onPick}>
        <ListChecks size={14} /> Link a task from this page
      </button>
    )
  }
  return (
    <div className="block-ref">
      <button
        className={`block-check${task.status === 'done' ? ' checked' : ''}`}
        onClick={onToggle}
        aria-label={task.status === 'done' ? 'Reopen task' : 'Complete task'}
      >
        {task.status === 'done' ? <Check size={12} /> : null}
      </button>
      <span className={`block-ref-title${task.status === 'done' ? ' done' : ''}`}>{task.title}</span>
      <span className="block-ref-tag">{task.status}</span>
      <button className="btn btn-ghost" onClick={onClear} aria-label="Unlink task">
        ×
      </button>
    </div>
  )
}

/** A `page` block: a link to another page, which is what backlinks read. */
function PageReference({
  page,
  onClear,
  onPick,
}: {
  page: Page | undefined
  onClear: () => void
  onPick: () => void
}) {
  if (!page) {
    return (
      <button className="block-ref empty" onClick={onPick}>
        <Link2 size={14} /> Link another page
      </button>
    )
  }
  return (
    <div className="block-ref">
      <Link2 size={14} />
      <span className="block-ref-title">{page.icon || ''} {page.title || 'Untitled'}</span>
      <button className="btn btn-ghost" onClick={onClear} aria-label="Unlink page">
        ×
      </button>
    </div>
  )
}

/** Search-and-pick list shown under a reference block. */
function ReferencePicker({
  kind,
  pages,
  tasks,
  onPick,
  onClose,
}: {
  kind: 'page' | 'task'
  pages: Page[]
  tasks: Task[]
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const options = (
    kind === 'page'
      ? pages.map((p) => ({ id: p.id, label: p.title || 'Untitled', sub: 'Page' }))
      : tasks.map((t) => ({ id: t.id, label: t.title, sub: t.status }))
  )
    .filter((o) => !q || o.label.toLowerCase().includes(q))
    .slice(0, 30)

  return (
    <div className="ref-picker">
      <input
        autoFocus
        className="tool-input"
        value={query}
        placeholder={kind === 'page' ? 'Find a page…' : 'Find a task…'}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (options[0]) onPick(options[0].id)
          }
        }}
      />
      <div className="ref-options">
        {options.length === 0 ? (
          <div className="ref-empty">Nothing to link yet.</div>
        ) : (
          options.map((o) => (
            <button
              key={o.id}
              className="ref-option"
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(o.id)
              }}
            >
              <span className="ref-option-label">{o.label}</span>
              <span className="ref-option-sub">{o.sub}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function placeholderFor(kind: BlockKind): string {
  switch (kind) {
    case 'heading1':
      return 'Heading 1'
    case 'heading2':
      return 'Heading 2'
    case 'heading3':
      return 'Heading 3'
    case 'todo':
      return 'To-do'
    case 'code':
      return 'Code'
    case 'quote':
      return 'Quote'
    case 'callout':
      return 'Callout'
    case 'image':
      return 'https://example.com/image.png'
    case 'table':
      return 'Column 1\tColumn 2'
    default:
      return "Write, or '/' for commands"
  }
}

/** Short human description per kind, used for the block's accessible name. */
export { BLOCK_HELP } from '../workspace/blocks'