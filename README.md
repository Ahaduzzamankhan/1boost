# 1Boost

**1Boost** is a PC usage analytics application for Windows. It quietly tracks how
long your PC is on, how much of that time you were actively using it, which
applications you focused, and how usage trends over days and weeks — all stored
locally on your device.

## Features

- **Dashboard** — PC-on time, active usage, idle time, and apps used today, with
  a 7/30-day usage graph and today's top applications.
- **Applications** — all-time per-app usage with per-day breakdowns.
- **Statistics** — averages, longest session, daily bars, and weekday patterns.
- **History** — a chronological, scannable log of every recorded day.
- **Settings** — five themes (Dark Glass, White Glass, Solid Dark, Solid White,
  AMOLED), 8 accent colors, transparency slider, launch-at-startup, pause
  tracking, idle threshold, history retention, data export/delete, and reduced
  motion.
- **Monitor** (v1.1.4) — live CPU, memory, GPU, disk and network dashboards
  with real-time graphs, temperatures where the hardware exposes them, and
  per-drive storage bars.

### New in v1.2.0

- **Tauri 2** — the app shell migrated from Electron to Tauri 2 with a much
  smaller footprint: the WebView2-based binary is a fraction of the old
  Electron package, starts faster, and keeps the exact same UI. The Rust
  tracking/monitoring layer is now linked directly into the backend (no more
  separate DLL sidecar + FFI bridge).
- **Seamless data migration** — data paths, file formats, schema and the
  registry Run-key entry are byte-compatible with the Electron build, so
  installing the Tauri version keeps your history and settings in place.
- **Signed auto-updates** via the Tauri updater on GitHub Releases
  (`latest.json` + minisign signatures).
- Same feature set otherwise: dashboard, apps, statistics, history, monitor,
  themes, tray, launch-at-login, and all v1.1.6 fixes.

### New in v1.1.4

- **Monitor fixed** — opening the Monitor page now actually starts the native
  poll (the subscription IPC was missing, so only the one-shot seed sample ever
  arrived: CPU/graphs/network froze while memory looked alive). Unavailable
  temperatures and GPU usage no longer render as literal `-1` chips, and the
  hottest thermal zone / busiest GPU engine is reported instead of a sum of
  all instances.
- **Windows 11 detected correctly** — the Monitor header no longer claims
  "Windows 10" on Windows 11 (the registry ProductName is still "Windows 10"
  there; the build number is the truth, ≥ 22000 = Windows 11).
- **Rounded corners + stable animations** — the frameless window now gets a
  real rounded shell (collapses when maximized), and the page/modal/toast
  transitions no longer animate transforms above the blur layer, which caused
  corrupted/torn frames on transparent windows.
- **Update prompt** — when an update finishes downloading, 1Boost shows an
  in-app prompt with **Restart now** / **Later** instead of a toast.
- **Delta updates** — NSIS builds ship differential packages so updates only
  download changed blocks.
- **Official icons** — drop the official PNG(s) into a root `icons/` folder;
  `make-icons.js` embeds the largest one into `icon.ico`/`tray.ico`
  automatically (procedural amber fallback otherwise), and the in-app brand
  mark uses the same artwork style.
- Chart axis labels no longer clip ("4h 20m" rendered as "h 20m"), per-day
  labels use local dates, and the App User Model ID matches the installer
  identity so notifications group correctly.

- **System monitoring** — a new Monitor page shows CPU usage, RAM, GPU,
  disk activity (read/write speeds), and network throughput, each with a
  real-time graph of the last ~2 minutes. Temperatures appear when the
  hardware exposes a sensor and are shown as unavailable otherwise — never
  guessed.
- **Native Rust monitoring layer** — all sampling happens in
  `oneboost_native.dll` via Windows performance APIs (PDH, GetSystemTimes,
  GetIfTable), exposed through one compact FFI snapshot. The renderer never
  polls: the main process pushes one IPC update every 2 s while the Monitor
  page is open, and the poll timer stops entirely when nobody is listening.
- **UI polish** — rounded corners normalized onto the design-token radii
  across surfaces, and a dedicated two-column monitor card grid that adapts
  to narrow windows.
- Bug fixes: the browser preview harness reported stale hard-coded versions
  ('1.0.0' / '1.1.1'); it now tracks the real app version.

### New in v1.1.2

- **Update channels** — stable installs are never auto-updated to alpha/beta
  builds; they only follow stable releases. Installs from an alpha/beta tag
  watch the beta channel and automatically return to the stable channel as
  soon as a newer stable release exists.
