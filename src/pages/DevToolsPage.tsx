import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'

/* --------------------------------------------------------------- helpers */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn btn-ghost"
      aria-label="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          /* clipboard blocked; the value is selectable anyway */
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </button>
  )
}

async function digest(algo: 'SHA-1' | 'SHA-256', input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest(algo, bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ------------------------------------------------------------------- JSON */

function JsonTool() {
  const [text, setText] = useState('{\n  "hello": "world"\n}')
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : 'Invalid JSON' }
    }
  }, [text])

  return (
    <div className="card tool-card">
      <div className="section-title">JSON</div>
      <textarea
        className="tool-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {parsed.ok ? (
        <>
          <div className="tool-actions">
            <button
              className="btn btn-secondary"
              onClick={() => setText(JSON.stringify(parsed.value, null, 2))}
            >
              Format
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setText(JSON.stringify(parsed.value))}
            >
              Minify
            </button>
            <CopyButton text={JSON.stringify(parsed.value, null, 2)} />
          </div>
          <div className="tool-error ok">
            Valid · {Array.isArray(parsed.value) ? `${parsed.value.length} items` : typeof parsed.value}
          </div>
        </>
      ) : (
        <div className="tool-error">{parsed.error}</div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- base64 */

function Base64Tool() {
  const [text, setText] = useState('Hello from 1Boost')
  const [encodedIn, setEncodedIn] = useState('')

  // btoa/atob are latin1-only, so route through UTF-8 bytes both ways.
  const encode = useMemo(() => {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    bytes.forEach((b) => {
      binary += String.fromCharCode(b)
    })
    return btoa(binary)
  }, [text])

  const decoded = useMemo(() => {
    if (!encodedIn.trim()) return { text: '', error: null as string | null }
    try {
      const binary = atob(encodedIn.trim().replace(/\s+/g, ''))
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return { text: new TextDecoder().decode(bytes), error: null }
    } catch {
      return { text: '', error: 'Not valid base64' }
    }
  }, [encodedIn])

  return (
    <div className="card tool-card">
      <div className="section-title">Base64</div>
      <label className="tool-label">Text</label>
      <textarea
        className="tool-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <label className="tool-label">Encoded</label>
      <div className="tool-input-row">
        <input className="tool-input" value={encode} readOnly spellCheck={false} />
        <CopyButton text={encode} />
      </div>
      <label className="tool-label">Decode</label>
      <div className="tool-input-row">
        <input
          className="tool-input"
          value={encodedIn}
          placeholder="Paste base64"
          onChange={(e) => setEncodedIn(e.target.value)}
          spellCheck={false}
        />
      </div>
      {decoded.error ? <div className="tool-error">{decoded.error}</div> : null}
      {decoded.text ? <div className="tool-output selectable">{decoded.text}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ hash */

function HashTool() {
  const [text, setText] = useState('')
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)

  const run = async () => {
    const [sha1, sha256] = await Promise.all([digest('SHA-1', text), digest('SHA-256', text)])
    setHashes({ 'SHA-1': sha1, 'SHA-256': sha256 })
  }

  return (
    <div className="card tool-card">
      <div className="section-title">Hash</div>
      <div className="tool-input-row">
        <input
          className="tool-input"
          value={text}
          placeholder="Text to hash"
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <button className="btn btn-primary" onClick={() => void run()}>
          Hash
        </button>
      </div>
      {Object.entries(hashes).map(([algo, value]) => (
        <div key={algo} className="hash-row">
          <span className="tool-label">{algo}</span>
          <code className="tool-output selectable">{value}</code>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(value)
              setCopied(algo)
              setTimeout(() => setCopied(null), 1200)
            }}
            aria-label={`Copy ${algo}`}
          >
            {copied === algo ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ uuid */

function UuidTool() {
  const make = () =>
    (crypto.randomUUID?.() ??
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      }))
  const [ids, setIds] = useState<string[]>(() => [make(), make()])
  return (
    <div className="card tool-card">
      <div className="section-title">UUIDs</div>
      <div className="tool-actions">
        <button className="btn btn-primary" onClick={() => setIds([make()])}>
          Generate
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => setIds((prev) => [...prev, make()].slice(-20))}
        >
          Add another
        </button>
        <CopyButton text={ids.join('\n')} />
      </div>
      <div className="uuid-list">
        {ids.map((id) => (
          <code key={id} className="tool-output selectable">
            {id}
          </code>
        ))}
      </div>
    </div>
  )
}

export default function DevToolsPage() {
  return (
    <div className="page tools-page">
      <h1 className="page-title">Dev tools</h1>
      <p className="page-subtitle">Encoders, hashes and formatters that run entirely on this machine</p>
      <div className="tool-grid" style={{ marginTop: 16 }}>
        <JsonTool />
        <Base64Tool />
        <HashTool />
        <UuidTool />
      </div>
    </div>
  )
}