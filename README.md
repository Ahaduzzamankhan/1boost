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

1Boost pairs a tiny **Rust native layer** (`electron/native`) with an Electron
main-process orchestrator:

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
backups, automatic corruption recovery). Nothing ever leaves your machine.

## Development

```bash
npm install            # dependencies
npm run native:build   # compile the Rust tracking layer (requires cargo)
npm run build          # typecheck + build main, preload and renderer
npm start              # launch the app
npm test               # unit tests (aggregation, formatting, sessions)
```

Rebuild the native layer whenever `electron/native/src/lib.rs` changes. The
renderer can be rebuilt alone with `npm run build:renderer` — restart the app
to pick it up.

### Utilities

- `node scripts/make-icons.js` — regenerate `resources/icons/*.ico`
- `node scripts/cdp.mjs '<js>' [--console]` — evaluate JS in the running app
  (start it first with `npx electron . --remote-debugging-port=9222`)

## Releasing

Releases are automated with GitHub Actions (`.github/workflows/release.yml`):

1. Bump `version` in `package.json`.
2. Commit and tag: `git tag v1.2.0 && git push origin v1.2.0`.
3. The workflow runs TS + Rust tests, builds the Rust layer, packs the NSIS
   installer and publishes a GitHub Release with `1Boost-Setup-<version>.exe`.

Installed apps auto-update from the same Releases feed via electron-updater
(publishes `latest.yml` + blockmap alongside the installer). Release drafts are
created by CI and published automatically after the run.

The tag must match the `package.json` version (the workflow verifies it).

## Privacy

All tracking is local. No telemetry, no network calls, no accounts. Delete
everything at any time from **Settings → Data → Delete all data**.
