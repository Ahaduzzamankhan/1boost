import type { ReactNode } from 'react'
import { Boxes, FileText, FolderGit2, ListChecks } from 'lucide-react'
import type { SearchHit, SearchKind } from '../../shared/types'
import { SCOPES, highlightParts, type SearchFilter, type SearchItem } from '../workspace/search'

/**
 * The bits every search surface shares.
 *
 * The command center and the Search page were written separately and drifted
 * immediately: different icons, different highlight, different chip order.
 * Anything both of them show lives here, so "search results look the same
 * wherever you find them" is a fact about the code rather than a hope.
 */

const ICONS: Record<SearchKind, ReactNode> = {
  project: <FolderGit2 size={15} />,
  page: <FileText size={15} />,
  task: <ListChecks size={15} />,
  app: <Boxes size={15} />,
}

/** The icon that stands for a kind, everywhere search results are shown. */
export function KindIcon({ kind }: { kind: SearchKind }) {
  return <>{ICONS[kind] ?? <FileText size={15} />}</>
}

/** How many results to show per group before the list stops being scannable. */
export const GROUP_LIMIT = 12

/**
 * Renders `text` with every occurrence of `query` marked.
 *
 * Splitting into spans rather than injecting markup keeps the result text
 * incapable of interpreting anything the user typed.
 */
export function Marked({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="search-hit">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** The filter chips. Tab cycles them; they are also ordinary buttons. */
export function ScopeChips({
  value,
  onChange,
  trailing,
}: {
  value: SearchFilter
  onChange: (v: SearchFilter) => void
  trailing?: ReactNode
}) {
  return (
    <div className="palette-scopes" role="tablist" aria-label="Filter results">
      {SCOPES.map((s) => (
        <button
          key={s.value}
          role="tab"
          aria-selected={value === s.value}
          className={`palette-scope${value === s.value ? ' active' : ''}`}
          onClick={() => onChange(s.value)}
        >
          {s.label}
        </button>
      ))}
      {trailing}
    </div>
  )
}

/** The chips follow each other round, so Tab always lands somewhere real. */
export function cycleScope(scope: SearchFilter, step: number): SearchFilter {
  const i = SCOPES.findIndex((s) => s.value === scope)
  return SCOPES[(i + step + SCOPES.length) % SCOPES.length].value
}

/**
 * Backend application hits, reshaped into `SearchItem`s.
 *
 * Applications are the one kind the renderer cannot score itself — the usage
 * history lives in Rust — so they arrive already ranked and only need to look
 * like every other row. They carry no timestamp: how long an app was tracked
 * is not when it was last touched.
 */
export function appHitsToItems(hits: SearchHit[]): SearchItem[] {
  return hits.map((h) => ({
    kind: h.kind,
    id: h.id,
    title: h.title,
    subtitle: h.subtitle,
    score: h.score,
    updatedMs: 0,
  }))
}