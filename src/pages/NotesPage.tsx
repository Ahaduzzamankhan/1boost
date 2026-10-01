import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  CornerDownLeft,
  FileText,
  FolderGit2,
  Link2,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import type { Block, Page } from '../../shared/types'
import BlockEditor from '../components/BlockEditor'
import { Bar, EmptyState, ErrorState } from '../components/ui'
import { Marked } from '../components/SearchBits'
import { useFocusTarget } from '../nav'
import { useNavigation } from '../state'
import {
  backlinksTo,
  breadcrumbsOf,
  childrenOf,
  recentPages,
  tasksOfPage,
  useWorkspace,
} from '../workspace/store'
import { EMPTY_SEARCH_INDEX, buildSearchIndex } from '../workspace/search'
import { projectProgress, projectRollups } from '../workspace/projects'
import { makeBlock } from '../workspace/blocks'

/** Debounce before an autosave. Long enough to coalesce a typing burst, short
 *  enough that a note is never meaningfully at risk. */
const AUTOSAVE_MS = 700

type Pane = 'tree' | 'recent' | 'search'

/**
 * Pages — the writing and thinking half of the workspace.
 *
 * Layout is three columns on a wide window (tree, editor, context) and
 * collapses to two then one, so the same component works in a 1040px window
 * and a maximized one.
 */
