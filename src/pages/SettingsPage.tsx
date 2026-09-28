import { useState } from 'react'
import {
  Palette,
  Power,
  Activity,
  Database,
  Accessibility,
  Info,
  Check,
  Download,
  Trash2,
  FolderOpen,
} from 'lucide-react'
import type { AccentId, Prefs, ThemeId } from '../../shared/types'
import { bridge, ACCENT_HEX } from '../bridge'
import { Slider, Toggle } from '../components/ui'

const THEMES: { id: ThemeId; name: string; preview: { bg: string; bar: string; card: string; glass: boolean } }[] = [
  {
    id: 'dark-glass',
    name: 'Dark Glass',
    preview: { bg: 'rgba(8,10,14,0.72)', bar: 'rgba(255,255,255,0.12)', card: 'rgba(255,255,255,0.08)', glass: true },
  },
  {
    id: 'white-glass',
    name: 'White Glass',
    preview: { bg: 'rgba(245,247,250,0.72)', bar: 'rgba(0,0,0,0.12)', card: 'rgba(255,255,255,0.55)', glass: true },
  },
  {
    id: 'solid-dark',
    name: 'Solid Dark',
    preview: { bg: '#0A0C10', bar: '#242832', card: '#11141A', glass: false },
  },
  {
    id: 'solid-white',
    name: 'Solid White',
    preview: { bg: '#F7F8FA', bar: '#E2E5EA', card: '#FFFFFF', glass: false },
  },
  {
    id: 'amoled',
    name: 'AMOLED',
    preview: { bg: '#000000', bar: '#171717', card: '#050505', glass: false },
  },
]

const ACCENTS: { id: AccentId; name: string }[] = [
  { id: 'blue', name: 'Blue' },
  { id: 'violet', name: 'Violet' },
  { id: 'teal', name: 'Teal' },
  { id: 'green', name: 'Green' },
  { id: 'amber', name: 'Amber' },
  { id: 'rose', name: 'Rose' },
  { id: 'sky', name: 'Sky' },
  { id: 'crimson', name: 'Crimson' },
]

