import { Suspense, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import type { Prefs } from '../../shared/types'
import {
  Activity,
  CalendarDays,
  ClipboardList,
  Code2,
  Files,
  Grid2X2,
  History as HistoryIcon,
  LayoutDashboard,
  ChartNoAxesCombined,
  NotebookPen,
  Sparkles,
  Settings as SettingsIcon,
  ListChecks,
  Wrench,
} from 'lucide-react'
import type { PageId } from '../../shared/types'

/**
 * Every module is code-split: the shell only ever renders one of them, so
 * opening 1Boost stays fast no matter how many tools are added here. The
 * loading boundary lives in AppShell.
 */
const DashboardPage = lazy(() => import('../pages/DashboardPage'))
const MonitorPage = lazy(() => import('../pages/MonitorPage'))
const AppsPage = lazy(() => import('../pages/AppsPage'))
const StatsPage = lazy(() => import('../pages/StatsPage'))
const HistoryPage = lazy(() => import('../pages/HistoryPage'))
/** Settings is the one module that takes live props from the shell. */
export const SettingsPage = lazy(() => import('../pages/SettingsPage'))
export type SettingsPageProps = {
  prefs: Prefs
  setPref: (key: keyof Prefs, value: string | number | boolean) => Promise<void>
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean } | null
  onDelete: () => Promise<void>
  version: string
}
const NotesPage = lazy(() => import('../pages/NotesPage'))
const TasksPage = lazy(() => import('../pages/TasksPage'))
const ClipboardPage = lazy(() => import('../pages/ClipboardPage'))
const CalendarPage = lazy(() => import('../pages/CalendarPage'))
const UtilitiesPage = lazy(() => import('../pages/UtilitiesPage'))
const DevToolsPage = lazy(() => import('../pages/DevToolsPage'))
const FilesPage = lazy(() => import('../pages/FilesPage'))
const AssistantPage = lazy(() => import('../pages/AssistantPage'))

/** Workspace groups, so the sidebar stays scannable as modules grow. */
export type WorkspaceId = 'insight' | 'capture' | 'utilities'

export interface Workspace {
  id: WorkspaceId
  label: string
  blurb: string
}

export interface ModuleDef {
  id: PageId
  label: string
  /** Extra search terms for the command palette. */
  keywords: string[]
  /** Absent for footer entries, which live outside every workspace. */
  workspace?: WorkspaceId
  icon: ReactNode
  component: LazyExoticComponent<ComponentType<any>>
  /** Settings lives in the sidebar footer, not in a workspace list. */
  footer?: boolean
  /**
   * Experimental modules stay out of the sidebar until their pref is on, so
   * the rail only ever shows things that are actually usable. They remain
   * reachable from the command palette, which explains how to switch them on.
   */
  experimentalAi?: boolean
}

export const WORKSPACES: Workspace[] = [
  { id: 'insight', label: 'Insight', blurb: 'Where your time goes' },
  { id: 'capture', label: 'Capture', blurb: 'Notes, tasks and the clipboard' },
  { id: 'utilities', label: 'Utilities', blurb: 'Everyday and developer tools' },
]

/**
 * Every surface in the app. The original tracking pages are registered here
 * unchanged, so nothing that existed before the workspace system is lost —
 * they simply gain search, grouping and palette access for free.
 */
