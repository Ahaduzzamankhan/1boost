// @ts-check
// The workspace redesign introduced three pure pieces of logic that carry real
// risk and no framework to catch mistakes: the block model's keyboard
// behaviour, the undo stack, and the custom-CSS sanitizer (whose safety claim
// is the only reason the feature is acceptable at all). These pin them.
import { describe, expect, it } from 'vitest'
import type { Block, Task } from '../shared/types'
import {
  BlockHistory,
  SLASH_ITEMS,
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
  parseTableRows,
  setBlockKind,
  slashQuery,
  splitBlock,
  toggleChecked,
} from '../src/workspace/blocks'
import {
  breadcrumbsOf,
  backlinksTo,
  childrenOf,
  dayKey,
  dueLabel,
  recentPages,
  startOfDay,
  subtasksOf,
  tasksOfPage,
} from '../src/workspace/helpers'
import { sanitizeCss } from '../src/customCss'

function b(kind: Block['kind'], text: string): Block {
  return makeBlock(kind, text)
}

function page(over: Partial<Parameters<typeof childrenOf>[0][number]> = {}) {
  return {
    id: 'p1',
    title: 'Page',
    icon: '',
    parentId: '',
    blocks: [],
    tags: [],
    favorite: false,
    archived: false,
    createdMs: 0,
    updatedMs: 0,
    ...over,
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Task',
    done: false,
    status: 'todo',
    priority: 0,
    dueMs: null,
    tags: [],
    projectId: '',
    pageId: '',
    parentId: '',
    blockedBy: [],
    recurrence: '',
    order: 0,
    createdMs: 0,
    updatedMs: 0,
    completedMs: null,
    ...over,
  }
}

describe('markdown shortcuts', () => {
  it('turns a marker plus space into a block kind', () => {
    expect(markdownShortcut('#')).toEqual({ kind: 'heading1', rest: '' })
    expect(markdownShortcut('##')).toEqual({ kind: 'heading2', rest: '' })
    expect(markdownShortcut('###')).toEqual({ kind: 'heading3', rest: '' })
    expect(markdownShortcut('-')).toEqual({ kind: 'bulletedListItem', rest: '' })
    expect(markdownShortcut('*')).toEqual({ kind: 'bulletedListItem', rest: '' })
    expect(markdownShortcut('[]')).toEqual({ kind: 'todo', rest: '' })
    expect(markdownShortcut('[ ]')).toEqual({ kind: 'todo', rest: '' })
    expect(markdownShortcut('>')).toEqual({ kind: 'quote', rest: '' })
    expect(markdownShortcut('1.')).toEqual({ kind: 'numberedListItem', rest: '' })
    expect(markdownShortcut('123.')).toEqual({ kind: 'numberedListItem', rest: '' })
    expect(markdownShortcut('---')).toEqual({ kind: 'divider', rest: '' })
  })

  it('leaves ordinary typing alone', () => {
    // The bug this guards: "1 + 1" becoming a numbered list, or a line
    // starting with a dash in prose turning into a bullet.
    expect(markdownShortcut('1 + 1')).toBeNull()
    expect(markdownShortcut('hello')).toBeNull()
    expect(markdownShortcut('1234.')).toBeNull()
    expect(markdownShortcut('#hashtag')).toBeNull()
    expect(markdownShortcut('')).toBeNull()
  })
})

describe('splitting a block on Enter', () => {
  it('continues a list item', () => {
    const { next } = splitBlock(b('bulletedListItem', 'milk'))
    expect(next.kind).toBe('bulletedListItem')
    expect(next.checked).toBe(false)
  })

  it('ends the list when the item is empty', () => {
    const { next, replaceText } = splitBlock(b('bulletedListItem', ''))
    expect(next.kind).toBe('paragraph')
    expect(replaceText).toBe('')
  })

  it('carries the callout tone but not the checkbox state', () => {
    const callout = { ...makeBlock('callout', 'note'), extra: 'warning' }
    expect(splitBlock(callout).next.extra).toBe('warning')
    const todo = { ...makeBlock('todo', 'done'), checked: true }
    expect(splitBlock(todo).next.checked).toBe(false)
  })

  it('does not continue a heading', () => {
    expect(splitBlock(b('heading1', 'Title')).next.kind).toBe('paragraph')
  })

  it('always leaves at least one block', () => {
    expect(ensureBlocks([])).toHaveLength(1)
    expect(ensureBlocks([b('paragraph', 'x')])).toHaveLength(1)
  })
})

