// @ts-check
// "Today's PC usage is not appearing correctly on the graph" was three
// separate bugs stacked on top of each other. These pin all three.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hourHistogram, activeHourHistogram } from '../legacy/aggregator'
import type { DayData } from '../shared/types'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function day(pcOnMs: number, activeMs: number, buckets?: [number, number][]): DayData {
  return {
    date: '2026-09-30',
    pcOnMs,
    activeMs,
    idleMs: Math.max(0, pcOnMs - activeMs),
    screenOnMs: pcOnMs,
    firstMs: Date.UTC(2026, 8, 30, 8, 0),
    lastMs: Date.UTC(2026, 8, 30, 12, 0),
    batteryMs: 0,
    acMs: pcOnMs,
    focusMs: 0,
    hours: buckets ? new Array(24).fill(0).map((_, h) => buckets[h]?.[0] ?? 0) : undefined,
    activeHours: buckets ? new Array(24).fill(0).map((_, h) => buckets[h]?.[1] ?? 0) : undefined,
    apps: {},
  } as DayData
}

describe("today's hourly graph", () => {
  it('renders the day as it actually happened, not as a flat block', () => {
    const busy = 3_600_000
    const quiet = 300_000
    const buckets: [number, number][] = []
    buckets[9] = [quiet, quiet]
    buckets[14] = [busy, busy / 2]
    const hist = hourHistogram(day(quiet + busy, quiet + busy / 2, buckets))
    expect(hist).toHaveLength(24)
    expect(hist[9]).toBe(quiet)
    expect(hist[14]).toBe(busy)
    // The bug: every hour in the observed window drew the same height.
    expect(hist[14]).toBeGreaterThan(hist[9])
    expect(hist[10]).toBe(0)
  })

  it('still renders days recorded before per-hour tracking existed', () => {
    // An upgrade must not blank the chart of every day already on disk.
    const hist = hourHistogram(day(7_200_000, 3_600_000))
    expect(hist).toHaveLength(24)
    expect(hist.some((v) => v > 0)).toBe(true)
    expect(hist.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  it('does not invent data for a day with no usage', () => {
    expect(hourHistogram(day(0, 0)).every((v) => v === 0)).toBe(true)
    expect(hourHistogram(undefined).every((v) => v === 0)).toBe(true)
    expect(activeHourHistogram(day(0, 0)).every((v) => v === 0)).toBe(true)
  })

  it('keeps the active series within the PC-on series', () => {
    const buckets: [number, number][] = []
    buckets[10] = [600_000, 0]
    buckets[11] = [600_000, 300_000]
    const on = hourHistogram(day(1_200_000, 300_000, buckets))
    const active = activeHourHistogram(day(1_200_000, 300_000, buckets))
    for (let h = 0; h < 24; h += 1) {
      expect(active[h]).toBeLessThanOrEqual(on[h])
    }
    expect(active[10]).toBe(0)
    expect(active[11]).toBe(300_000)
  })

  it('cannot spin forever on a clock that jumps past midnight', () => {
    const broken = day(3_600_000, 3_600_000)
    broken.lastMs = broken.firstMs + 400 * 86_400_000
    expect(hourHistogram(broken)).toHaveLength(24)
  })
})

describe('the Today range is no longer a one-point line chart', () => {
  const page = read('src/pages/DashboardPage.tsx')

  it('draws an hourly chart for today', () => {
    expect(page).toContain('<HourChart')
    expect(page).toMatch(/range === 'today' \? \(\s*<HourChart/)
  })

  it('never reduces the trend to a single day', () => {
    // A line chart with one point draws a zero-width path: the graph that
    // "was not showing today's usage".
    expect(page).not.toMatch(/return daily\.slice\(-1\)/)
  })

  it('asks the backend for the window it is showing', () => {
    // Slicing the dashboard payload capped the chart at the retention pref,
    // so "All Time" quietly showed less than all of it.
    expect(page).toContain('bridge.getTrend(RANGE_DAYS[r])')
    expect(page).toMatch(/'7d': 7, '30d': 30, all: 0/)
  })
})

describe('the trend window is not silently truncated', () => {
  const tracker = read('src-tauri/src/tracker.rs')

  it('treats a zero window as every day on record', () => {
    expect(tracker).toMatch(/if days <= 0 \{\s*storage\.data\.days\.len\(\)/)
    expect(tracker).toContain('days.clamp(1, 3650)')
  })

  it('records real per-hour buckets as samples arrive', () => {
    const model = read('src-tauri/src/model.rs')
    expect(model).toContain('pub hours: [u64; 24]')
    expect(model).toContain('pub active_hours: [u64; 24]')
    const aggregator = read('src-tauri/src/aggregator.rs')
    // Bucketing from the sample's own timestamp keeps an hour from landing in
    // a different day than the day key it was filed under.
    expect(aggregator).toMatch(/day\.hours\.get_mut\(hour\)/)
    expect(aggregator).toMatch(/day\.active_hours\.get_mut\(hour\)/)
  })

  it('keeps the timezone offset from going stale across a DST change', () => {
    const util = read('src-tauri/src/util.rs')
    expect(util).toContain('OFFSET_TTL')
    expect(util).toContain('taken.elapsed() < OFFSET_TTL')
    expect(util).not.toContain('OnceLock')
  })
})

describe('navigation', () => {
  const registry = read('src/modules/registry.tsx')

  it('has no System workspace left', () => {
    expect(registry).toContain("export type WorkspaceId = 'insight' | 'workspace' | 'utilities'")
    expect(registry).not.toContain("id: 'system'")
    expect(registry).not.toContain("| 'system'")
  })

  it('has no AI module or AI pref left anywhere in the renderer', () => {
    // The experimental assistant was removed outright, not hidden behind a
    // flag: a module the user cannot reach is still code to maintain.
    expect(registry).not.toContain('assistant')
    expect(registry).not.toContain('experimentalAi')
    for (const file of [
      'src/modules/registry.tsx',
      'src/bridge.ts',
      'src/state.ts',
      'shared/types.ts',
      'src/pages/SettingsPage.tsx',
    ]) {
      const source = read(file)
      expect(source, `${file} still mentions the assistant`).not.toMatch(/experimentalAi|aiStatus|aiAsk|AiStatus/)
    }
  })

  it('keeps Settings reachable, now as a footer entry', () => {
    expect(registry).toMatch(/id: 'settings'/)
    expect(registry).toMatch(/footer: true/)
    // "system" stays searchable so the palette can still find it.
    expect(registry).toMatch(/keywords: \[[^\]]*'system'/)
  })

  it('does not change workspace when a footer module is opened', () => {
    const shell = read('src/components/AppShell.tsx')
    expect(shell).toContain('if (def?.workspace) setWorkspace(def.workspace)')
  })
})

describe('global search is one surface, reachable from both entry points', () => {
  const registry = read('src/modules/registry.tsx')
  const shell = read('src/components/AppShell.tsx')
  const palette = read('src/components/CommandCenter.tsx')
  const page = read('src/pages/SearchPage.tsx')

  it('is a registered module', () => {
    expect(registry).toMatch(/id: 'search'/)
    expect(registry).toContain('component: SearchPage')
    expect(registry).toContain('const SearchPage = lazy(')
  })

  it('stays out of the sidebar but not out of the command center', () => {
    // Two search entries in the sidebar would be two answers to one question;
    // but a surface that is only reachable after typing a query is not
    // reachable at all when you just want to look at something.
    expect(registry).toContain('hidden: true')
    expect(registry).toMatch(/modulesIn[\s\S]*?!m\.hidden/)
    expect(palette).toMatch(/MODULES\.filter\(\(m\) => !m\.footer\)/)
  })

  it('opens an application hit on that application, not on the list', () => {
    // Picking a search result should land on the result everywhere.
    expect(page).toContain('bridge.openAppDetail(item.id)')
    expect(palette).toContain('bridge.openAppDetail(id)')
  })

  it('hands a query from the command center to the Search page', () => {
    expect(shell).toContain('setFocus({ searchQuery: q })')
    expect(shell).toContain('navigate(\'search\')')
    expect(page).toContain('focus?.searchQuery')
  })

  it('shows the agenda when the Calendar chip is on, even with no query', () => {
    // A filter that quietly reverts to "recently touched" is worse than no
    // filter: the user believes they are looking at a narrower list.
    expect(page).toMatch(
      /if \(scope === 'calendar'\) \{[\s\S]*?index\.calendar\(q, GROUP_LIMIT\)/,
    )
    expect(page).not.toMatch(/Recently touched[\s\S]{0,400}scope === 'calendar'/)
  })

  it('keeps the dashboard monitoring and application activity', () => {
    const dash = read('src/pages/DashboardPage.tsx')
    expect(dash).toContain('<SystemStrip')
    expect(dash).toContain('bridge.monitor((s) => setMonitor(s))')
    expect(dash).toContain('Application usage')
    expect(dash).toContain('bridge.openAppDetail(a.key)')
    // ...and adds the workspace on top of it rather than instead of it.
    expect(dash).toMatch(/<Timer size=\{15\} \/>\s*Upcoming/)
    expect(dash).toMatch(/<FolderGit2 size=\{15\} \/>\s*Projects/)
    expect(dash).toContain('quick-row')
  })
})

describe('auto-update', () => {
  const updater = read('src-tauri/src/updater.rs')

  it('checks every five minutes', () => {
    expect(updater).toMatch(/const RECHECK_MS: u64 = 5 \* 60_000;/)
  })

  it('re-verifies the artifact immediately before installing it', () => {
    expect(updater).toContain('pending_is_intact')
    expect(updater).toMatch(/digest: crate::delta::sha256\(&bytes\)/)
    // A corrupt staged artifact is discarded, not installed.
    expect(updater).toContain('staged update {} failed its integrity check')
    expect(updater).toContain('staged update {} is not an installer archive')
  })

  it('never starts two updates at once', () => {
    expect(updater).toContain('IN_FLIGHT')
    expect(updater).toContain('INSTALL_STARTED')
    // Re-staging the version already downloaded must be a no-op, not a
    // second download of the same release.
    expect(updater).toMatch(/if existing\.version == version \{\s*return false;/)
  })

  it('backs off after a failure instead of retrying every five minutes', () => {
    expect(updater).toContain('note_failure')
    expect(updater).toMatch(/BACKOFF_MAX_MS/)
  })

  it('only restarts on its own once the user is genuinely idle', () => {
    expect(updater).toMatch(/const IDLE_APPLY_MS: u64 = 10 \* 60_000;/)
    expect(updater).toContain('auto_apply_if_idle')
    // Never while the window is in front of the user.
    expect(updater).toContain('is_focused')
    // The tracker is stored as an Arc inside AppState, not as a directly
    // managed state type — asking for the bare type would panic at runtime.
    expect(updater).toContain('app.state::<crate::AppState>().tracker.idle_ms()')
    expect(updater).not.toContain('state::<SharedTracker>')
  })

  it('reports a staged update to the UI, not a fixed idle state', () => {
    expect(updater).toMatch(/pub async fn update_state[\s\S]*?pending_version|pending_is_intact/)
  })

  it('uses a black popup that explains the idle restart', () => {
    const shell = read('src/components/AppShell.tsx')
    expect(shell).toContain('update-pop')
    expect(shell).toMatch(/away from the keyboard/)
    expect(read('src/index.css')).toContain('.update-pop .modal')
  })
})