- **Transparency glitches fixed** — the glass themes composited a full-window
  blur plus a per-card blur every frame, causing black/white flicker bands.
  The window is now natively transparent with a single blur layer.
- Assorted cleanups: removed a no-op assignment in the app-switch tracker,
  replaced hidden `require()` calls with static imports, and a no-white-flash
  window background.

### New in v1.1.1

- **Automatic updates** — 1Boost checks GitHub Releases in the background,
  downloads new versions automatically, and asks before restarting to install
  (**Settings → Updates**, with a manual *Check for updates* action and live
  download progress).
- **Fixed startup status** — the "Launch at Windows startup" status now reads
  the actual Windows Run key, so it reports the truth (and "Fix now" repairs
  it) instead of showing a false "Windows is not starting 1Boost yet".

### New in v1.1.0

- **Durable history** — every save is followed by rolling backups
  (`usage-data.json.bak0–2`); if the data file is ever damaged, 1Boost restores
  the newest good backup automatically instead of starting over. Sleep, lock
  and shutdown now persist synchronously so Windows can't cut the write off.
- **Reliable auto-start** — the launch-at-login entry is re-asserted on every
  app start (repairing stale paths after updates) and Settings shows live
  Windows status with a one-click **Fix now** repair action.
- **Fullscreen focus tracking (Rust)** — the native layer detects when the
  foreground window covers its monitor (games, films) and the dashboard shows
  your fullscreen focus time for the day.
- **Battery estimate** — the dashboard shows remaining battery time reported
  by Windows while unplugged.

## How tracking works

1Boost pairs a tiny **Rust native layer** (`native/`) with a **Tauri 2**
backend (`src-tauri/`):

- A native event-pump thread receives **Windows power broadcasts** (sleep,
  resume), **power-setting notifications** (display on/off), and **session
  notifications** (lock/unlock/logoff).
- A ~1.2 s sample loop reads the **foreground application**, **keyboard/mouse
  idle time**, battery state, and console lock state.
- Samples are folded into per-day buckets (active/idle/PC-on/per-app usage),
  and sessions are cut on sleep/lock/shutdown so averages stay honest.
- **Uptime-gap analysis** catches suspends even if a broadcast is missed, and
  unaccounted gaps are never counted as usage.

Data lives in `%APPDATA%/1Boost/usage-data.json` (atomic writes, rolling
backups, automatic corruption recovery) — the same location and format the
original Electron build used, so existing installs keep their history and
preferences when upgrading to the Tauri version. Nothing ever leaves your
machine.

## Development

```bash
npm install                 # dependencies (Tauri CLI + renderer toolchain)
npm run native:build        # compile the Rust tracking layer (requires cargo)
npm run build:renderer      # build the React UI into dist/
npm run tauri:dev           # run the desktop app in dev mode
npm run typecheck && npm test   # typecheck + unit tests (aggregation, formatting, sessions)
```

The packaged build is `npm run tauri:build` (Windows NSIS x64 installer,
signed update artifacts when `TAURI_SIGNING_PRIVATE_KEY` is set). Regenerate
Tauri icons after changing artwork with `npm run icons:tauri`.

`legacy/aggregator.ts` keeps the original TypeScript aggregation logic and
data-shape constants, used by the unit tests and as a reference for the Rust
port in `src-tauri/`.

## Releasing

Releases are automated with GitHub Actions (`.github/workflows/release.yml`)
using [tauri-action](https://github.com/tauri-apps/tauri-action):

1. Bump `version` in `package.json` **and** `src-tauri/tauri.conf.json`.
2. Commit and tag: `git tag v1.2.0 && git push origin v1.2.0`.
3. The workflow builds the Rust layer + NSIS x64 installer, signs the update
   bundle with `TAURI_SIGNING_PRIVATE_KEY`, and publishes a GitHub Release
   with `1Boost-Setup-<version>-x64-setup.exe` (+ `.sig`) and a generated
   `latest.json`.

Installed apps auto-update from the same Releases feed via the Tauri updater
(`plugins.updater` endpoint in `tauri.conf.json`). Secrets required by CI:
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the
matching minisign **public** key must be set in `tauri.conf.json` →
`plugins.updater.pubkey`.

The tag must match the `tauri.conf.json` version (the workflow verifies it).

## Privacy

All tracking is local. No telemetry, no network calls, no accounts. Delete
everything at any time from **Settings → Data → Delete all data**.
