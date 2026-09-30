# Changelog

All notable changes to 1Boost are documented here. The latest release's
section is injected into the GitHub Release body by CI
(`scripts/release-notes.mjs`).

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
