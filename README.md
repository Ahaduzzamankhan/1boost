# 1Boost

<div align="center">

<img src="https://raw.githubusercontent.com/Ahaduzzamankhan/1boost/main/src-tauri/icons/128x128.png" width="112" alt="1Boost icon">

# 1Boost

**A fast, private PC usage analytics & system monitoring app for Windows.**

Track your screen time, active usage, applications, hardware activity, and daily trends — **locally on your own PC.**

<br>

[![Version](https://img.shields.io/github/package-json/v/Ahaduzzamankhan/1boost?style=for-the-badge&label=version)](https://github.com/Ahaduzzamankhan/1boost/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/Ahaduzzamankhan/1boost/release.yml?style=for-the-badge&label=build)](https://github.com/Ahaduzzamankhan/1boost/actions)
[![Release](https://img.shields.io/github/v/release/Ahaduzzamankhan/1boost?style=for-the-badge)](https://github.com/Ahaduzzamankhan/1boost/releases/latest)
[![License](https://img.shields.io/github/license/Ahaduzzamankhan/1boost?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Ahaduzzamankhan/1boost)

</div>

---

## ✦ What is 1Boost?

**1Boost** is a lightweight Windows desktop app that helps you understand how you use your PC.

It records usage **locally**, turns raw activity into useful daily statistics, and combines that with real-time hardware monitoring — without accounts, telemetry, or cloud tracking.

> **Your usage data stays on your machine.**

### At a glance

| | |
|---|---|
| 🖥️ **PC Usage** | PC-on, active, idle and session tracking |
| 📊 **Analytics** | Daily, weekly and historical usage trends |
| 🧩 **Applications** | Per-application usage and breakdowns |
| ⚡ **Monitor** | CPU, RAM, GPU, disk and network activity |
| 🌡️ **Hardware** | Temperatures when Windows exposes a real sensor |
| 📝 **Pages** | Block editor, nested pages, backlinks, task blocks |
| ✅ **Tasks** | Status, priority, projects, subtasks, list/board/calendar |
| 🔗 **One workspace** | Tasks belong to projects and pages; the dashboard ties both to your time |
| 🎨 **Custom CSS** | Optional, isolated, documented variables |
| 🔄 **Updater** | Signed automatic updates with differential packages |
| 💾 **Local-first** | No accounts, telemetry or cloud database |
| 🦀 **Rust-powered** | Native monitoring and tracking layer |

---

## 🖼️ 1Boost

<div align="center">

<img src="https://raw.githubusercontent.com/Ahaduzzamankhan/1boost/main/icons/Screenshot%202026-10-01%20125910.png" alt="1Boost GitHub preview" width="900">

</div>

---

## 🚀 Features

### 🏠 Dashboard
The central overview: what you owe today, what is coming, what you have been
working on, and whether the machine is healthy.

- Quick actions: search, new page, new project, tasks, live system view
- Today's tasks, completable in place, with an overdue count
- Upcoming tasks for the next seven days
- Recent pages, and active projects with their progress
- PC-on, active and idle time
- Today's top applications, each opening its own detail view
- 7/30-day and all-time usage trends
- Fullscreen focus tracking and battery estimate
- Live system strip (CPU, memory, tightest drive)
- Keyboard shortcut reference

### 🔎 Search
One field for everything, from `Ctrl+K` or the Search module.

- Pages, projects, tasks, calendar items and tracked applications
- Grouped by kind, with the matched text highlighted
- Filter chips for All / Projects / Pages / Tasks / Calendar / Apps
- Full keyboard control: `/` to focus, `↑` `↓` to move, `Enter` to open,
  `Tab` to change filter, `Esc` to clear
- An empty query shows what you touched most recently and what is coming up
- Pages, projects and tasks are ranked locally against the cache the app
  already holds, so results appear on the same frame as the keystroke

### ⌨️ Command center
`Ctrl+K` — the fastest path to anything in 1Boost, without the mouse.

- Create a page, a project, or a task from what you typed
- Jump to any module, reopen recent pages and projects
- Quick capture, today's tasks, pause tracking, settings
- `Tab` cycles the filter, `>` jumps to Tasks

### 📝 Pages
A block editor rather than a textarea, over a tree of pages.

- Blocks: headings, paragraphs, bulleted and numbered lists, to-dos, quotes,
  callouts, code, dividers and images
- Nested blocks and nested pages, with breadcrumbs
- Slash menu and markdown shortcuts (`#`, `-`, `1.`, `[]`, `>`, ` ``` `, `---`)
- Drag to reorder; multi-block select for move, nest, duplicate and delete
- Undo/redo, and autosave with `Ctrl+S` to flush
- Favourites, recents, search and backlinks
- Task blocks and page blocks that reference the rest of the workspace
- Any page can be flagged as a **project** — a page that owns tasks and its
  sub-pages — with its progress shown in the editor, the tree and the dashboard

### ✅ Tasks
- Status (to do, in progress, blocked, done), priority and due dates
- Tags, subtasks, projects, blocked-by relations
- Recurrence: daily, weekdays, weekly or monthly
- List, board and calendar views
- Filter by status, project and tag; sort four ways
- Quick create with `Enter`; press `N` to jump to it from anywhere
- Each row links to its project and its source page

### 🧩 Application analytics
- All-time per-app usage
- Daily application breakdown
- Usage history
- Chronological activity records

### 🖥️ System Monitor
Real-time native monitoring for CPU, memory, GPU, disk, network, temperatures where available, storage and live graphs.

### 🎨 Customization
Black, white and grayscale by default.

- Five themes: Dark Glass, White Glass, Solid Dark, Solid White and AMOLED
- Transparency control and reduced motion
- Rounded desktop window
- **Optional custom CSS** — every supported variable and component class is
  listed in Settings. Your stylesheet is applied after the app's own, inside a
  single isolated element, and clearing it restores the default completely.
  Remote loads and anything executable are stripped, and a rule that would
  hide the whole application is refused (hiding any ordinary part of the UI is
  still fine).

### 💾 Your data
- Everything stays on the machine, in plain JSON.
- Pages, tasks and clipboard history are written atomically and keep their
  previous version as a `.bak`, so a file that cannot be read is recovered
  rather than silently emptied.
- Export usage data, or export and re-import the whole workspace. Import
  merges, so it can only add work and never overwrite anything.

### 🔄 Modern updater
Signed Tauri updates, GitHub Releases integration, background downloads and differential NSIS packages.

---

## 🧠 Architecture

```text
┌──────────────────────────────────────────┐
│              1Boost Desktop              │
├──────────────────────────────────────────┤
│          React + TypeScript UI           │
├──────────────────────────────────────────┤
│                  Tauri 2                 │
│          Commands • Events • Updater     │
├──────────────────────────────────────────┤
│                 Rust Core                │
│   Usage • Sessions • System Monitoring   │
├──────────────────────────────────────────┤
│              Windows APIs                │
└──────────────────────────────────────────┘
```

---

## 🔒 Privacy first

1Boost is designed around local data ownership.

- No account required
- No telemetry
- No cloud database
- No usage data uploaded
- Local JSON storage
- Atomic writes
- Rolling backups
- Automatic corruption recovery
- Delete your data whenever you want

Data is stored at:

```text
%APPDATA%/1Boost/usage-data.json
```

---

## ⚡ Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | **Tauri 2** |
| UI | **React 19 + TypeScript** |
| Native core | **Rust** |
| Testing | **Vitest + Rust tests** |
| Installer | **NSIS x64** |
| Updates | **Tauri Updater + GitHub Releases** |
| Monitoring | **Windows native APIs** |

---

## 📦 Installation

**[→ Download the latest 1Boost release](https://github.com/Ahaduzzamankhan/1boost/releases/latest)**

The installer uses the current-user installation mode.

**Prereleases.** `v2.0.0-alpha.1` is published as a
[prerelease](https://github.com/Ahaduzzamankhan/1boost/releases), so installs on
the stable line are never offered it by the updater — download it from the
releases page to try the 2.0 workspace.

---

## 🛠️ Development

```bash
git clone https://github.com/Ahaduzzamankhan/1boost.git
cd 1boost
npm install

npm run native:build
npm run build:renderer
npm run tauri:dev
```

Checks:

```bash
npm run typecheck
npm test
npm run rust:test
```

Production:

```bash
npm run tauri:build
```

---

## 🔄 Release flow

1. Update the application version (`package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`) and cut the matching `CHANGELOG.md` section.
2. Build and test the native + frontend layers.
3. Create a version tag — `v2.0.0-alpha.1` style for an alpha/beta. A tag whose
   suffix is `alpha`/`beta` is published as a GitHub prerelease, which keeps it
   away from installs on the stable line.
4. GitHub Actions builds the Windows installer.
5. Update artifacts are signed.
6. GitHub Release publishes the installer and updater metadata.
7. Installed clients can detect and download updates automatically.

---

## 🗺️ Project status

**Current version: 2.0.0-alpha.1** (prerelease · stable line: 1.3.2)

- [x] Usage tracking
- [x] Application tracking
- [x] Statistics
- [x] History
- [x] System monitoring
- [x] Rust native layer
- [x] Tauri 2 migration
- [x] Automatic updates
- [x] Differential updates
- [x] Signed updater
- [x] Local data recovery
- [x] Connected workspace (pages, projects, tasks)
- [x] Global search
- [x] Command center (Ctrl+K)
- [ ] More advanced analytics
- [ ] More monitoring metrics
- [ ] Further performance optimization

---

<div align="center">

**Built for Windows · Powered by Rust · Designed for focus**

[⭐ Star](https://github.com/Ahaduzzamankhan/1boost) · [🐛 Issues](https://github.com/Ahaduzzamankhan/1boost/issues) · [🚀 Releases](https://github.com/Ahaduzzamankhan/1boost/releases)

### 1Boost
**Know your PC. Understand your time.**

</div>