describe('nesting', () => {
  it('stores depth as leading tabs so there is one source of truth', () => {
    const nested = indentBlocks([b('paragraph', 'child')], [0], 1)
    expect(nested[0].text).toBe('\tchild')
    const deeper = indentBlocks(nested, [0], 1)
    expect(deeper[0].text).toBe('\t\tchild')
  })

  it('never goes negative and never exceeds the limit', () => {
    let blocks = [b('paragraph', 'x')]
    blocks = indentBlocks(blocks, [0], -5)
    expect(blocks[0].text).toBe('x')
    for (let i = 0; i < 20; i += 1) blocks = indentBlocks(blocks, [0], 1)
    expect(blocks[0].text.replace(/child|x/g, '').length).toBeLessThanOrEqual(6)
  })

  it('indents only the selected blocks', () => {
    const blocks = [b('paragraph', 'a'), b('paragraph', 'b'), b('paragraph', 'c')]
    const out = indentBlocks(blocks, [0, 2], 1)
    expect(out.map((x) => x.text)).toEqual(['\ta', 'b', '\tc'])
  })
})

describe('block selection actions', () => {
  const three = () => [b('paragraph', 'a'), b('paragraph', 'b'), b('paragraph', 'c')]

  it('moves a block and clamps at the ends', () => {
    expect(moveBlocks(three(), [0], 1).map((x) => x.text)).toEqual(['b', 'a', 'c'])
    expect(moveBlocks(three(), [2], 1).map((x) => x.text)).toEqual(['a', 'b', 'c'])
    expect(moveBlocks(three(), [0], -1).map((x) => x.text)).toEqual(['a', 'b', 'c'])
  })

  it('moves a whole selection as one unit', () => {
    expect(moveBlocks(three(), [0, 1], 1).map((x) => x.text)).toEqual(['c', 'a', 'b'])
  })

  it('deletes a selection and reports where the caret lands', () => {
    const { blocks, focus } = deleteBlocks(three(), [1, 2])
    expect(blocks.map((x) => x.text)).toEqual(['a'])
    expect(focus).toBe(0)
  })

  it('never deletes the last block into nothing', () => {
    const { blocks } = deleteBlocks(three(), [0, 1, 2])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('')
  })

  it('duplicates below the original with fresh ids', () => {
    const out = duplicateBlocks(three(), [0])
    expect(out.map((x) => x.text)).toEqual(['a', 'a', 'b', 'c'])
    expect(out[1].id).not.toBe(out[0].id)
  })

  it('toggles only todos', () => {
    const blocks = [b('todo', 'a'), b('paragraph', 'b')]
    const out = toggleChecked(blocks, [0, 1])
    expect(out[0].checked).toBe(true)
    expect(out[1].checked).toBe(false)
  })

  it('collapses a non-paragraph block on backspace', () => {
    const blocks = [b('heading1', 'Title'), b('paragraph', 'x')]
    const result = backspaceOnEmpty(blocks, 0)
    // An empty heading is not editable text, so it is removed outright.
    expect(result?.blocks).toHaveLength(1)
  })

  it('keeps the checkbox state when switching away from a todo', () => {
    const todo = { ...makeBlock('todo', 'x'), checked: true }
    expect(setBlockKind(todo, 'paragraph').checked).toBe(false)
  })
})