export const MODULES: ModuleDef[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    keywords: ['home', 'today', 'overview', 'summary'],
    workspace: 'insight',
    icon: <LayoutDashboard size={18} />,
    component: DashboardPage,
  },
  {
    id: 'monitor',
    label: 'Monitor',
    keywords: ['cpu', 'gpu', 'memory', 'ram', 'disk', 'network', 'performance', 'live'],
    workspace: 'insight',
    icon: <Activity size={18} />,
    component: MonitorPage,
  },
  {
    id: 'apps',
    label: 'Applications',
    keywords: ['apps', 'programs', 'software', 'usage', 'per-app'],
    workspace: 'insight',
    icon: <Grid2X2 size={18} />,
    component: AppsPage,
  },
  {
    id: 'stats',
    label: 'Statistics',
    keywords: ['statistics', 'averages', 'trends', 'insights', 'numbers'],
    workspace: 'insight',
    icon: <ChartNoAxesCombined size={18} />,
    component: StatsPage,
  },
  {
    id: 'history',
    label: 'History',
    keywords: ['history', 'days', 'past', 'timeline'],
    workspace: 'insight',
    icon: <HistoryIcon size={18} />,
    component: HistoryPage,
  },
  {
    id: 'notes',
    label: 'Notes',
    keywords: ['notes', 'note', 'write', 'scratchpad', 'markdown', 'text'],
    workspace: 'capture',
    icon: <NotebookPen size={18} />,
    component: NotesPage,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    keywords: ['tasks', 'todo', 'to-do', 'checklist', 'reminders'],
    workspace: 'capture',
    icon: <ListChecks size={18} />,
    component: TasksPage,
  },
  {
    id: 'clipboard',
    label: 'Clipboard',
    keywords: ['clipboard', 'copy', 'paste', 'snippets', 'history'],
    workspace: 'capture',
    icon: <ClipboardList size={18} />,
    component: ClipboardPage,
  },
  {
    id: 'calendar',
    label: 'Calendar',
    keywords: ['calendar', 'agenda', 'schedule', 'month', 'week', 'events'],
    workspace: 'capture',
    icon: <CalendarDays size={18} />,
    component: CalendarPage,
  },
  {
    id: 'utilities',
    label: 'Utilities',
    keywords: ['calculator', 'converter', 'color', 'password', 'unit', 'tools'],
    workspace: 'utilities',
    icon: <Wrench size={18} />,
    component: UtilitiesPage,
  },
  {
    id: 'devtools',
    label: 'Dev tools',
    keywords: ['json', 'base64', 'hash', 'uuid', 'regex', 'timestamp', 'encode', 'decode'],
    workspace: 'utilities',
    icon: <Code2 size={18} />,
    component: DevToolsPage,
  },
  {
    id: 'files',
    label: 'Files',
    keywords: ['files', 'file', 'open', 'recent', 'documents'],
    workspace: 'utilities',
    icon: <Files size={18} />,
    component: FilesPage,
  },
  {
    id: 'assistant',
    label: 'Assistant',
    keywords: ['assistant', 'ai', 'ask', 'gemini', 'experimental', 'chat'],
    workspace: 'utilities',
    icon: <Sparkles size={18} />,
    component: AssistantPage,
    experimentalAi: true,
  },
  {
    id: 'settings',
    label: 'Settings',
    keywords: ['settings', 'preferences', 'theme', 'startup', 'tray', 'about', 'system'],
    // Settings is a footer entry: it belongs to the shell, not to a group.
    // The old "System" workspace existed only to hold it and rendered as an
    // empty sidebar heading, so its functionality lives here instead.
    icon: <SettingsIcon size={18} />,
    component: SettingsPage,
    footer: true,
  },
]

const BY_ID = new Map(MODULES.map((m) => [m.id, m]))

export function moduleById(id: PageId): ModuleDef | undefined {
  return BY_ID.get(id)
}

/** Modules shown in a workspace; the footer item is excluded. */
export function modulesIn(workspace: WorkspaceId, experimentalAiEnabled = false): ModuleDef[] {
  return MODULES.filter(
    (m) => m.workspace === workspace && !m.footer && (!m.experimentalAi || experimentalAiEnabled),
  )
}

export function moduleLabel(id: PageId): string {
  return BY_ID.get(id)?.label ?? id
}

export const DEFAULT_PAGE: PageId = 'dashboard'

/** Loading boundary for a code-split module. */
export function ModuleBoundary({ id }: { id: PageId }) {
  const def = moduleById(id)
  if (!def) return <div className="page">Unknown module</div>
  const Component = def.component
  return (
    <Suspense fallback={<div className="module-loading">Loading {def.label}…</div>}>
      <Component />
    </Suspense>
  )
}