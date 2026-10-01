# Changelog

All notable changes to 1Boost are documented here. The latest release's
section is injected into the GitHub Release body by CI
(`scripts/release-notes.mjs`).

## [Unreleased]

## [2.0.0-alpha.1] - 2026-10-01

The first 2.0 build. This is a prerelease: it is published as a GitHub
prerelease, so installs on the stable 1.3.2 line are **not** offered it through
the updater. Grab the installer from the release page if you want to try the
new workspace.

Everything below was developed on this version and is verified there. Notes are
migrated to pages on first launch (the original `notes.json` is left untouched),
tasks written by 1.3.x load with empty project/page fields, and the experimental
AI assistant from 1.3.x is gone for good.

### Added

- **Global search.** One field that finds pages, projects, tasks, calendar
  items and tracked applications. Results are grouped by kind, highlighted
  where the query matched, narrowed by filter chips (All / Projects / Pages /
  Tasks / Calendar / Apps) and opened directly with Enter. Pages, projects and
  tasks are ranked in the renderer against the cache the app already holds, so
  results appear on the same frame as the keystroke; only the usage history
  behind applications needs a round trip, and that is debounced.
  Empty query shows what you touched most recently and what is coming up.
- **The command center.** Ctrl+K is now a global command center rather than a
  search box: create a page, a project or a task from what you typed, jump to
  any module, reopen recent pages and projects, quick capture, today's tasks,
  pause tracking and open settings — all without the mouse. `Tab` cycles the
  filter, `↑`/`↓` move, `Enter` opens, `Esc` closes, and a leading `>` jumps to
  Tasks. "All results" hands the query to the full search surface.
- **Quick actions on the dashboard.** Search, new page, new project, tasks and
  the live system view are one click away from the top of the home screen.
- **Workspace backup and restore.** Settings can export pages, projects, tasks
  and clipboard history to one portable JSON file and import it back. Import
  *merges*: it can only add work, never remove it, and reports exactly what it
  added, so picking the wrong file cannot destroy anything. "Delete all usage
  data" now says — and is — about telemetry only.
- **Workspace recovery.** Every workspace file keeps its previous generation as
  `.bak`. A file that cannot be read is restored from it and the repair is
  reported in Settings instead of showing an empty workspace.

### Changed

- **The dashboard is the central overview.** Today's tasks and a seven-day
  upcoming list, recent pages and active projects with progress, quick actions,
  the time/activity summary, application activity, live system monitoring and
  the shortcut list — the monitoring and activity sections are unchanged, the
  workspace is layered on top. Navigation is instant and in-app, and every
  project, page and task on the screen is a link to the thing itself.
- **Projects are visible everywhere.** A page can be marked as a project from
  its own toolbar; the tree marks them, the dashboard lists them with progress,
  the editor shows a project's task count, a sub-page says which project it
  belongs to, and a task's project is a link rather than a label.
- **The clipboard no longer polls.** New entries are pushed to the window as
  they are stored, replacing a three-second timer that refetched the whole
  history for as long as the page was open.
- **The dashboard paints on the first frame.** The payload `get_initial`
  already paid for is handed to the module through context instead of being
  fetched again, so the home screen no longer waits for the next usage push.
- **Search lives in one place.** Pages, the sidebar filter and Tasks all score
  with the same function the command center and the Search page use, so the
  same word always finds the same things.

### Fixed

- `.grow`, the flex spacer used by every banner, row and strip in the app, had
  no CSS rule at all, so those layouts collapsed.
- `--text-secondary` was declared twice in `:root`, silently overwriting the
  typography value with a colour. The sizes are now `--text-secondary-size`
  and `--text-muted-size`, and both are documented because they exist.
- A custom stylesheet could blank the window (`body { display: none }`) with no
  way back to the editor that would undo it. Containers are protected now;
  hiding any ordinary part of the UI still works.
- The Settings custom-CSS editor documented two variables that did not exist.
- Searching for an application landed on the application list instead of that
  application.
- `Delete all data` did not say that it leaves pages and tasks alone.

