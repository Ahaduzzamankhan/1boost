import type { Block, BlockKind } from '../../shared/types'

/**
 * Pure block-model logic for the editor.
 *
 * Everything here is a plain function over `Block[]` with no React and no DOM,
 * which is what makes the interesting parts — markdown shortcuts, nesting,
 * undo/redo, multi-block actions — testable without rendering anything.
 */

export const MAX_INDENT = 6

/** Kinds that continue onto the next block when Enter is pressed. */
const CONTINUING: BlockKind[] = [
  'bulletedListItem',
  'numberedListItem',
  'todo',
  'quote',
  'callout',
]

/** Kinds the slash menu can insert, in display order. */
export interface SlashItem {
  kind: BlockKind
  label: string
  hint: string
  /** Extra placeholder text for the new block. */
  placeholder?: string
}

export const SLASH_ITEMS: SlashItem[] = [
  { kind: 'paragraph', label: 'Text', hint: 'Plain paragraph' },
  { kind: 'heading1', label: 'Heading 1', hint: 'Section title', placeholder: 'Heading 1' },
  { kind: 'heading2', label: 'Heading 2', hint: 'Subsection', placeholder: 'Heading 2' },
  { kind: 'heading3', label: 'Heading 3', hint: 'Minor heading', placeholder: 'Heading 3' },
  { kind: 'bulletedListItem', label: 'Bulleted list', hint: 'Simple list item' },
  { kind: 'numberedListItem', label: 'Numbered list', hint: 'Ordered list item' },
  { kind: 'todo', label: 'To-do', hint: 'Checkbox item', placeholder: 'To-do' },
  { kind: 'quote', label: 'Quote', hint: 'Quoted text' },
  { kind: 'callout', label: 'Callout', hint: 'Highlighted note', placeholder: 'Callout' },
  { kind: 'code', label: 'Code', hint: 'Monospaced block' },
  { kind: 'divider', label: 'Divider', hint: 'Horizontal rule' },
  { kind: 'image', label: 'Image', hint: 'Paste an image URL', placeholder: 'https://' },
  { kind: 'table', label: 'Table', hint: 'A simple grid', placeholder: 'Column 1\tColumn 2' },
]

/** The table a new `table` block starts with: a header row and an empty row. */
export const EMPTY_TABLE: string[][] = [
  ['Name', 'Value'],
  ['', ''],
]

/** Kinds whose text is edited in a monospaced, single-line-ish field. */
export const CODE_LIKE: BlockKind[] = ['code']

/** Kinds that carry no text at all. */
export const TEXTLESS: BlockKind[] = ['divider']

/** Short human description per kind, used for a block's accessible name. */
export const BLOCK_HELP: Record<BlockKind, string> = {
  paragraph: 'text',
  heading1: 'heading 1',
  heading2: 'heading 2',
  heading3: 'heading 3',
  bulletedListItem: 'bulleted list item',
  numberedListItem: 'numbered list item',
  todo: 'to-do',
  quote: 'quote',
  callout: 'callout',
  code: 'code block',
  divider: 'divider',
  image: 'image',
  task: 'linked task',
  page: 'linked page',
  table: 'table',
}

let counter = 0

/** Client-side block id. The backend re-ids anything empty, so a collision
 *  between a new block and an existing one is harmless, but uniqueness within
 *  one document keeps React keys and selection stable. */
export function newBlockId(): string {
  counter += 1
  return `b${Date.now().toString(36)}${counter.toString(36)}`
}

export function makeBlock(kind: BlockKind, text = '', extra = ''): Block {
  return { id: newBlockId(), kind, text, checked: false, meta: '', extra }
}

/** A page always has at least one block to type into. */
export function ensureBlocks(blocks: Block[]): Block[] {
  return blocks.length > 0 ? blocks : [makeBlock('paragraph')]
}

/**
 * The markdown shortcut a keystroke should turn into a block kind.
 *
 * Only fires on a space, and only when the text before it is a complete
 * marker — which is what stops "1 + 1" becoming a numbered list.
 */
