import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for the black-screen crash in 1.3.1: the command palette
 * declared a useEffect *after* its `if (!open) return null`, so opening the
 * palette changed React's hook count and React tore the whole tree down.
 *
 * The check is structural rather than behavioural, so it runs over every
 * renderer component instead of only the one that broke. Module-level helpers
 * also use early `return`s, so the scan is scoped to component bodies.
 */
const SRC = join(process.cwd(), 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const HOOK = /\buse(?:State|Effect|LayoutEffect|Memo|Callback|Ref|Reducer|ImperativeHandle|DebugValue)\s*\(/
/** Statements that sit directly in a component body (PascalCase components). */
const COMPONENT = [
  /^export\s+default\s+function\s+[A-Z]/,
  /^(?:export\s+)?function\s+[A-Z]/,
  /^(?:export\s+)?const\s+[A-Z]\w*\s*[:=]/,
]
/** A component-body `return`, optionally guarded by a single-line `if`. */
const BODY_RETURN = /^(?:if\s*\([^\n]*\)\s*return\b|return\b)/

/** Indentation of a line. */
function indentOf(line: string): number {
  return (line.match(/^ */) as RegExpMatchArray)[0].length
}

/**
 * Returns the indentation of a component's body block, or -1 when the
 * declaration never opens one.
 *
 * Bracket depth is carried across lines so wrapped signatures work
 * (`function X(\n  a: string,\n) {`) while a `const X = [...] as const` is
 * correctly reported as bodyless instead of swallowing the next function.
 * Braces inside a parameter type, such as `({ onPick }: Props) {`, are seen at
 * a non-zero depth and skipped; depth is clamped because an arrow signature
 * can open and close its parens on different lines.
 */
function bodyBlockIndent(lines: string[], index: number): number {
  let depth = 0
  for (let i = index; i < lines.length && i <= index + 12; i += 1) {
    const line = lines[i]
    let quote = ''
    for (let c = 0; c < line.length; c += 1) {
      const char = line[c]
      if (quote) {
        if (char === '\\') c += 1
        else if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char
        continue
      }
      if (char === '/' && line[c + 1] === '/') break
      if (char === '(' || char === '[') depth += 1
      else if (char === ')' || char === ']') depth -= 1
      else if (char === '{') {
        if (depth <= 0) return indentOf(line.slice(0, c)) + 2
        depth += 1
      } else if (char === '}') depth -= 1
    }
    if (depth <= 0 && !/[,([{]\s*$/.test(line)) return -1
  }
  return -1
}

export type HookOrderIssue = {
  /** Zero-based index of the offending line. */
  line: number
  /** The offending source line, trimmed. */
  text: string
}

/**
 * Finds hooks that are declared after a component's early return, i.e. hooks
 * React would skip on some renders. The component body is delimited by brace
 * depth and its own statements are recognised by indentation, so a nested
 * block can never be mistaken for a body-level return.
 */
export function findHookOrderIssues(source: string): HookOrderIssue[] {
  const lines = source.split('\n')
  const issues: HookOrderIssue[] = []
  const pad = (indent: number) => ' '.repeat(indent)

  lines.forEach((line, index) => {
    if (!COMPONENT.some((pattern) => pattern.test(line))) return

    const bodyIndent = bodyBlockIndent(lines, index)
    if (bodyIndent === -1) return

    const body = pad(bodyIndent)
    let earlyReturn = -1
    for (let i = index + 1; i < lines.length; i += 1) {
      const current = lines[i]
      const indent = indentOf(current)
      // The component's own closing brace ends the scan. Brace counting is
      // deliberately avoided: apostrophes in JSX prose and braces inside
      // template literals would skew it.
      if (current.trim() === '}' && indent < bodyIndent) break
      if (indent === bodyIndent && current.startsWith(body)) {
        if (earlyReturn === -1 && BODY_RETURN.test(current.trim())) {
          earlyReturn = i
          continue
        }
        if (earlyReturn !== -1 && HOOK.test(current)) {
          issues.push({ line: i, text: current.trim() })
        }
      }
    }
  })

  return issues
}

describe('hook order scanner', () => {
  it('flags the CommandPalette crash: useEffect after the render early return', () => {
    const buggy = [
      'export function CommandPalette() {',
      '  const [query, setQuery] = useState("")',
      '  if (!open) return null',
      '  useEffect(() => {',
      '    rowRefs.current[active]?.scrollIntoView({ block: "nearest" })',
      '  }, [active, results])',
      '  return <div className="palette">{results.length}</div>',
      '}',
    ].join('\n')

    const issues = findHookOrderIssues(buggy)
    expect(issues).toHaveLength(1)
    expect(issues[0].text).toContain('useEffect')
  })

  it('accepts the same component with the effect hoisted above the early return', () => {
    const fixed = [
      'export function CommandPalette() {',
      '  const [query, setQuery] = useState("")',
      '  const activeRef = useRef<HTMLDivElement | null>(null)',
      '  useEffect(() => {',
      '    activeRef.current?.scrollIntoView({ block: "nearest" })',
      '  }, [active, results])',
      '  if (!open) return null',
      '  return <div className="palette">{results.length}</div>',
      '}',
    ].join('\n')

    expect(findHookOrderIssues(fixed)).toEqual([])
  })

  it('ignores module-level helpers that return early', () => {
    const helper = [
      'const PRIORITIES = ["None", "Low", "High"] as const',
      '',
      'function dueLabel(dueMs: number | null) {',
      '  if (!dueMs) return { text: "", late: false }',
      '  const hours = Math.round(dueMs / 3_600_000)',
      '  return { text: `Due in ${hours}h`, late: false }',
      '}',
      '',
      'export function TasksPage() {',
      '  const [tasks, setTasks] = useState<Task[]>([])',
      '  useEffect(() => { void listTasks().then(setTasks) }, [])',
      '  if (!tasks.length) return <EmptyState />',
      '  return <ul>{tasks.length}</ul>',
      '}',
      '',
      'function emptyTask(): Task {',
      '  return { title: "" }',
      '}',
    ].join('\n')

    expect(findHookOrderIssues(helper)).toEqual([])
  })

  it('handles a component whose signature wraps across lines', () => {
    const wrapped = [
      'type Props = { open: boolean }',
      '',
      'export function QuickCapture({',
      '  open,',
      '}: Props) {',
      '  const [text, setText] = useState("")',
      '  if (!open) return null',
      '  return <form>{text}</form>',
      '}',
    ].join('\n')

    expect(findHookOrderIssues(wrapped)).toEqual([])
  })
})

describe('renderer hook order', () => {
  const files = sourceFiles(SRC)

  it('finds the renderer sources', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files.map((file) => [file.slice(SRC.length + 1), file]))(
    '%s declares every hook before its early returns',
    (_name, file) => {
      const issues = findHookOrderIssues(readFileSync(file, 'utf8'))
      if (issues.length === 0) return
      const detail = issues.map((issue) => `line ${issue.line + 1}: ${issue.text}`).join('\n')
      throw new Error(
        `hook declared after a component early return:\n${detail}\n` +
          `moving it above the early return fixes the crash`,
      )
    },
  )
})

describe('command center contract', () => {
  const src = readFileSync(join(SRC, 'components', 'CommandCenter.tsx'), 'utf8')

  it('escapes and closes on Escape', () => {
    expect(src).toContain("e.key === 'Escape'")
  })

  it('keeps every hook above the render early return', () => {
    const early = src.indexOf('if (!open) return null')
    expect(early).toBeGreaterThan(-1)
    expect(src.slice(early)).not.toMatch(/^\s+use(?:Effect|Memo|State|Callback|Ref)\(/m)
  })

  it('renders through a portal so the overlay escapes the card stack', () => {
    expect(src).toContain('createPortal')
  })

  it('is the only Ctrl+K surface, and the old palette is gone', () => {
    // Two boxes answering the same shortcut is the kind of duplication that
    // made the palette and the page disagree about what a result means.
    expect(readFileSync(join(SRC, 'components', 'AppShell.tsx'), 'utf8')).toContain(
      "import CommandCenter from './CommandCenter'",
    )
    expect(() => readFileSync(join(SRC, 'components', 'CommandPalette.tsx'), 'utf8')).toThrow()
  })

  it('is wired around a single shared workspace cache', () => {
    // Without the provider, every module that calls useWorkspace() throws.
    const shell = readFileSync(join(SRC, 'components', 'AppShell.tsx'), 'utf8')
    expect(shell).toContain('<WorkspaceProvider>')
    expect(shell.indexOf('<WorkspaceProvider>')).toBeLessThan(shell.indexOf('useFocusTarget()'))
  })
})

describe('nav focus context', () => {
  const src = readFileSync(join(SRC, 'components', 'AppShell.tsx'), 'utf8')

  it('provides the nav context around the whole shell, not inside the content', () => {
    // The provider has to wrap the component that reads it, or focus targets
    // from the palette/capture silently resolve to the no-op default.
    expect(src).toContain('<NavProvider>')
    const providerIdx = src.indexOf('<NavProvider>')
    const consumerIdx = src.indexOf('useFocusTarget()')
    expect(providerIdx).toBeLessThan(consumerIdx)
  })
})