### Changed (the workspace redesign)

- **1Boost is now a connected workspace.** Notes and Tasks were two unrelated
  modules that happened to share a data folder; they are now one model.
  - **Pages replace notes.** A page is a tree of blocks — headings,
    paragraphs, bulleted and numbered lists, to-dos, quotes, callouts, code,
    dividers and images — written in a block editor rather than a textarea.
    Pages nest, so a page can hold sub-pages.
  - **Tasks live in the same model.** A task carries a status, priority, due
    date, tags, subtasks, an optional project page, an optional source page
    and a list of tasks it is blocked by.
  - **Everything points at everything.** A task references its project and the
    page it was written on; a page can reference tasks and other pages. The
    dashboard's task list, a page's task panel and the backlink list all walk
    those same references, so moving between a task, its project and the page
    it came from is one click.
- **Pages.** Block editor with a slash menu and markdown shortcuts (`#`,
  `-`, `1.`, `[]`, `>`, ```` ``` ````, `---`), drag-to-reorder, multi-block
  selection with bulk move/nest/duplicate/delete, undo/redo, debounced
  autosave with Ctrl+S to flush, page tree with breadcrumbs, favourites and
  recents, page search, backlinks and a page-local task list.
- **Tasks.** Status (to do / in progress / blocked / done), priority, due dates,
  tags, subtasks, projects, blocked-by relations and recurrence (daily,
  weekdays, weekly, monthly — completing a recurring task reschedules it
  rather than closing it), in three views: list, board and calendar. Filter by
  status, project and tag; sort by due date, priority, newest or title; quick
  create with Enter, and `N` to jump to it from anywhere in the module.
- **The dashboard is the home of 1Boost.** It leads with today's tasks and
  recent work, keeps the time and activity summary it already had, and adds a
  live system strip (CPU, memory, tightest drive) and a shortcut list.
- **The interface is black, white and grayscale.** The user-selectable accent
  colour is gone; emphasis is carried by the theme's own accent tokens, which
  are also the supported customization surface.
- **Custom CSS.** Settings has an optional stylesheet editor listing every
  supported variable and component class. It is applied after the app's own
  CSS in one dedicated element, and clears back to the default completely.

### Removed

- **The experimental AI assistant, entirely.** The Rust modules, the
  `experimental-ai` cargo feature, its `sha1` dependency, the five `ai_*`
  commands, the `experimentalAi` preference, the Assistant module and its
  Settings section are all gone. Nothing is hidden behind a flag and no
  replacement was added. Existing `settings.json` files that carry
  `experimentalAi` still load: the field is simply ignored.

### Migration

- Notes are migrated to pages on first launch. Each note becomes a page and
  its plain-text body is parsed into blocks using the editor's own markdown
  vocabulary, so headings, lists, to-dos, quotes and fenced code survive the
  upgrade. `notes.json` is left untouched on disk.
- A note's `pinned` flag becomes the page's `favourite`.
- Tasks written before the upgrade deserialize with empty project, page,
  subtask and recurrence fields, and their old `done` boolean is folded into the
  new `status`.
- Deleting a page no longer loses the tasks written on it: they are kept and
  simply stop claiming a page that no longer exists.

## [1.3.2] - 2026-10-01

Added and then withdrawn before the release was cut. The experimental AI
assistant described below never shipped: it was removed during the workspace
redesign documented under [2.0.0-alpha.1] and replaced by nothing. The release
number is reused for the redesign.

## [1.3.1] - 2026-09-30

### Added

- **Delta updates are now the primary updater** — a release publishes a signed
  `.1bdelta` patch next to its updater payload, and an install that already
  has the previous payload on disk rebuilds the new one locally. A typical
  update drops from ~2 MB to a few KB. The patch is matched with a rolling
  window so an insertion anywhere in the artifact does not break alignment,
  which is what keeps the patch small for binaries that only differ in a few
  places.
- **Rollback** — Settings can reinstall the previous version from the payload
  1Boost already downloaded and hash-verified.

### Security

- A patch is only applied after its minisign signature verifies against the
  same release key the full artifact uses, the cached base matches the SHA-256
  recorded in the patch header, and the rebuilt artifact matches the target
  SHA-256. Anything else discards the patch and falls back to the full update.
- The cached payload keeps a sidecar hash and is refused if its bytes no longer
  match, and version strings from the release feed are validated before they are
  used as file names.

### Fixed

- **Today's PC usage was missing from the dashboard graph.** Three separate
  faults were stacked on top of each other:
  1. Selecting **Today** reduced the trend to a single point, and the chart is
     a line — one point produces a zero-width path and nothing is drawn at all.
     Today now renders as an hourly column chart, which is also the honest
     shape for a single day.
  2. Nothing recorded *which* hour usage belonged to. The backend spread each
     day's total evenly across every hour it spanned, so the graph was a flat
     block that never matched what you were doing. Per-hour buckets are now
     recorded as samples arrive, in the day and the hour the sample's own
     timestamp puts it in.
  3. Days recorded before this release have no buckets. They fall back to the
     old estimate rather than rendering blank, so upgrading does not empty the
     chart of your history.
- **"All Time" quietly showed less than all of it** — the dashboard sliced the
  payload it was given, which was capped at the history-retention preference.
  Each range now asks the backend for exactly the window it is showing, and
  All Time means every day on record.
- **The timezone offset could go stale** — it was cached once per process, so a
  laptop crossing a DST boundary or a user changing their timezone kept filing
  samples under the previous day's key and split one day in two. It is
  re-read on a timer now.
- **Black screen when searching** — the command palette declared a `useEffect`
  *after* its `if (!open) return null`, so the first keystroke that opened it
  changed React's hook count. React tore the whole tree down instead of showing
  results, leaving an empty window. The effect is hoisted above the early
  return and gated on `open`.
- **Command palette and quick capture could not reach the active workspace** —
  the shell read the focus context from a provider it rendered *inside* its own
  subtree, so every focus target resolved to the no-op default and jumping to a
  module from the palette did nothing. The provider now wraps the shell.
- A regression test (`tests/shell.test.ts`) walks every renderer component and
  fails the build if a hook is ever declared after an early return again.
- **The system tray was unreadable and half-dead** — `tauri.conf.json` declared
  a tray icon, and Tauri builds that one before the app's `setup` runs. The
  tray setup found the icon already there, returned early, and never attached
  its own menu, tooltip or click handlers, so the notification-area entry was a
  leftover with no menu behind it. The config entry is gone and the Rust side
  owns exactly one tray icon.
- **The tray icon is now drawn for the tray** — it was a copy of the 32×32 app
  logo, which turns to mush at the 16 pixels the notification area gives it and
  vanishes entirely on the light taskbar Windows ships with. The tray has its
  own flat glyph, in a dark and a light variant, and picks the one that matches
  the OS theme. Generated by `npm run icons:tray`, and `tests/tray.test.ts`
  fails if the committed PNGs drift from the generator.
- **Export JSON did nothing** — the command wrote a file into `%APPDATA%` and
  returned its path, but the renderer discarded the result and showed no
  confirmation, so the button looked dead and the file was never anywhere
  anyone looks. Export now opens a Save dialog in Documents, reports what
  happened under the button, and can reveal the file in Explorer. It also stops
  holding the usage-database lock across the write, which was stalling the
  tracking loop.
- **The new task button could fail silently** — every step of "add a task" ran
  as an unhandled rejection, so a failure left the draft untouched and an empty
  list with no message. Failures are now reported in place, a save that
  succeeds but cannot refresh the list says so, Enter and the button cannot
  double-submit, and a toggle that fails no longer looks like it worked.
- **A single panicking thread could permanently disable the whole vault** —
  notes, tasks and clipboard state live behind `Mutex`es locked with `unwrap()`.
  One panic while a lock was held poisoned it, and every later command panicked
  too; to the UI that is simply a button that does nothing, forever. Locks now
  recover the guard instead, and `src-tauri/src/vault.rs` has a test that panics
  on purpose and then keeps using the vault.

### Changed

- **The system tray now updates itself.** 1Boost checks for a new release
  every five minutes instead of every six hours, downloads it silently in the
  background, verifies it, and shows a black prompt offering a restart. If you
  would rather not restart now, it waits: once you have been away from the
  keyboard for ten minutes and the window is not in front of you, it applies
  the update itself. It never restarts you mid-sentence, and it will not apply
  anything while the app is open and in use.
  - A staged update is re-hashed against the digest recorded when it was
    downloaded, immediately before the installer sees it, and is confirmed to
    be a real installer archive. A corrupt artifact is discarded, never run.
  - Checks cannot overlap or run twice for the same release, an update already
    staged is not downloaded again, and once an install starts nothing may
    begin another — no duplicate downloads, no update loops.
  - Offline or failing checks back off progressively (5 to 60 minutes) and
    recover on their own when the network returns.
- **The System page is gone from the sidebar.** It existed only to hold
  Settings, which already lives in the sidebar footer, so it rendered as an
  empty heading. Settings is unchanged and still reachable from the footer,
  the command palette and search; the live machine readings stay on Monitor.
- **A more consistent surface across the app** — one shared page header so every
  module opens with the same rhythm, and a plain inline chip for single facts
  where a card was nested inside a card. Metric tiles and list rows cascade in,
  the live progress bars carry a sheen, status dots breathe, text fields have
  a focus ring, page titles carry a subtle gradient, cards gain depth on hover,
  and the sidebar collapses cleanly on narrow windows. Motion stays inside the
  rules this app already had to learn on Windows: opacity, colour and shadow on
  large surfaces, transforms only on small controls, so nothing can tear
  against the window's blur layer — and the existing reduced-motion setting
  switches all of it off at once.

### Notes

- The first update an install takes is still a full download: the NSIS
  installer leaves no copy of the updater payload behind, so there is nothing to
  patch against until 1Boost has cached one itself. From the second update on,
  the delta path is used. Every failure mode falls back to the full update, so
  the worst case is the previous download size.
- `npm run dev` now builds the renderer and serves it, so the UI can be opened
  in a browser. It is a local preview; the app itself is still the Tauri build.

## [1.3.0] - 2026-09-30

### Added

- **Workspaces** — modules are grouped into Insight, Capture and Utilities, and
  the sidebar switches between them. Every module is code-split, so opening
  1Boost loads the shell plus one screen instead of the whole app.
- **Command palette** (<kbd>Ctrl</kbd>+<kbd>K</kbd>) — one box that searches
  modules, notes, tasks and every app you have used, ranked locally for
  modules and by a Rust fuzzy scorer for content.
- **Quick capture** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>) —
  type anywhere and press Enter. Plain text becomes a note, a leading `!` makes
  it a task, and `#word` becomes a tag.
- **Notes** — list, search, pin, tag and edit; autosorted by pin then edit time.
- **Tasks** — quick add, filters, priorities, due dates and one-click clear.
  A task with a due date shows up on the calendar.
- **Clipboard history** — records new clipboard text continuously (pinned
  entries are never evicted), searchable, with copy and delete.
- **Calendar** — month grid plus agenda, fed by task due dates.
- **Utilities** — unit converter, colour converter, password generator and an
  epoch/time converter.
- **Dev tools** — JSON format/minify, base64 encode/decode, SHA-1/SHA-256 and
  UUID generation, all computed locally.
- **Files** — searches and opens files from Desktop, Documents, Downloads,
  Pictures, Music and Videos, with show-in-Explorer.

### Changed

- The renderer build is now ESM with code splitting: startup ships ~280 KB and
  the remaining modules stream in only when opened.
- Productivity data lives in its own files (`notes.json`, `tasks.json`,
  `clipboard.json`) next to the existing ones, so `usage-data.json` and every
  old backup stay exactly as they were.

## [1.2.1] - 2026-09-30

### Fixed

- **Monitor page shows every metric again** — memory, disk activity,
  download/upload and per-drive storage were missing because the native
  monitoring payload was serialized in snake_case while the renderer expects
  camelCase. Only the single-word fields (CPU/GPU usage, name, cores) had
  matching names, so they were the only cards that rendered. The same missing
  `nowMs` also made the page drop every live sample after the first, freezing
  it on a stale reading.
- **App icons come back** — two separate defects: the extracted icon PNGs were
  written with the chunk CRC before the chunk type, so every icon was a
  malformed file the webview drew as a broken image; and the bitmaps behind an
  icon handle (which belong to the icon, not the caller) were being freed,
  corrupting the Windows shell icon cache and making later lookups fail.
- **Switching theme no longer kills the app** — a theme change used to destroy
  and rebuild the window to change its transparency class, tearing down the
  webview that issued the command (and with it the app). The window is now
  created once and the theme is applied in place.

### Changed

- **Native Windows title bar** — 1Boost uses the real system frame again, so
  window controls, snapping layouts and the taskbar preview behave normally.
- **Bigger window** — opens at 1360×880 (was 1200×760) with a 1040×680
  minimum, and the sidebar is a little wider.
- Icons are now re-read for apps first seen in an earlier session: the
  executable path is recorded per app, so an app's icon survives a restart
  instead of reverting to the generic glyph.
- The data file gains an optional `appPaths` map. Existing files keep loading
  unchanged (the field is ignored when absent, and older builds ignore it).

## [1.2.0] - 2026-09-30

### Changed

- **Tauri 2 migration** — 1Boost now runs on Tauri 2 with the system WebView2
  instead of Electron. The React UI, themes, features and the Rust monitoring
  layer are unchanged; the same `%APPDATA%\1Boost` data and settings files
  are picked up in place, and the app identity (`com.ahaduzzamankhan.oneboost`)
  and installer identity ("1Boost") are preserved.
- The Rust monitoring crate (`native/`) now links directly into the Tauri
  backend — no more koffi FFI, DLL loading or DataView struct offsets. The
  FFI exports and layout tests are kept for the migration window.
- Tracking, storage (atomic writes + rolling backups + corruption recovery),
  launch-at-login (same HKCU Run key, repairs stale Electron paths), tray,
  custom context menu, frameless titlebar (drag via the native API instead of
  `-webkit-app-region`) and the glass/solid theme window classes all moved
  into the Rust backend.
- Native Win11 rounded corners and minimize/restore animations are applied
  via DWM from Rust; solid themes get an opaque window (full native chrome),
  glass themes stay transparent with the CSS radius.

### Added

- **Signed delta-free updater** — updates ship through Tauri's signed updater
  (`latest.json` + minisign signature on GitHub Releases); stable installs
  never see prereleases and prerelease builds converge back to stable.
- Rust unit tests for day-key/civil-date math and the aggregation port; the
  TS suite still covers the same aggregation semantics.

### Breaking

- **One-time install** — the Tauri updater cannot update an app installed by
  a different framework, so users on 1.1.x install 1.2.0 once; data and
  settings carry over automatically. From 1.2.0 on, updates are automatic
  (v1.2.0 → v1.2.1 → …) with no manual step.

## [1.1.6] - 2026-09-30

### Fixed

- **Monitor layout** — cards no longer spill past the window edge: grid items
  shrink properly now and long strings (network adapter descriptions like
  "Realtek PCIe GbE Family Controller-WFP Native MAC Layer LightWeight
  Filter-0000", drive usage lines) ellipsize instead of forcing the columns
  wider than the page.
- **Smooth live graphs** — monitor charts draw smoothed, clamped Catmull-Rom
  curves instead of jagged polylines (the trend chart uses the same math, so
  curves stay on their samples and can never overshoot peaks).
- **Smoother app-wide animation** — page/modal/toast entrances use a soft
  ease-out curve instead of the snappy UI easing; still opacity-only, so the
  transparent-glass rendering stays stable.
- **Native rounded corners + window animations** — the frameless window now
  asks DWM for real Win11 rounded corners and re-enables the native
  minimize/restore animations. Solid themes (Solid Dark / Solid White /
  AMOLED) additionally get a normal opaque window — Windows only assigns
  transparency at creation, and opaque windows take the full native corner,
  shadow and animation treatment (glass themes keep the CSS radius, which DWM
  refuses on transparent windows). Switching between a glass and a solid
  theme rebuilds the window shell, preserving size and maximize state.

## [1.1.5] - 2026-09-29

### Fixed

- **Monitor keeps updating** — the native sampler now runs for the whole app
  session instead of only while a subscription round-trip is alive, so the
  page can no longer freeze on a single seed sample (CPU dash, 0 B/s, stuck
  values). A renderer-side watchdog additionally re-polls if pushes ever
  stall.
- **GPU usage** is the busiest engine, not the sum over all engines (multi-
  engine systems reported > 100%).

## [1.1.4] - 2026-09-29

### Fixed

- **Monitor** — opening the Monitor page now actually starts the native poll
  (the subscription IPC was missing, so only the one-shot seed sample ever
  arrived: CPU/graphs/network froze while memory looked alive).
- Temperatures and GPU usage reported as `-1` are now shown as *unavailable*
  instead of a literal `-1 °C` chip; the hottest thermal zone and busiest GPU
  engine are reported rather than a sum over all instances.
- **Windows 11** is detected correctly (registry `ProductName` still says
  "Windows 10" there; the build number ≥ 22000 is the truth).
- **Rounded corners** on the frameless window (collapse when maximized).
- **Corrupted animations** — page/modal/toast transitions are opacity-only, so
  they no longer tear or ghost above the transparent window's blur layer.
- Chart axis labels no longer clip (`4h 20m` rendered as `h 20m`).
- App User Model ID now matches the installer identity so notifications group
  under the right app.

### Added

- **Update prompt** — when an update finishes downloading, 1Boost shows an
  in-app prompt with **Restart now** / **Later** instead of a toast.
- **Delta updates** — NSIS builds ship differential packages
  (`*.exe.blockmap`); updates download only the changed blocks.
- **Official icons** — drop PNGs into the root `icons/` folder and
  `make-icons.js` embeds the right sizes into `icon.ico` / `tray.ico`
  automatically (procedural amber fallback otherwise). The in-app brand mark
  matches the artwork.

## [1.1.3] - 2026-09

### Added

- **Monitor page** — live CPU, memory, GPU, disk and network dashboards with
  real-time graphs, hardware temperatures where exposed, and per-drive storage
  bars, backed by the Rust `oneboost_native.dll` sampling layer (PDH,
  GetSystemTimes, GetIfTable). The renderer never polls: the main process
  pushes one update every 2 s while the page is open.
- Rounded corner tokens normalized across surfaces; dedicated two-column
  monitor card grid for narrow windows.

### Fixed

- Browser preview harness reported stale hard-coded versions ('1.0.0' /
  '1.1.1'); it now tracks the real app version.

## [1.1.2] - 2026-09

### Added

- **Update channels** — stable installs never auto-update to alpha/beta
  builds; beta installs return to the stable channel once a newer stable
  release exists.

### Fixed

- Transparency glitches: the glass themes composited a full-window blur plus a
  per-card blur every frame, causing black/white flicker bands. One blur layer
  remains.
- Removed a no-op assignment in the app-switch tracker and hidden `require()`
  calls; no white flash on window creation.

## [1.1.1] - 2026-09

### Added

- **Automatic updates** — background checks against GitHub Releases with
  auto-download and a manual *Check for updates* action with live progress.

### Fixed

- The "Launch at Windows startup" status reads the actual Windows Run key and
  reports the truth (with a one-click **Fix now** repair).

## [1.1.0] - 2026-09

### Added

- **Durable history** — rolling backups (`usage-data.json.bak0–2`) with
  automatic corruption recovery; sleep/lock/shutdown persist synchronously.
- **Reliable auto-start** — the login entry is re-asserted on every start,
  repairing stale paths after updates.
- **Fullscreen focus tracking** and **battery remaining** estimate on the
  dashboard.