describe('undo and redo', () => {
  it('restores the previous document and can redo it', () => {
    const history = new BlockHistory()
    const first = [b('paragraph', 'one')]
    // `push` records the state *before* a change, so one push per edit.
    history.push(first)
    const second = [b('paragraph', 'one'), b('paragraph', 'two')]

    const undone = history.undo(second)
    expect(undone).toHaveLength(1)
    const redone = history.redo(undone!)
    expect(redone).toHaveLength(2)
  })

  it('reports nothing to undo on an empty history', () => {
    const history = new BlockHistory()
    expect(history.canUndo).toBe(false)
    expect(history.undo([b('paragraph', 'x')])).toBeNull()
  })

  it('collapses a typing burst into one undo step', () => {
    // Without coalescing, holding down a key fills the history and Ctrl+Z
    // steps back one letter at a time, which is not what anyone means by undo.
    const history = new BlockHistory()
    const start = b('paragraph', '')
    history.pushTyping([start])
    history.pushTyping([{ ...start, text: 'h' }])
    history.pushTyping([{ ...start, text: 'he' }])
    history.pushTyping([{ ...start, text: 'hel' }])

    const undone = history.undo([{ ...start, text: 'hell' }])
    expect(undone?.[0].text).toBe('')
    // One burst, one step: there is nothing left to undo past.
    expect(history.canUndo).toBe(false)
  })

  it('starts a new undo step when typing resumes after a pause', () => {
    const history = new BlockHistory()
    const start = b('paragraph', 'a')
    history.pushTyping([start])
    history.pushTyping([{ ...start, text: 'ab' }])
    // A discrete action (Enter, a slash command) ends the burst, so the next
    // keystroke records its own step.
    history.push([{ ...start, text: 'ab' }])
    history.pushTyping([{ ...start, text: 'abc' }])
    expect(history.canUndo).toBe(true)
  })

  it('collapses identical consecutive snapshots so typing undoes per pause', () => {
    // Typing produces one snapshot per keystroke. Without collapsing, a single
    // Ctrl+Z would step back one character instead of one editing action.
    const history = new BlockHistory()
    const base = [b('paragraph', 'a')]
    history.push(base)
    // Same ids, same text: the state genuinely has not changed.
    history.push([{ ...base[0] }])

    const current = [b('paragraph', 'ab')]
    expect(history.undo(current)).toHaveLength(1)
    expect(history.canUndo).toBe(false)
  })

  it('drops the redo stack once a new edit lands', () => {
    const history = new BlockHistory()
    const one = [b('paragraph', 'one')]
    history.push(one)
    const two = [b('paragraph', 'one'), b('paragraph', 'two')]
    history.undo(two)
    expect(history.canRedo).toBe(true)
    history.push([b('paragraph', 'three')])
    expect(history.canRedo).toBe(false)
  })

  it('is bounded so a long session cannot grow it without limit', () => {
    const history = new BlockHistory(3)
    for (let i = 0; i < 10; i += 1) history.push([b('paragraph', `v${i}`)])
    let current = [b('paragraph', 'v9')]
    let steps = 0
    while (history.canUndo) {
      const next = history.undo(current)
      if (!next) break
      current = next
      steps += 1
    }
    expect(steps).toBe(3)
  })

  it('resets when a different page is opened', () => {
    const history = new BlockHistory()
    history.push([b('paragraph', 'a')])
    history.reset()
    expect(history.canUndo).toBe(false)
  })
})

describe('the slash menu', () => {
  it('opens on a slash at the start of a block or after a space', () => {
    expect(slashQuery('/', 1)).toBe('')
    expect(slashQuery('/head', 5)).toBe('head')
    expect(slashQuery('some text /ta', 13)).toBe('ta')
  })

  it('does not open mid-word, so "and/or" stays text', () => {
    expect(slashQuery('and/or', 6)).toBeNull()
    expect(slashQuery('a/b', 3)).toBeNull()
  })

  it('closes once the query is followed by a space', () => {
    expect(slashQuery('/head ing', 9)).toBeNull()
  })

  it('filters by label and kind', () => {
    expect(filterSlashItems('head')).toHaveLength(3)
    expect(filterSlashItems('todo').map((i) => i.kind)).toEqual(['todo'])
    expect(filterSlashItems('')).toHaveLength(SLASH_ITEMS.length)
    expect(filterSlashItems('zzzz')).toHaveLength(0)
  })
})

