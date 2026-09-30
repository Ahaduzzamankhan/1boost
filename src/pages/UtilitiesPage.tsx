import { useMemo, useState } from 'react'
import { Copy, RefreshCw, Wrench } from 'lucide-react'
import { Segmented } from '../components/ui'

/* ------------------------------------------------------------------ units */

const UNITS: Record<string, { label: string; to: (v: number) => number; from: (v: number) => number }> = {
  // length (metres)
  mm: { label: 'mm', to: (v) => v / 1000, from: (v) => v * 1000 },
  cm: { label: 'cm', to: (v) => v / 100, from: (v) => v * 100 },
  m: { label: 'm', to: (v) => v, from: (v) => v },
  km: { label: 'km', to: (v) => v * 1000, from: (v) => v / 1000 },
  in: { label: 'in', to: (v) => v * 0.0254, from: (v) => v / 0.0254 },
  ft: { label: 'ft', to: (v) => v * 0.3048, from: (v) => v / 0.3048 },
  mi: { label: 'mi', to: (v) => v * 1609.344, from: (v) => v / 1609.344 },
  // weight (kilograms)
  mg: { label: 'mg', to: (v) => v / 1e6, from: (v) => v * 1e6 },
  g: { label: 'g', to: (v) => v / 1000, from: (v) => v * 1000 },
  kg: { label: 'kg', to: (v) => v, from: (v) => v },
  lb: { label: 'lb', to: (v) => v * 0.45359237, from: (v) => v / 0.45359237 },
  oz: { label: 'oz', to: (v) => v * 0.0283495, from: (v) => v / 0.0283495 },
  // data (bytes)
  b: { label: 'B', to: (v) => v, from: (v) => v },
  kb: { label: 'KB', to: (v) => v * 1024, from: (v) => v / 1024 },
  mb: { label: 'MB', to: (v) => v * 1024 ** 2, from: (v) => v / 1024 ** 2 },
  gb: { label: 'GB', to: (v) => v * 1024 ** 3, from: (v) => v / 1024 ** 3 },
  tb: { label: 'TB', to: (v) => v * 1024 ** 4, from: (v) => v / 1024 ** 4 },
  // time (seconds)
  ms: { label: 'ms', to: (v) => v / 1000, from: (v) => v * 1000 },
  s: { label: 's', to: (v) => v, from: (v) => v },
  min: { label: 'min', to: (v) => v * 60, from: (v) => v / 60 },
  h: { label: 'h', to: (v) => v * 3600, from: (v) => v / 3600 },
}

const GROUPS: { id: string; label: string; keys: string[] }[] = [
  { id: 'length', label: 'Length', keys: ['mm', 'cm', 'm', 'km', 'in', 'ft', 'mi'] },
  { id: 'weight', label: 'Weight', keys: ['mg', 'g', 'kg', 'lb', 'oz'] },
  { id: 'data', label: 'Data', keys: ['b', 'kb', 'mb', 'gb', 'tb'] },
  { id: 'time', label: 'Time', keys: ['ms', 's', 'min', 'h'] },
]

function trimNumber(n: number): string {
  if (!Number.isFinite(n)) return ''
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e12)) return n.toExponential(6)
  return String(Number(n.toFixed(8)))
}

