# 1Boost Design Skill

## Purpose

This file defines the complete visual and UX design system for **1Boost v1.0**.

Every screen, component, interaction, animation, chart, modal, menu, setting, and state in 1Boost must follow these specifications.

**Do not invent a different visual direction.**

1Boost should feel like a premium, modern Windows 11 desktop utility focused on PC usage analytics.

The design should communicate:

* Calm
* Precise
* Technical
* Lightweight
* Modern
* Professional
* Minimal
* Trustworthy

Avoid making the application look like gaming software, antivirus software, RGB software, or a generic admin dashboard.

---

# 1. Core Visual Direction

Primary style:

**Dark transparent glass UI + Windows 11-inspired desktop design + modern analytics dashboard.**

Visual characteristics:

* Transparent surfaces
* Backdrop blur
* Soft borders
* Subtle shadows
* Large rounded corners
* Clean typography
* Restrained accent colors
* Smooth micro-interactions
* Spacious layouts
* Minimal visual noise

Do NOT use:

* Neon cyberpunk styling
* Excessive gradients
* RGB effects
* Heavy glowing effects
* Excessive glass reflections
* Huge typography
* Cartoon illustrations
* Excessive rounded "bubble" UI
* Excessive cards
* Generic Bootstrap styling

---

# 2. Design Philosophy

The UI should prioritize information hierarchy.

The user should understand the dashboard within approximately 2–3 seconds.

Hierarchy:

1. Current usage
2. PC-on time
3. Active time
4. Usage graph
5. Application usage
6. Historical trends
7. Secondary statistics

Do not make every element visually loud.

Important information should have stronger contrast.

Secondary information should remain visually quiet.

---

# 3. Application Window

Recommended default size:

```text
Width: 1200px
Height: 760px
```

Minimum:

```text
Width: 900px
Height: 600px
```

The interface must remain usable when resized.

Use a custom application title bar rather than the default browser-looking title bar.

Window controls:

```text
Minimize
Maximize / Restore
Close
```

The controls should visually integrate with the application.

Do not make the title bar look like Chrome.

---

# 4. Global Layout

Desktop layout:

```text
┌───────────────────────────────────────────────────────┐
│  1Boost                              — □ ×             │
├───────────────┬───────────────────────────────────────┤
│               │                                       │
│   1Boost      │          Main Content                  │
│               │                                       │
│ Dashboard     │                                       │
│ Applications  │                                       │
│ Statistics    │                                       │
│ History       │                                       │
│               │                                       │
│               │                                       │
│               │                                       │
│ Settings      │                                       │
└───────────────┴───────────────────────────────────────┘
```

Sidebar width:

```text
220–240px
```

Main content:

```text
flex: 1
padding: 28–36px
```

Never allow the sidebar to consume excessive screen space.

---

# 5. Sidebar

The sidebar should be quiet and elegant.

Top:

```text
[1Boost icon]  1Boost
```

Navigation:

```text
⌂ Dashboard
▥ Applications
◔ Statistics
◷ History
```

Bottom:

```text
⚙ Settings
```

Use **Lucide Icons only**.

Icon size:

```text
18–20px
```

Navigation item height:

```text
40–44px
```

Navigation radius:

```text
10–12px
```

Active navigation item:

* Subtle background
* Slightly stronger text
* Accent icon
* No huge glowing effect

Hover:

* Slight surface change
* Smooth transition
* 120–180ms

---

# 6. Typography

Use a modern Windows-friendly sans-serif font.

Preferred:

```text
Inter
```

Fallback:

```text
Segoe UI
system-ui
sans-serif
```

Typography hierarchy:

### Page title

```text
28–32px
font-weight: 650–700
```

### Section title

```text
18–20px
font-weight: 600
```

### Card value

```text
26–34px
font-weight: 650
```

### Body

```text
14–15px
font-weight: 400–450
```

### Secondary text

```text
12–13px
```

Do not use extremely thin typography.

Do not use all-caps extensively.

---

# 7. Color System

The design must support five appearance modes.