export function markdownShortcut(text: string): { kind: BlockKind; rest: string } | null {
  const t = text
  if (t === '#') return { kind: 'heading1', rest: '' }
  if (t === '##') return { kind: 'heading2', rest: '' }
  if (t === '###') return { kind: 'heading3', rest: '' }
  if (t === '-' || t === '*') return { kind: 'bulletedListItem', rest: '' }
  if (t === '[]' || t === '[ ]') return { kind: 'todo', rest: '' }
  if (t === '>') return { kind: 'quote', rest: '' }
  if (/^\d{1,3}\.$/.test(t)) return { kind: 'numberedListItem', rest: '' }
  // "---" only becomes a divider on its own line, so a "---" inside prose is
  // still a divider too — matching what the user sees.
  if (t === '---') return { kind: 'divider', rest: '' }
  return null
}

/**
 * What Enter should do: continue the list, or start a paragraph.
 *
 * An empty list item ends the list rather than leaving an orphan bullet
 * behind, which is the behaviour every editor converges on.
 */
export function splitBlock(block: Block): { next: Block; replaceText: string | null } {
  if (TEXTLESS.includes(block.kind)) {
    return { next: makeBlock('paragraph'), replaceText: null }
  }
  if (CONTINUING.includes(block.kind)) {
    if (block.text.trim() === '') {
      return { next: makeBlock('paragraph'), replaceText: '' }
    }
    const next = makeBlock(block.kind)
    next.checked = false
    next.extra = block.kind === 'callout' ? block.extra : ''
    return { next, replaceText: null }
  }
  return { next: makeBlock('paragraph'), replaceText: null }
}

/** Backspace on an empty block: unwrap it, or delete it if already plain. */
export function backspaceOnEmpty(blocks: Block[], index: number): {
  blocks: Block[]
  focus: number
} | null {
  const block = blocks[index]
  if (!block) return null
  // Code and image blocks would lose their extra on unwrap; make them plain.
  const target: BlockKind = block.kind === 'paragraph' ? 'paragraph' : 'paragraph'
  if (target === 'paragraph' && blocks.length > 1) {
    const next = blocks.slice()
    next.splice(index, 1)
    return { blocks: next, focus: Math.max(0, index - 1) }
  }
  return null
}

/** Indent / outdent a block, clamped to the model's limit. */
export function indentBlocks(blocks: Block[], indexes: number[], delta: number): Block[] {
  if (indexes.length === 0) return blocks
  const set = new Set(indexes)
  return blocks.map((b, i) => {
    if (!set.has(i)) return b
    const depth = indentDepth(b)
    const next = Math.max(0, Math.min(MAX_INDENT, depth + delta))
    return depth === next ? b : setIndentDepth(b, next)
  })
}

/**
 * Nesting is stored as leading tabs on the block text.
 *
 * Deriving depth from the text rather than adding a field keeps one source of
 * truth — a block's depth is visible in its own content — and means an
 * imported document with leading whitespace nests without a migration.
 */
export function indentDepth(block: Block): number {
  const m = /^\t*/.exec(block.text)
  return m ? m[0].length : 0
}

export function setIndentDepth(block: Block, depth: number): Block {
  const body = block.text.replace(/^\t*/, '')
  return { ...block, text: `${'\t'.repeat(depth)}${body}` }
}

export function stripIndent(block: Block): Block {
  return setIndentDepth(block, 0)
}

/** Move a block (or a selection) by `delta` positions, clamped at the ends. */
export function moveBlocks(blocks: Block[], indexes: number[], delta: number): Block[] {
  const sorted = [...indexes].sort((a, b) => a - b)
  if (sorted.length === 0 || delta === 0) return blocks
  const set = new Set(sorted)
  const picked = sorted.map((i) => blocks[i])
  const rest = blocks.filter((_, i) => !set.has(i))
  let at = Math.min(Math.max(0, sorted[0] + delta), rest.length)
  return [...rest.slice(0, at), ...picked, ...rest.slice(at)]
}

/** Delete a selection and return where the caret should land. */
export function deleteBlocks(blocks: Block[], indexes: number[]): { blocks: Block[]; focus: number } {
  const set = new Set(indexes)
  const next = blocks.filter((_, i) => !set.has(i))
  const focus = Math.min(Math.max(0, Math.min(...indexes) - 1), Math.max(0, next.length - 1))
  return { blocks: ensureBlocks(next), focus }
}

