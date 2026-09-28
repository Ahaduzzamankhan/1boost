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

Data lives in `%APPDATA%/1Boost/usage-data.json` (atomic writes, automatic
corruption recovery). Nothing ever leaves your machine.

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

## Privacy

All tracking is local. No telemetry, no network calls, no accounts. Delete
everything at any time from **Settings → Data → Delete all data**.