## Theme 1 — Dark Transparent

Default theme.

Background:

```text
rgba(8, 10, 14, 0.72)
```

Surface:

```text
rgba(255, 255, 255, 0.055)
```

Border:

```text
rgba(255, 255, 255, 0.085)
```

Primary text:

```text
rgba(255, 255, 255, 0.94)
```

Secondary text:

```text
rgba(255, 255, 255, 0.60)
```

Muted:

```text
rgba(255, 255, 255, 0.40)
```

---

## Theme 2 — White Transparent

Background:

```text
rgba(245, 247, 250, 0.72)
```

Surface:

```text
rgba(255, 255, 255, 0.48)
```

Border:

```text
rgba(0, 0, 0, 0.08)
```

Primary text:

```text
rgba(10, 12, 16, 0.92)
```

Secondary text:

```text
rgba(10, 12, 16, 0.60)
```

---

# Theme 3 — Solid Dark

Background:

```text
#0A0C10
```

Surface:

```text
#11141A
```

Border:

```text
#242832
```

---

# Theme 4 — Solid White

Background:

```text
#F7F8FA
```

Surface:

```text
#FFFFFF
```

Border:

```text
#E2E5EA
```

---

# Theme 5 — AMOLED

Background:

```text
#000000
```

Surface:

```text
#050505
```

Border:

```text
#171717
```

The AMOLED theme must be genuinely deep black.

---

# 8. Accent Color

Users can customize the accent color.

The accent is used for:

* Active navigation
* Chart highlights
* Buttons
* Selected controls
* Progress indicators
* Important interactive states

Do not apply the accent color everywhere.

The accent should remain visually controlled.

Support a sensible default accent.

---

# 9. Glassmorphism

Glass should be subtle.

Use:

```text
backdrop-filter: blur(...)
```

where supported.

Recommended blur:

```text
16–28px
```

Glass surfaces should have:

* Transparency
* Blur
* Thin border
* Subtle shadow

Avoid extremely transparent surfaces where text becomes difficult to read.

Accessibility always takes priority over visual transparency.

---

# 10. Cards

Do not turn every piece of information into a card.

Use cards only when they improve grouping.

Card radius:

```text
14–18px
```

Card padding:

```text
18–24px
```

Card border:

```text
1px solid
```

Card shadow should be extremely subtle.

No giant floating shadows.

---

# 11. Dashboard

The dashboard is the primary screen.

Header:

```text
Good morning / Good afternoon / Good evening

Your PC usage today
```

Avoid overly personal or artificial wording.

Primary metrics:

```text
PC ON TIME
8h 42m

ACTIVE USAGE
6h 18m

IDLE TIME
2h 24m

APPS USED
17
```

Use a four-column layout on large screens.

On smaller window sizes, collapse gracefully.

---

# 12. Usage Graph

The main graph is the visual centerpiece.

Title:

```text
PC Usage
```

Controls:

```text
Today | 7 Days | 30 Days | All Time
```

The graph should be visually clean.

Requirements:

* Smooth curves or clean bars
* Subtle grid
* Clear labels
* Interactive tooltip
* Hover state
* Accurate data
* No visual clutter

Do not exaggerate the graph with bright colors.

The selected accent color should control the graph highlight.

---

# 13. Graph Tooltip

Tooltip example:

```text
September 28
14:00 – 15:00

Active
47 minutes
```

Tooltip style:

* Glass surface
* Small border
* Blur
* 10–12px radius
* 12–13px typography
* Subtle shadow

Tooltip must never obscure the graph excessively.

---

# 14. Application Usage

Application list:

```text
Application              Usage
──────────────────────────────────
[icon] Minecraft         3h 42m
[icon] Chrome            2h 15m
[icon] Zed               1h 36m
[icon] Discord             48m
```

Each row:

```text
56–64px height
```

Use application icons where reliably available.

If an icon cannot be retrieved, use a generic Lucide application icon.

Never show broken image placeholders.

---

# 15. Application Details

Clicking an application can show:

* Total usage
* Percentage of active time
* Usage by day
* Last used time
* Usage history

Keep this view simple.

Do not introduce unrelated application-management functionality.

---

# 16. Statistics Page

The Statistics page should focus on trends.

Sections:

```text
Average Daily Usage
Total Usage
Average Session
Longest Session
Most Used Application
```

Charts should answer useful questions rather than simply decorate the page.

Example:

```text
Daily Usage

Mon  ███████
Tue  █████████
Wed  █████
Thu  ██████████
Fri  ███████
```

Use consistent scales.

Do not distort data to make differences appear larger.

---

# 17. History Page

Use a chronological layout.

Example:

```text
September 28, 2026

8h 42m PC ON
6h 18m ACTIVE

Top Apps
Minecraft       3h 42m
Chrome          2h 15m
Zed             1h 36m
```

History should be easy to scan.

Use dividers rather than excessive cards.

---

# 18. Settings

Settings should use a modern settings layout.

Categories:

```text
Appearance
Startup
Tracking
Data
Accessibility
About
```

Only include settings that actually exist.

Controls:

* Toggle
* Dropdown
* Segmented control
* Color picker
* Slider

Avoid overly complex controls.

---

# 19. Theme Selector

Use visual theme previews.

Example:

```text
┌─────────┐ ┌─────────┐
│ Dark    │ │ White   │
│ Glass   │ │ Glass   │
└─────────┘ └─────────┘

┌─────────┐ ┌─────────┐
│ Solid   │ │ Solid   │
│ Dark    │ │ White   │
└─────────┘ └─────────┘

┌───────────────────┐
│      AMOLED       │
└───────────────────┘
```

The selected theme should have a clear indicator.

---

# 20. Transparency Slider

For transparent themes, provide:

```text
Transparency

Less transparent ───────●──── More transparent
```

Changes should update the interface immediately.

Do not allow transparency to reach a level where readability becomes poor.

---

# 21. Loading Screen

The first-launch loading screen should be minimal.

Centered:

```text
[1Boost Logo]

1Boost

Initializing usage tracking...
```

Animation:

* Logo fade
* Small progress indicator
* Subtle opacity transition

Do not use:

* Spinning 3D logos
* Particle effects
* Large animations
* Fake progress percentages

Startup should disappear immediately after initialization.

---

# 22. System Tray

The tray icon should be simple and recognizable.

Tray menu:

```text
1Boost

Open Dashboard

Pause Tracking

──────────────

Settings

Exit 1Boost
```

Use native-feeling menu behavior.

The tray should remain functional even when the main window is hidden.

---

# 23. Buttons

Primary button:

* Accent background
* High contrast text
* 10–12px radius

Secondary:

* Transparent/glass background
* Thin border

Ghost:

* No background
* Text/icon only

Button height:

```text
36–42px
```

Do not create giant buttons.

---

# 24. Toggles

Toggle dimensions:

```text
Width: 40px
Height: 22px
```

Animation:

```text
150–200ms
```

Use the user's accent color when enabled.

---

# 25. Context Menus

The default Electron/Chromium browser context menu must NOT appear.

Do not allow the application to look like Chrome when the user right-clicks.

Disable the default renderer context menu.

Only implement custom context menus where useful.

Custom menus should match the 1Boost design:

* Glass/dark surface
* Thin border
* Small radius
* Lucide icons
* Proper hover states

---

# 26. Animations

Animation should feel responsive, not flashy.

Recommended durations:

```text
Fast: 120ms
Normal: 180ms
Slow: 280ms
```

Use easing similar to:

```text
cubic-bezier(0.2, 0.8, 0.2, 1)
```

Animate:

* Page transitions
* Hover states
* Cards appearing
* Graph changes
* Theme changes
* Sidebar interactions
* Modals

Do NOT animate every element constantly.

---

# 27. Reduced Motion

Provide:

```text
Reduced Motion
```

When enabled:

* Disable decorative animations
* Reduce transitions
* Disable animated graph transitions where practical
* Keep functional feedback

