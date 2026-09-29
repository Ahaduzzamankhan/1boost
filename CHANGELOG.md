# Changelog

All notable changes to 1Boost are documented here. The latest release's
section is injected into the GitHub Release body by CI
(`scripts/release-notes.mjs`).

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
