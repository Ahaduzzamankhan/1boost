import { useCallback, useEffect, useState } from 'react'
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
  Wrench,
  AlertCircle,
  RefreshCw,
  RotateCcw,
  CheckCircle2,
  FlaskConical,
} from 'lucide-react'
import type { AccentId, AiStatus, LaunchState, Prefs, ThemeId, UpdateState } from '../../shared/types'
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
  version,
}: {
  prefs: Prefs
  setPref: (key: keyof Prefs, value: string | number | boolean) => Promise<void>
  storage: { file: string; bytes: number; recovered: boolean; healthy: boolean } | null
  onDelete: () => Promise<void>
  version: string
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<{
    ok: boolean
    path?: string
    canceled?: boolean
    error?: string
  } | null>(null)
  const [launch, setLaunch] = useState<LaunchState | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [rollbackNote, setRollbackNote] = useState<string | null>(null)
  // The experimental assistant. `null` means the build has no ai_* commands at
  // all (compiled without the cargo feature), which is different from "off".
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [cookie, setCookie] = useState('')
  const [aiNote, setAiNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [savingCookie, setSavingCookie] = useState(false)

  const refreshAi = useCallback(async () => {
    try {
      setAi(await bridge.aiStatus())
    } catch {
      setAi(null)
    }
  }, [])

  useEffect(() => {
    void refreshAi()
  }, [refreshAi, prefs.experimentalAi])

  const refreshLaunch = useCallback(async () => {
    try {
      const data = await bridge.getSettingsData()
      setLaunch(data.launch)
    } catch {
      setLaunch(null)
    }
  }, [])

  useEffect(() => {
    void refreshLaunch()
  }, [refreshLaunch, prefs.launchAtLogin])

  const repairLaunch = useCallback(async () => {
    setRepairing(true)
    try {
      const state = await bridge.repairLaunch()
      setLaunch(state)
    } finally {
      setRepairing(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    bridge
      .getUpdateState()
      .then((s) => alive && setUpdate(s))
      .catch(() => {})
    const off = bridge.onUpdateState((s) => {
      if (alive) setUpdate(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const runUpdateCheck = useCallback(async () => {
    setChecking(true)
    try {
      const s = await bridge.checkForUpdates()
      setUpdate(s)
    } finally {
      setChecking(false)
    }
  }, [])

  const runRollback = useCallback(async () => {
    setRollingBack(true)
    setRollbackNote(null)
    try {
      const res = await bridge.rollbackUpdate()
      if (res.error) setRollbackNote(`Rollback failed: ${res.error}`)
      else if (res.version) setRollbackNote(`Reinstalling ${res.version}…`)
      else setRollbackNote('No older version is cached on this machine yet.')
    } catch {
      setRollbackNote('Rollback failed.')
    } finally {
      setRollingBack(false)
    }
  }, [])

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
              {prefs.launchAtLogin && launch ? (
                <div className="setting-desc" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {launch.registered && launch.pathMatches ? (
                    <>
                      <Check size={13} color="#22c55e" /> Active — starts when you sign in
                    </>
                  ) : (
                    <>
                      <AlertCircle size={13} color="#f59e0b" /> Windows is not starting 1Boost yet
                      <button
                        className="btn btn-ghost"
                        style={{ height: 26, fontSize: 12, padding: '0 8px', marginLeft: 4 }}
                        onClick={() => void repairLaunch()}
                        disabled={repairing}
                      >
                        <Wrench size={12} /> {repairing ? 'Fixing…' : 'Fix now'}
                      </button>
                    </>
                  )}
                </div>
              ) : null}
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
                setExportResult(null)
                try {
                  // The result used to be dropped on the floor, which is why
                  // this button looked broken no matter what it did.
                  const res = await bridge.exportJson()
                  setExportResult(res)
                } catch (e) {
                  setExportResult({
                    ok: false,
                    error: e instanceof Error ? e.message : 'The export could not be started.',
                  })
                } finally {
                  setExporting(false)
                }
              }}
            >
              <Download size={15} /> {exporting ? 'Exporting…' : 'Export JSON'}
            </button>
          </div>
          {exportResult ? (
            <div className={`setting-note${exportResult.ok ? ' ok' : ' bad'}`} role="status">
              {exportResult.ok ? (
                <>
                  <CheckCircle2 size={14} />
                  <span className="selectable grow">Exported to {exportResult.path}</span>
                  {exportResult.path ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => void bridge.openFile(exportResult.path as string, true)}
                    >
                      <FolderOpen size={14} /> Show
                    </button>
                  ) : null}
                </>
              ) : exportResult.canceled ? (
                <span className="muted">Export canceled.</span>
              ) : (
                <>
                  <AlertCircle size={14} />
                  <span className="grow">{exportResult.error ?? 'The export failed.'}</span>
                </>
              )}
            </div>
          ) : null}
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

      {/* Updates */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <RefreshCw size={18} /> Updates
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">
                1Boost v{update?.currentVersion ?? version}
              </div>
              <div className="setting-desc">
                {update?.status === 'checking'
                  ? 'Checking for updates…'
                  : update?.status === 'downloading'
                    ? `Downloading ${update.availableVersion ?? 'update'}… ${update.progress ?? 0}%`
                    : update?.status === 'ready'
                      ? `Version ${update.availableVersion ?? ''} is ready to install${
                          update.mode === 'delta'
                            ? ' — rebuilt from a signed patch, no full download'
                            : update.mode === 'full'
                              ? ' — downloaded in full'
                              : ''
                        }.`
                      : update?.status === 'error'
                        ? `Update check failed: ${update.error ?? 'unknown error'}`
                        : 'You are on the latest version.'}
              </div>
              {update?.status === 'downloading' ? (
                <div className="bar" style={{ marginTop: 8, maxWidth: 320 }}>
                  <div style={{ width: `${update.progress ?? 0}%` }} />
                </div>
              ) : null}
            </div>
            {update?.status === 'ready' ? (
              <button className="btn btn-primary" onClick={() => void bridge.installUpdate()}>
                <RotateCcw size={15} /> Restart to update
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => void runUpdateCheck()} disabled={checking || update?.status === 'downloading'}>
                {checking ? <RefreshCw size={15} className="spin" /> : <Download size={15} />}
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
            )}
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Automatic updates</div>
              <div className="setting-desc">
                New releases are downloaded in the background from GitHub. 1Boost asks before restarting to install.
                Stable installs never receive alpha/beta builds; prerelease installs return to the stable channel
                automatically once a newer stable release is out.
              </div>
            </div>
            {update?.status === 'up-to-date' ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                <CheckCircle2 size={15} color="#22c55e" /> Enabled
              </span>
            ) : null}
          </div>
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Roll back</div>
              <div className="setting-desc">
                Reinstall the last version 1Boost downloaded, from the copy it kept on disk. Useful if a new
                release misbehaves; the artifact is the same signed one the updater verified.
              </div>
            </div>
            <button className="btn btn-secondary" onClick={() => void runRollback()} disabled={rollingBack}>
              {rollingBack ? <RefreshCw size={15} className="spin" /> : <RotateCcw size={15} />}
              {rollingBack ? 'Rolling back…' : 'Roll back'}
            </button>
          </div>
          {rollbackNote ? (
            <div className="setting-desc" style={{ paddingTop: 4 }}>
              {rollbackNote}
            </div>
          ) : null}
        </div>
      </section>

      {/* Experimental */}
      <section className="settings-section">
        <div className="section-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <FlaskConical size={18} /> Experimental AI
        </div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">Experimental assistant</div>
              <div className="setting-desc">
                Ask questions about your recorded usage. Answers come from Gemini through a web
                session you connect yourself, using your own Google account's quota — this is{' '}
                <b>not unlimited</b> and Google can change or withdraw it at any time. This feature
                is experimental: it may be changed, disabled or removed in any release.
              </div>
            </div>
            <Toggle
              checked={prefs.experimentalAi}
              onChange={(v) => void setPref('experimentalAi', v)}
              label="Experimental assistant"
            />
          </div>

          {!ai?.compiledIn ? (
            <div className="setting-note" role="status">
              <AlertCircle size={14} />
              <span className="grow">
                Not compiled into this build — 1Boost has to be built with the experimental-ai
                feature for the assistant to exist. Turning the switch on now has no effect.
              </span>
            </div>
          ) : null}

          {ai?.compiledIn && prefs.experimentalAi ? (
            <>
              <div className="setting-note" role="note">
                <AlertCircle size={14} />
                <span className="grow">
                  <b>What leaves this machine.</b> Each question is sent to Gemini together with a
                  short, capped summary of your usage totals (hours, percentages and application
                  names). File names, paths and note contents are never included. Chats are sent as
                  temporary so they do not accumulate in your Google history. You can switch the
                  assistant off at any time, which also deletes the stored session.
                </span>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-title">Gemini session</div>
                  <div className="setting-desc">
                    {ai.configured
                      ? 'A session is connected. Paste a new cookie to replace it.'
                      : 'Paste the Cookie header from a signed-in gemini.google.com tab. 1Boost never reads your browser profile, and nothing you paste is written to this project.'}
                  </div>
                </div>
                {ai.configured ? (
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      const next = await bridge.aiClearSession()
                      setAi(next)
                      setAiNote({ ok: true, text: 'Session deleted from this machine.' })
                    }}
                  >
                    <Trash2 size={15} /> Disconnect
                  </button>
                ) : null}
              </div>

              <div className="setting-row" style={{ display: 'block' }}>
                <div className="setting-info">
                  <div className="setting-title">Session cookie</div>
                  <div className="setting-desc">
                    Value is stored only in 1Boost's own data folder at runtime. It is never logged,
                    never included in an export, and never committed.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input
                    className="tool-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="__Secure-1PSID=…; __Secure-1PSIDTS=…; SAPISID=…"
                    value={cookie}
                    onChange={(e) => setCookie(e.target.value)}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={savingCookie || !cookie.trim()}
                    onClick={async () => {
                      setSavingCookie(true)
                      setAiNote(null)
                      try {
                        const next = await bridge.aiSaveSession(cookie.trim())
                        setAi(next)
                        setCookie('')
                        setAiNote(
                          next?.configured
                            ? { ok: true, text: 'Session saved. The value is not shown again.' }
                            : {
                                ok: false,
                                text:
                                  next?.error ??
                                  'That value does not look like a Gemini session cookie.',
                              },
                        )
                      } finally {
                        setSavingCookie(false)
                      }
                    }}
                  >
                    {savingCookie ? 'Saving…' : 'Save session'}
                  </button>
                </div>
                {aiNote ? (
                  <div className={`setting-note${aiNote.ok ? ' ok' : ' bad'}`} role="status">
                    {aiNote.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    <span className="grow">{aiNote.text}</span>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
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
              <div className="setting-title">1Boost v{version}</div>
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