export default function NotesPage() {
  const { pages, tasks, loading, error, savePage, deletePage, toggleTask, reload } = useWorkspace()
  const [openId, setOpenId] = useState('')
  const [pane, setPane] = useState<Pane>('tree')
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const { focus, setFocus, clearFocus } = useFocusTarget()
  const { navigate } = useNavigation()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The page being edited. Edits live here so typing never waits on a round
   *  trip; the backend copy is reconciled after each autosave. */
  const [draft, setDraft] = useState<Page | null>(null)

  const pageList = useMemo(() => pages ?? [], [pages])
  const taskList = useMemo(() => tasks ?? [], [tasks])

  // Open the first page once the list arrives, unless one is already open.
  useEffect(() => {
    if (openId || pageList.length === 0) return
    setOpenId(pageList[0].id)
  }, [openId, pageList])

  // Adopt the backend's copy whenever the open page changes identity or is
  // replaced by a save from elsewhere (palette deep link, quick capture).
  useEffect(() => {
    if (!openId) {
      setDraft(null)
      return
    }
    const found = pageList.find((p) => p.id === openId)
    setDraft(found ?? null)
  }, [openId, pageList])

  // A search hit from the palette opens that page directly.
  useEffect(() => {
    if (!focus?.pageId) return
    if (pageList.some((p) => p.id === focus.pageId)) {
      setOpenId(focus.pageId)
      setPane('tree')
    }
    clearFocus()
  }, [focus, pageList, clearFocus])

  /** Jump to Tasks, optionally landing on one task. */
  const openTask = useCallback(
    (taskId: string) => {
      navigate('tasks')
      setFocus({ taskId })
    },
    [navigate, setFocus],
  )
  const openTasks = useCallback(() => navigate('tasks'), [navigate])

  const persist = useCallback(
    (page: Page) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        setSaveState('saving')
        savePage(page)
          .then(() => setSaveState('saved'))
          .catch(() => setSaveState('failed'))
      }, AUTOSAVE_MS)
    },
    [savePage],
  )

  // Ctrl+S flushes immediately, matching every other editor on the planet.
  useEffect(() => {
    if (!draft) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (saveTimer.current) clearTimeout(saveTimer.current)
        setSaveState('saving')
        savePage(draft)
          .then(() => setSaveState('saved'))
          .catch(() => setSaveState('failed'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, savePage])

  const edit = useCallback(
    (patch: Partial<Page>) => {
      setDraft((cur) => {
        if (!cur) return cur
        const next = { ...cur, ...patch }
        persist(next)
        return next
      })
    },
    [persist],
  )

  const onBlocks = useCallback(
    (blocks: Block[]) => {
      edit({ blocks })
    },
    [edit],
  )

  const createPage = useCallback(
    async (parentId = '') => {
      const page: Page = {
        id: '',
        title: '',
        icon: '',
        parentId,
        blocks: [makeBlock('paragraph')],
        tags: [],
        favorite: false,
        archived: false,
        isProject: false,
        createdMs: 0,
        updatedMs: 0,
      }
      try {
        const saved = await savePage(page)
        setOpenId(saved.id)
        setPane('tree')
      } catch {
        // The store records the reason and `error` renders it below; an
        // unhandled rejection here would leave the button looking dead.
      }
    },
    [savePage],
  )

  const remove = useCallback(async () => {
    if (!draft) return
    const id = draft.id
    try {
      await deletePage(id)
      setOpenId('')
      setDraft(null)
    } catch {
      // Kept open on purpose: if the delete failed the page is still there,
      // and clearing the editor would pretend otherwise.
    }
  }, [draft, deletePage])

  const toggleFavorite = useCallback(() => {
    if (!draft) return
    edit({ favorite: !draft.favorite })
  }, [draft, edit])

  /**
   * A page becomes a project by flag, not by being converted into a different
   * kind of thing: the same id, blocks and children stay exactly where they
   * were, and the tasks that already point at it keep working.
   */
  const toggleProject = useCallback(() => {
    if (!draft) return
    edit({ isProject: !draft.isProject })
  }, [draft, edit])

  const crumbs = useMemo(() => breadcrumbsOf(pageList, openId), [pageList, openId])
  const backlinks = useMemo(
    () => (draft ? backlinksTo(pageList, taskList, draft.id) : []),
    [pageList, taskList, draft],
  )
  const pageTasks = useMemo(
    () => (draft ? tasksOfPage(taskList, draft.id) : []),
    [taskList, draft],
  )

  const recents = useMemo(() => recentPages(pageList, 8), [pageList])

  /**
   * The in-sidebar filter reuses the shared index rather than re-implementing
   * a title match: it therefore ranks and matches bodies and tags too, and
   * cannot drift from what Ctrl+K shows for the same word. Built only while
   * there is a query to run against it.
   */
  const pageIndex = useMemo(
    () => (query.trim() ? buildSearchIndex(pageList, taskList) : EMPTY_SEARCH_INDEX),
    [pageList, taskList, query],
  )
  const searchResults = useMemo(() => {
    const q = query.trim()
    if (!q) return []
    return pageIndex
      .search(q, ['page', 'project'], 40)
      .flatMap((g) => g.items)
      .map((hit) => pageList.find((p) => p.id === hit.id))
      .filter((p): p is Page => Boolean(p))
  }, [pageIndex, pageList, query])

  /** The project this page belongs to, when it is not one itself. */
  const owningProject = useMemo(() => {
    if (!draft?.parentId) return null
    const chain = breadcrumbsOf(pageList, draft.parentId)
    const project = [...chain].reverse().find((p) => p.isProject)
    return project ?? null
  }, [pageList, draft])

  /** Progress for the open page, when it is a project. */
  const ownProject = useMemo(
    () => (draft?.isProject ? projectRollups(pageList, taskList).find((p) => p.id === draft.id) ?? null : null),
    [pageList, taskList, draft],
  )

  const favourites = useMemo(() => pageList.filter((p) => p.favorite && !p.archived), [pageList])

  if (error && !pages) {
    return (
      <div className="page">
        <ErrorState title="The workspace could not be loaded" desc={error} onRetry={() => window.location.reload()} />
      </div>
    )
  }

  if (loading && !pages) {
    return (
      <div className="page">
        <div className="module-loading">Loading your pages…</div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="workspace-head">
        <div>
          <h1 className="page-title">Pages</h1>
          <p className="page-subtitle">
            {pageList.length} pages · {taskList.filter((t) => t.status !== 'done').length} open tasks
          </p>
        </div>
        <div className="workspace-head-actions">
          <div className="search-box">
            <Search size={15} />
            <input
              value={query}
              placeholder="Find a page…"
              onChange={(e) => {
                setQuery(e.target.value)
                setPane(e.target.value ? 'search' : 'tree')
              }}
              spellCheck={false}
            />
            {query ? (
              <button aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            ) : null}
          </div>
          <button className="btn btn-primary" onClick={() => void createPage('')}>
            <Plus size={15} /> New page
          </button>
        </div>
      </div>

      {error && pages ? (
        <div className="setting-note bad" role="alert">
          <AlertCircle size={14} />
          <span className="grow">{error}</span>
          <button className="btn btn-ghost" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      ) : null}

      {pageList.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            icon={<FileText size={24} />}
            title="No pages yet"
            desc="A page holds blocks — headings, lists, to-dos, code and tasks. Create one, or press Ctrl+Shift+Space and start with “>” to capture without leaving what you were doing."
            action={
              <button className="btn btn-primary" onClick={() => void createPage('')}>
                <Plus size={15} /> New page
              </button>
            }
          />
        </div>
      ) : (
        <div className="workspace-split">
          <aside className="tree-pane card">
            <div className="segmented tree-tabs" role="tablist">
              {(['tree', 'recent'] as Pane[]).map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={pane === p}
                  className={pane === p ? 'active' : ''}
                  onClick={() => setPane(p)}
                >
                  {p === 'tree' ? 'All' : 'Recent'}
                </button>
              ))}
            </div>

            {pane === 'search' ? (
              <div className="tree-list">
                {searchResults.length === 0 ? (
                  <div className="tree-empty">Nothing matches “{query}”.</div>
                ) : (
                  searchResults.map((p) => (
                    <TreeRow
                      key={p.id}
                      page={p}
                      depth={0}
                      active={p.id === openId}
                      query={query.trim()}
                      onOpen={setOpenId}
                      onCreate={createPage}
                    />
                  ))
                )}
              </div>
            ) : pane === 'recent' ? (
              <div className="tree-list">
                {recents.length === 0 ? (
                  <div className="tree-empty">Nothing edited yet.</div>
                ) : (
                  recents.map((p) => (
                    <TreeRow key={p.id} page={p} depth={0} active={p.id === openId} onOpen={setOpenId} onCreate={createPage} />
                  ))
                )}
              </div>
            ) : (
              <div className="tree-list">
                {favourites.length > 0 ? (
                  <>
                    <div className="tree-heading">
                      <Star size={12} /> Favourites
                    </div>
                    {favourites.map((p) => (
                      <TreeRow key={p.id} page={p} depth={0} active={p.id === openId} onOpen={setOpenId} onCreate={createPage} />
                    ))}
                    <div className="tree-heading">All pages</div>
                  </>
                ) : null}
                <TreeChildren
                  pages={pageList}
                  parentId=""
                  depth={0}
                  openId={openId}
                  onOpen={setOpenId}
                  onCreate={createPage}
                />
              </div>
            )}
          </aside>

          <section className="page-editor card">
            {draft ? (
              <>
                <nav className="crumbs" aria-label="Breadcrumbs">
                  {crumbs.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 ? <ChevronRight size={12} className="crumb-sep" /> : null}
                      <button className="crumb" onClick={() => setOpenId(c.id)}>
                        {c.icon ? `${c.icon} ` : ''}
                        {c.title || 'Untitled'}
                      </button>
                    </span>
                  ))}
                </nav>

                <div className="page-editor-bar">
                  <input
                    className="page-icon-input"
                    value={draft.icon}
                    placeholder="📄"
                    maxLength={8}
                    aria-label="Page icon"
                    onChange={(e) => edit({ icon: e.target.value })}
                  />
                  <input
                    className="page-title-input selectable"
                    value={draft.title}
                    placeholder="Untitled"
                    aria-label="Page title"
                    onChange={(e) => edit({ title: e.target.value })}
                  />
                  <div className="page-editor-actions">
                    <span className={`save-state ${saveState}`}>
                      {saveState === 'saving'
                        ? 'Saving…'
                        : saveState === 'saved'
                          ? 'Saved'
                          : saveState === 'failed'
                            ? 'Not saved'
                            : ''}
                    </span>
                    <button
                      className={`btn btn-ghost${draft.isProject ? ' on' : ''}`}
                      onClick={toggleProject}
                      title={
                        draft.isProject
                          ? 'No longer a project'
                          : 'Make this a project so it owns tasks'
                      }
                      aria-pressed={draft.isProject}
                    >
                      <FolderGit2 size={16} />
                      {draft.isProject ? 'Project' : null}
                    </button>
                    <button
                      className={`btn btn-ghost${draft.favorite ? ' on' : ''}`}
                      onClick={toggleFavorite}
                      title={draft.favorite ? 'Remove from favourites' : 'Add to favourites'}
                      aria-label={draft.favorite ? 'Remove from favourites' : 'Add to favourites'}
                    >
                      <Star size={16} fill={draft.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <button className="btn btn-ghost" onClick={() => void remove()} title="Delete page" aria-label="Delete page">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                {ownProject ? (
                  <div className="page-project-bar">
                    <FolderGit2 size={14} />
                    <span className="page-project-label">{ownProject.title || 'Untitled project'}</span>
                    <span className="page-project-count">
                      {ownProject.taskDone}/{ownProject.taskCount} tasks
                    </span>
                    <Bar fraction={projectProgress(ownProject)} />
                  </div>
                ) : null}

                {owningProject ? (
                  <button className="page-breadcrumb-project" onClick={() => setOpenId(owningProject.id)}>
                    <FolderGit2 size={13} />
                    Part of <b>{owningProject.title || 'Untitled project'}</b>
                  </button>
                ) : null}

                {draft.parentId ? null : (
                  <button
                    className="btn btn-ghost subpage-btn"
                    onClick={() => void createPage(draft.id)}
                    title="Create a page nested under this one"
                  >
                    <Plus size={14} /> Sub-page
                  </button>
                )}

                <BlockEditor
                  blocks={draft.blocks}
                  onChange={onBlocks}
                  pages={pageList}
                  tasks={taskList}
                  onToggleTask={(id) => void toggleTask(id)}
                />

                <div className="page-context">
                  <div className="context-col">
                    <div className="section-title">
                      Tasks on this page
                      {pageTasks.length > 8 ? (
                        <button className="context-more" onClick={() => openTasks()}>
                          All {pageTasks.length}
                        </button>
                      ) : null}
                    </div>
                    {pageTasks.length === 0 ? (
                      <div className="context-empty">
                        Type <kbd>/</kbd> and pick <b>Task</b> to pull one in, or add one from Tasks.
                      </div>
                    ) : (
                      <div className="row-list">
                        {pageTasks.slice(0, 8).map((t) => (
                          <div key={t.id} className={`task-row mini${t.status === 'done' ? ' done' : ''}`}>
                            <input
                              type="checkbox"
                              checked={t.status === 'done'}
                              onChange={() => void toggleTask(t.id)}
                              aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Complete ${t.title}`}
                            />
                            <button
                              className="task-title task-title-button"
                              onClick={() => openTask(t.id)}
                              title={`Open ${t.title} in Tasks`}
                            >
                              {t.title}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="context-col">
                    <div className="section-title">
                      <Link2 size={13} /> Backlinks
                    </div>
                    {backlinks.length === 0 ? (
                      <div className="context-empty">
                        No other page points here yet. Type <kbd>/</kbd> and pick <b>Page</b> to link.
                      </div>
                    ) : (
                      backlinks.map((b) => (
                        <button key={b.id} className="context-link" onClick={() => setOpenId(b.id)}>
                          <CornerDownLeft size={12} />
                          <span>{b.icon ? `${b.icon} ` : ''}{b.title || 'Untitled'}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : (
              <EmptyState
                icon={<FileText size={24} />}
                title="Select a page"
                desc="Pick one from the list, or create a new page to start writing."
                action={
                  <button className="btn btn-primary" onClick={() => void createPage('')}>
                    <Plus size={15} /> New page
                  </button>
                }
              />
            )}
          </section>
        </div>
      )}
    </div>
  )
}

/** One row in the page tree. */
function TreeRow({
  page,
  depth,
  active,
  onOpen,
  onCreate,
  query,
}: {
  page: Page
  depth: number
  active: boolean
  onOpen: (id: string) => void
  onCreate: (parentId: string) => Promise<void>
  /** When set, the title is highlighted so the match is visible. */
  query?: string
}) {
  return (
    <button
      className={`tree-row${active ? ' active' : ''}`}
      style={{ ['--depth' as string]: depth }}
      onClick={() => onOpen(page.id)}
      aria-current={active ? 'page' : undefined}
      title={page.title || 'Untitled'}
    >
      <span className="tree-icon">{page.icon || (page.isProject ? '◈' : '·')}</span>
      <span className="tree-title">
        {query ? <Marked text={page.title || 'Untitled'} query={query} /> : page.title || 'Untitled'}
      </span>
      {page.isProject ? (
        <span className="tree-tag" title="Project">
          <FolderGit2 size={11} />
        </span>
      ) : null}
      <span
        className="tree-add"
        role="button"
        tabIndex={0}
        title="Add a sub-page"
        onClick={(e) => {
          e.stopPropagation()
          void onCreate(page.id)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            void onCreate(page.id)
          }
        }}
      >
        <Plus size={12} />
      </span>
    </button>
  )
}

/** Renders a page and everything nested beneath it, recursively. */
function TreeChildren({
  pages,
  parentId,
  depth,
  openId,
  onOpen,
  onCreate,
}: {
  pages: Page[]
  parentId: string
  depth: number
  openId: string
  onOpen: (id: string) => void
  onCreate: (parentId: string) => Promise<void>
}) {
  const children = childrenOf(pages, parentId)
  if (children.length === 0) {
    return depth === 0 ? <div className="tree-empty">No pages here yet.</div> : null
  }
  return (
    <>
      {children.map((child) => (
        <div key={child.id}>
          <TreeRow page={child} depth={depth} active={child.id === openId} onOpen={onOpen} onCreate={onCreate} />
          <TreeChildren
            pages={pages}
            parentId={child.id}
            depth={depth + 1}
            openId={openId}
            onOpen={onOpen}
            onCreate={onCreate}
          />
        </div>
      ))}
    </>
  )
}