describe('table storage format', () => {
  it('round-trips rows through the flat string', () => {
    const rows = [
      ['a', 'b'],
      ['1', '2'],
    ]
    expect(parseTableRows(joinTableRows(rows))).toEqual(rows)
  })

  it('ignores blank lines', () => {
    expect(parseTableRows('a\tb\n\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })
})

describe('page hierarchy', () => {
  const pages = [
    page({ id: 'root', title: 'Root' }),
    page({ id: 'child', title: 'Child', parentId: 'root' }),
    page({ id: 'grand', title: 'Grandchild', parentId: 'child' }),
    page({ id: 'other', title: 'Other' }),
  ]

  it('lists children of a parent, and top-level pages', () => {
    expect(childrenOf(pages, 'root').map((p) => p.id)).toEqual(['child'])
    expect(childrenOf(pages, '').map((p) => p.id)).toEqual(['other', 'root'])
  })

  it('builds breadcrumbs root first', () => {
    expect(breadcrumbsOf(pages, 'grand').map((p) => p.id)).toEqual(['root', 'child', 'grand'])
    expect(breadcrumbsOf(pages, 'root').map((p) => p.id)).toEqual(['root'])
  })

  it('does not loop forever on a cycle', () => {
    // A cycle should be impossible (the backend rejects it) but a corrupted
    // file must not hang the UI either.
    const cyclic = [
      page({ id: 'a', parentId: 'b' }),
      page({ id: 'b', parentId: 'a' }),
    ]
    expect(breadcrumbsOf(cyclic, 'a').length).toBeLessThanOrEqual(2)
  })

  it('hides archived pages from the tree', () => {
    const withArchived = [...pages, page({ id: 'old', title: 'Old', archived: true })]
    expect(childrenOf(withArchived, '').map((p) => p.id)).not.toContain('old')
  })
})

describe('backlinks and linked work', () => {
  it('finds pages that link to a page, and tasks that belong to it', () => {
    const pages = [
      page({ id: 'target', title: 'Target' }),
      page({ id: 'src', title: 'Source', blocks: [{ ...makeBlock('page', ''), meta: 'target' }] }),
    ]
    const tasks = [
      task({ id: 't1', pageId: 'target' }),
      task({ id: 't2', projectId: 'target' }),
      task({ id: 't3' }),
    ]
    const linked = backlinksTo(pages, tasks, 'target')
    expect(linked.map((p) => p.id)).toContain('src')
    expect(tasksOfPage(tasks, 'target').map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('never lists a page as its own backlink', () => {
    const pages = [page({ id: 'p', blocks: [{ ...makeBlock('page', ''), meta: 'p' }] })]
    expect(backlinksTo(pages, [], 'p')).toHaveLength(0)
  })

  it('finds subtasks and the newest pages', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', parentId: 'a' }), task({ id: 'c', parentId: 'b' })]
    expect(subtasksOf(tasks, 'a').map((t) => t.id)).toEqual(['b'])
    const pages = [page({ id: 'x', updatedMs: 1 }), page({ id: 'y', updatedMs: 9 })]
    expect(recentPages(pages, 1).map((p) => p.id)).toEqual(['y'])
  })
})

describe('due dates', () => {
  it('labels today, tomorrow and overdue relative to the local day', () => {
    expect(dueLabel(startOfDay(Date.now()) + 3_600_000).text).toBe('Today')
    expect(dueLabel(startOfDay(Date.now()) + 86_400_000).text).toBe('Tomorrow')
    expect(dueLabel(startOfDay(Date.now()) - 86_400_000)).toEqual({ text: 'Yesterday', late: true })
    expect(dueLabel(startOfDay(Date.now()) - 3 * 86_400_000)).toEqual({ text: '3d overdue', late: true })
  })

  it('says nothing for an undated task', () => {
    expect(dueLabel(null)).toEqual({ text: '', late: false })
    expect(dueLabel(undefined)).toEqual({ text: '', late: false })
  })

  it('builds a local day key, not a UTC one', () => {
    // toISOString() shifts the date across the boundary in most time zones,
    // which filed tasks under the wrong day.
    const late = new Date(2026, 2, 1, 0, 30).getTime()
    expect(dayKey(late)).toBe('2026-03-01')
  })
})

describe('the custom CSS layer', () => {
  it('keeps ordinary rules untouched', () => {
    const css = ':root { --radius-md: 4px; }\n.card { border-radius: 2px; }'
    expect(sanitizeCss(css)).toContain('--radius-md: 4px')
    expect(sanitizeCss(css)).toContain('.card')
  })

  it('strips anything that could load or run something', () => {
    // This is the whole safety argument for the feature, so it is pinned
    // rather than trusted.
    for (const hostile of [
      '@import url("https://evil.example/x.css");',
      '@import "https://evil.example/x.css";',
      "url('https://evil.example/tracker.png')",
      'behavior: url(script.htc);',
      '-moz-binding: url(x.xml#y);',
      'width: expression(alert(1));',
      'background: javascript:alert(1);',
      '<script>alert(1)</script>',
    ]) {
      const out = sanitizeCss(`.card { ${hostile} }`)
      expect(out, `${hostile} survived`).not.toContain('evil.example')
      expect(out, `${hostile} survived`).not.toContain('expression(')
      expect(out, `${hostile} survived`).not.toContain('javascript:')
      expect(out, `${hostile} survived`).not.toContain('<script')
      expect(out, `${hostile} survived`).not.toContain('behavior:')
    }
  })

  it('allows an inline data: image, which cannot reach the network', () => {
    const out = sanitizeCss('.x { background: url(data:image/png;base64,iVBOR); }')
    expect(out).toContain('data:image/png')
  })

  it('refuses to let a stylesheet target its own container', () => {
    // Otherwise a rule could delete the element holding the CSS and leave the
    // app permanently unstyled.
    const out = sanitizeCss('#1boost-custom-css { display: none } .card { color: red }')
    expect(out).toContain('selector removed')
    expect(out).toContain('.card')
  })

  it('does not choke on unbalanced braces', () => {
    expect(() => sanitizeCss('.card { color: red')).not.toThrow()
    expect(() => sanitizeCss('@media screen { .a { b: c } }')).not.toThrow()
  })
})