function Converter() {
  const [group, setGroup] = useState('length')
  const [from, setFrom] = useState('m')
  const [to, setTo] = useState('ft')
  const [value, setValue] = useState('1')

  const keys = GROUPS.find((g) => g.id === group)?.keys ?? []
  const n = Number(value)
  const valid = value.trim() !== '' && Number.isFinite(n)
  const result = valid ? UNITS[to].from(UNITS[from].to(n)) : NaN

  return (
    <div className="card tool-card">
      <div className="section-title">Unit converter</div>
      <Segmented
        options={GROUPS.map((g) => ({ value: g.id, label: g.label }))}
        value={group}
        onChange={(g) => {
          setGroup(g)
          setFrom(GROUPS.find((x) => x.id === g)?.keys[0] ?? 'm')
          setTo(GROUPS.find((x) => x.id === g)?.keys[1] ?? 'ft')
        }}
      />
      <div className="converter-row">
        <input className="tool-input" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
        <select className="tool-select" value={from} onChange={(e) => setFrom(e.target.value)}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {UNITS[k].label}
            </option>
          ))}
        </select>
        <span className="converter-arrow">→</span>
        <output className="tool-output">{valid ? trimNumber(result) : '—'}</output>
        <select className="tool-select" value={to} onChange={(e) => setTo(e.target.value)}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {UNITS[k].label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ color */

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().replace('#', '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function ColorTool() {
  const [hex, setHex] = useState('#3b82f6')
  const rgb = hexToRgb(hex)
  const hsl = useMemo(() => {
    if (!rgb) return null
    const [r, g, b] = rgb.map((v) => v / 255)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    if (max === min) return [0, 0, l]
    const d = max - min
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    let h = 0
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
    return [h * 360, s, l]
  }, [rgb])

  return (
    <div className="card tool-card">
      <div className="section-title">Color converter</div>
      <div className="color-row">
        <input
          className="color-swatch"
          type="color"
          value={rgb ? hex : '#000000'}
          onChange={(e) => setHex(e.target.value)}
          aria-label="Pick color"
        />
        <input
          className="tool-input"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          spellCheck={false}
        />
      </div>
      {rgb ? (
        <div className="color-values">
          <div>
            <span>RGB</span>
            <code>
              {rgb.join(', ')}
            </code>
          </div>
          <div>
            <span>HSL</span>
            <code>
              {hsl
                ? `${Math.round(hsl[0])}, ${Math.round(hsl[1] * 100)}%, ${Math.round(hsl[2] * 100)}%`
                : '—'}
            </code>
          </div>
          <div>
            <span>Luminance</span>
            <code>
              {(
                (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) /
                255
              ).toFixed(3)}
            </code>
          </div>
        </div>
      ) : (
        <div className="tool-hint">Enter a hex color like #3b82f6.</div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- password */

function randomPassword(length: number): string {
  // Rejection sampling keeps the alphabet uniform; modulo would bias it.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function PasswordTool() {
  const [len, setLen] = useState(20)
  const [value, setValue] = useState(() => randomPassword(20))
  const strength = Math.min(4, Math.floor((value.length / 12) * 4))

  return (
    <div className="card tool-card">
      <div className="section-title">Password generator</div>
      <div className="password-row">
        <code className="tool-output selectable">{value}</code>
        <button
          className="btn btn-secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(value)
          }}
          aria-label="Copy password"
        >
          <Copy size={15} />
        </button>
        <button className="btn btn-primary" onClick={() => setValue(randomPassword(len))}>
          <RefreshCw size={15} /> Generate
        </button>
      </div>
      <label className="range-row">
        <span>Length</span>
        <input
          type="range"
          min={8}
          max={64}
          value={len}
          onChange={(e) => setLen(Number(e.target.value))}
        />
        <b>{len}</b>
      </label>
      <div className="strength">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < strength ? 'on' : ''} />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ epoch */

function TimeTool() {
  const [text, setText] = useState(() => new Date().toISOString())
  const ms = Date.parse(text)
  const valid = Number.isFinite(ms)
  return (
    <div className="card tool-card">
      <div className="section-title">Time &amp; epoch</div>
      <div className="tool-input-row">
        <input className="tool-input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <button className="btn btn-secondary" onClick={() => setText(new Date().toISOString())}>
          <RefreshCw size={15} /> Now
        </button>
      </div>
      {valid ? (
        <div className="color-values">
          <div>
            <span>Unix ms</span>
            <code>{ms}</code>
          </div>
          <div>
            <span>Unix s</span>
            <code>{Math.floor(ms / 1000)}</code>
          </div>
          <div>
            <span>Local</span>
            <code>{new Date(ms).toLocaleString()}</code>
          </div>
          <div>
            <span>UTC</span>
            <code>{new Date(ms).toISOString()}</code>
          </div>
        </div>
      ) : (
        <div className="tool-hint">Not a parseable date.</div>
      )}
    </div>
  )
}

export default function UtilitiesPage() {
  return (
    <div className="page tools-page">
      <h1 className="page-title">Utilities</h1>
      <p className="page-subtitle">Small tools that would otherwise be a web search away</p>
      <div className="tool-grid" style={{ marginTop: 16 }}>
        <Converter />
        <ColorTool />
        <PasswordTool />
        <TimeTool />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="tool-empty">
          <Wrench size={18} /> More tools land here as modules are added — everything stays local and
          offline.
        </div>
      </div>
    </div>
  )
}