Respect:

```text
prefers-reduced-motion
```

when available.

---

# 28. Empty States

Never leave blank screens.

Example:

```text
No usage history yet

1Boost hasn't collected enough data
to display statistics.

Your usage data will appear here automatically.
```

Use a subtle Lucide icon.

No cartoon illustrations.

---

# 29. Error States

Errors should be understandable.

Bad:

```text
ERR_JSON_PARSE_0x493
```

Better:

```text
Couldn't load usage history

Your history file could not be read.
1Boost will try to recover your data automatically.
```

Provide a relevant action if one exists.

---

# 30. Accessibility

Requirements:

* Strong text contrast
* Visible focus states
* Keyboard navigation
* Tooltips for unfamiliar icons
* Do not rely on color alone
* Respect reduced motion
* Minimum practical click target around 36px
* Charts should provide textual information through tooltips/statistics

Never sacrifice accessibility for transparency.

---

# 31. Responsive Desktop Behavior

Although 1Boost is a desktop application, the UI must respond to resizing.

At large widths:

```text
Sidebar + spacious dashboard
```

At medium widths:

```text
Sidebar + compact dashboard
```

At small supported widths:

```text
Reduced padding
Stack metric cards
Compress navigation where necessary
```

Never allow:

* Horizontal overflow
* Overlapping cards
* Cut-off text
* Broken charts

---

# 32. Icon System

Use **Lucide Icons exclusively** for interface icons.

Do not mix:

* Font Awesome
* Material Icons
* Emoji
* Random SVG icon packs

Recommended icons:

```text
LayoutDashboard
Grid2X2
ChartNoAxesCombined
History
Settings
Clock
Monitor
Activity
AppWindow
Database
Palette
Power
Play
Pause
Search
ChevronRight
ChevronDown
MoreHorizontal
X
Check
AlertCircle
Info
```

Use icons consistently.

---

# 33. Data Visualization Rules

Charts must represent actual data accurately.

Never:

* Invent values
* Exaggerate scales
* Hide important values
* Use misleading axes
* Add decorative fake data

When insufficient data exists, explicitly show that there isn't enough historical data yet.

---

# 34. Microinteractions

Examples:

Hovering a statistic:

```text
subtle surface increase
```

Hovering navigation:

```text
subtle background
```

Changing theme:

```text
smooth global transition
```

Opening a page:

```text
small fade + translate
```

Updating usage:

```text
smooth number transition
```

Keep all microinteractions subtle.

---

# 35. Design Tokens

Use centralized design tokens.

Example:

```css
--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 16px;
--radius-xl: 20px;

--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;

--transition-fast: 120ms;
--transition-normal: 180ms;
--transition-slow: 280ms;
```

Do not scatter arbitrary values throughout the UI.

---

# 36. Component Rules

Create reusable components rather than duplicating UI.

Recommended components:

```text
AppShell
Sidebar
TitleBar
MetricCard
UsageChart
AppUsageList
AppUsageRow
StatCard
DateRangeSelector
ThemeSelector
SettingRow
Toggle
Slider
Tooltip
Modal
EmptyState
ErrorState
LoadingScreen
TrayMenu
```

Components should have predictable APIs and consistent styling.

---

# 37. Visual Consistency

Every page must look like part of the same application.

Maintain:

* Same spacing system
* Same border system
* Same typography
* Same corner radius
* Same icon size
* Same animation timing
* Same color tokens
* Same button styles

Do not redesign components differently on each page.

---

# 38. Final Design Rule

When deciding between:

**more visual effects**

and

**better clarity**

always choose **better clarity**.

When deciding between:

**more features on screen**

and

**less visual clutter**

choose **less visual clutter**.

When deciding between:

**a flashy animation**

and

**a fast interface**

choose **a fast interface**.

1Boost should look like a product that was carefully designed by a professional desktop software team.

The final design should be:

**Minimal + Transparent + Modern + Data-focused + Windows 11-native feeling + Lightweight.**

Do not deviate from this design language.