export default function SettingsPage({
  prefs,
  setPref,
  storage,
  onDelete,
}: {
  prefs: Prefs
  setPref: (key: keyof Prefs, value: string | number | boolean) => Promise<void>
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean } | null
  onDelete: () => Promise<void>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exporting, setExporting] = useState(false)

  const isGlass = prefs.theme === 'dark-glass' || prefs.theme === 'white-glass'

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Make 1Boost yours</p>

      {/* Appearance */}
      <section className="settings-section" style={{ marginTop: 24 }}>
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Palette size={18} /> Appearance
        </div>
        <div className="card">
          <div className="setting-row" style={{ display: 'block' }}>
            <div className="setting-info" style={{ marginBottom: 12 }}>
              <div className="setting-title">Theme</div>
              <div className="setting-desc">Transparent themes blur the window behind 1Boost.</div>
            </div>
            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-card${prefs.theme === t.id ? ' selected' : ''}`}
                  onClick={() => void setPref('theme', t.id)}
                  aria-pressed={prefs.theme === t.id}
                >
                  <div
                    className="theme-preview"
                    style={{ background: t.preview.bg, border: `1px solid ${t.preview.bar}` }}
                  >
                    <div className="tp-bar" style={{ background: t.preview.bar }} />
                    <div className="tp-card" style={{ background: t.preview.card }} />
                    <div className="tp-card2" style={{ background: t.preview.card }} />
                  </div>
                  <div className="theme-name">
                    {prefs.theme === t.id ? <Check size={14} color="var(--accent)" /> : null}
                    {t.name}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Accent color</div>
              <div className="setting-desc">Used for highlights, charts and controls.</div>
            </div>
            <div className="swatch-grid">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  className={`swatch${prefs.accent === a.id ? ' selected' : ''}`}
                  style={{ background: 'var(--surface)' }}
                  onClick={() => void setPref('accent', a.id)}
                  aria-label={`Accent ${a.name}`}
                  aria-pressed={prefs.accent === a.id}
                >
                  <span style={{ background: ACCENT_HEX[a.id] }} />
                </button>
              ))}
            </div>
          </div>

          {isGlass ? (
            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-title">Transparency</div>
                <div className="setting-desc">Controls how see-through the window is.</div>
              </div>
              <div style={{ width: 260, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="app-meta">Less</span>
                <Slider
                  ariaLabel="Transparency"
                  value={Math.round((1 - prefs.transparency) * 100)}
                  min={0}
                  max={60}
                  step={1}
                  onChange={(v) => void setPref('transparency', 1 - v / 100)}
                />
                <span className="app-meta">More</span>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* Startup */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Power size={18} /> Startup
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Launch at Windows startup</div>
              <div className="setting-desc">Keep 1Boost running from sign-in so tracking is continuous.</div>
            </div>
            <Toggle checked={prefs.launchAtLogin} onChange={(v) => void setPref('launchAtLogin', v)} label="Launch at startup" />
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Start minimized</div>
              <div className="setting-desc">Open silently to the tray at startup.</div>
            </div>
            <Toggle checked={prefs.startMinimized} onChange={(v) => void setPref('startMinimized', v)} label="Start minimized" />
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Show tray icon</div>
              <div className="setting-desc">Quick access to pause and exit from the taskbar corner.</div>
            </div>
            <Toggle checked={prefs.showTray} onChange={(v) => void setPref('showTray', v)} label="Show tray icon" />
          </div>
        </div>
      </section>

      {/* Tracking */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Activity size={18} /> Tracking
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Pause tracking</div>
              <div className="setting-desc">Temporarily stop collecting usage data.</div>
            </div>
            <Toggle checked={prefs.pauseTracking} onChange={(v) => void setPref('pauseTracking', v)} label="Pause tracking" />
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Idle threshold</div>
              <div className="setting-desc">After this many minutes without input, time counts as idle.</div>
            </div>
            <div style={{ width: 260 }}>
              <Slider
                ariaLabel="Idle threshold in minutes"
                value={prefs.idleThresholdMin}
                min={1}
                max={30}
                step={1}
                onChange={(v) => void setPref('idleThresholdMin', v)}
              />
              <div className="app-meta" style={{ textAlign: 'right' }}>{prefs.idleThresholdMin} min</div>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Keep history for</div>
              <div className="setting-desc">Older days are removed automatically.</div>
            </div>
            <div style={{ width: 260 }}>
              <Slider
                ariaLabel="History retention in days"
                value={prefs.keepHistoryDays}
                min={30}
                max={730}
                step={5}
                onChange={(v) => void setPref('keepHistoryDays', v)}
              />
              <div className="app-meta" style={{ textAlign: 'right' }}>{prefs.keepHistoryDays} days</div>
            </div>
          </div>
        </div>
      </section>

      {/* Data */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Database size={18} /> Data
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Export data</div>
              <div className="setting-desc">Save all recorded usage as a JSON file.</div>
            </div>
            <button
              className="btn btn-secondary"
              disabled={exporting}
              onClick={async () => {
                setExporting(true)
                try {
                  await bridge.exportJson()
                } finally {
                  setExporting(false)
                }
              }}
            >
              <Download size={15} /> Export JSON
            </button>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Data file</div>
              <div className="setting-desc selectable">{storage?.file ?? '—'}</div>
            </div>
            <button className="btn btn-secondary" onClick={() => void bridge.openDataFolder()}>
              <FolderOpen size={15} /> Open folder
            </button>
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Delete all data</div>
              <div className="setting-desc">Permanently remove every recorded day. Cannot be undone.</div>
            </div>
            {confirmDelete ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    setConfirmDelete(false)
                    void onDelete()
                  }}
                >
                  Confirm delete
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} /> Delete…
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Accessibility */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Accessibility size={18} /> Accessibility
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Reduced motion</div>
              <div className="setting-desc">Minimize animations across the interface.</div>
            </div>
            <Toggle checked={prefs.reducedMotion} onChange={(v) => void setPref('reducedMotion', v)} label="Reduced motion" />
          </div>
        </div>
      </section>

      {/* About */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Info size={18} /> About
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">1Boost v1.0.0</div>
              <div className="setting-desc">
                PC usage analytics for Windows. All data stays on this device.
              </div>
            </div>
            <div className="app-meta">Windows</div>
          </div>
        </div>
      </section>
    </div>
  )
}
