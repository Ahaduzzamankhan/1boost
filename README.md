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

### 📈 Dashboard
- PC-on time
- Active usage
- Idle time
- Today's top applications
- 7/30-day usage trends
- Fullscreen focus tracking
- Battery time estimate

### 🧩 Application analytics
- All-time per-app usage
- Daily application breakdown
- Usage history
- Chronological activity records

### 🖥️ System Monitor
Real-time native monitoring for CPU, memory, GPU, disk, network, temperatures where available, storage and live graphs.

### 🎨 Customization
- Dark Glass
- White Glass
- Solid Dark
- Solid White
- AMOLED
- Multiple accent colors
- Transparency control
- Reduced motion
- Rounded desktop window

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

1. Update the application version.
2. Build and test the native + frontend layers.
3. Create a version tag.
4. GitHub Actions builds the Windows installer.
5. Update artifacts are signed.
6. GitHub Release publishes the installer and updater metadata.
7. Installed clients can detect and download updates automatically.

---

## 🗺️ Project status

**Current version: 1.3.2**

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