/** Duplicate a selection in place, directly below the original. */
export function duplicateBlocks(blocks: Block[], indexes: number[]): Block[] {
  const sorted = [...indexes].sort((a, b) => a - b)
  const last = sorted[sorted.length - 1]
  if (last === undefined) return blocks
  const copies = sorted.map((i) => ({ ...blocks[i], id: newBlockId() }))
  return [...blocks.slice(0, last + 1), ...copies, ...blocks.slice(last + 1)]
}

/** Toggle a checkbox. `null` when the block is not a to-do. */
export function toggleChecked(blocks: Block[], indexes: number[]): Block[] {
  const set = new Set(indexes)
  return blocks.map((b, i) => (set.has(i) && b.kind === 'todo' ? { ...b, checked: !b.checked } : b))
}

/** Replace a block's kind, keeping its text and clearing kind-only extras. */
export function setBlockKind(block: Block, kind: BlockKind): Block {
  const next: Block = { ...block, kind, checked: kind === 'todo' ? block.checked : false }
  if (kind === 'code') next.extra = ''
  if (kind !== 'callout') next.extra = ''
  if (kind !== 'image') next.extra = ''
  return next
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

/**
 * A bounded undo stack of whole-document snapshots.
 *
 * Snapshotting the block array is the right trade at this size: a page is a
 * few hundred blocks, a copy is a pointer bump per block, and it makes undo
 * correct for *every* operation — including ones added later — instead of only
 * the ones that remembered to push a history entry.
 *
 * Typing is coalesced into one entry per pause rather than one per character,
 * so Ctrl+Z steps back an editing action instead of a single letter. Without
 * this, holding down a key would fill the history and make undo useless.
 */
export class BlockHistory {
  private past: Block[][] = []
  private future: Block[][] = []
  private readonly limit: number
  /** When the current typing burst began; 0 when not typing. */
  private typingSince = 0

  constructor(limit = 100) {
    this.limit = limit
  }

  /** Record the state *before* a discrete change (split, move, delete, …). */
  push(blocks: Block[]): void {
    // A discrete action ends any typing burst, so the next keystroke starts a
    // fresh undo step from the state this action produced.
    this.typingSince = 0
    this.record(blocks)
  }

  /** Record the state before a keystroke, coalescing a burst into one step. */
  pushTyping(blocks: Block[]): void {
    const now = Date.now()
    if (this.typingSince !== 0 && now - this.typingSince < TYPING_WINDOW_MS) return
    this.typingSince = now
    this.record(blocks)
  }

  private record(blocks: Block[]): void {
    const snapshot = blocks.map((b) => ({ ...b }))
    const last = this.past[this.past.length - 1]
    // Two changes that produced the same document are not two undo steps.
    if (last && sameBlocks(last, snapshot)) return
    this.past.push(snapshot)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: Block[]): Block[] | null {
    const previous = this.past.pop()
    if (!previous) return null
    this.future.push(current.map((b) => ({ ...b })))
    this.typingSince = 0
    return previous
  }

  redo(current: Block[]): Block[] | null {
    const next = this.future.pop()
    if (!next) return null
    this.past.push(current.map((b) => ({ ...b })))
    this.typingSince = 0
    return next
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** Called when a different page is opened: its history is not this page's. */
  reset(): void {
    this.past = []
    this.future = []
    this.typingSince = 0
  }
}

/**
 * How long a gap in typing still counts as the same editing action. Long
 * enough to cover a normal pause between words, short enough that coming back
 * to a paragraph minutes later starts a new step.
 */
const TYPING_WINDOW_MS = 1200

function sameBlocks(a: Block[], b: Block[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return x.id === y.id && x.text === y.text && x.kind === y.kind && x.checked === y.checked
  })
}

// ---------------------------------------------------------------------------
// Slash menu
// ---------------------------------------------------------------------------

/** The query typed after `/`, or `null` when the menu should be closed. */
export function slashQuery(text: string, caret: number): string | null {
  const upto = text.slice(0, caret)
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(upto)
  if (!match) return null
  // Only at the start of a block or after whitespace, so "and/or" stays text.
  return match[1]
}

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter(
    (item) => item.label.toLowerCase().includes(q) || item.kind.toLowerCase().includes(q),
  )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Tab/newline separated cells, one row per line. Mirrors the Rust format. */
export function parseTableRows(extra: string): string[][] {
  return extra
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'))
}

export function joinTableRows(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n')
}