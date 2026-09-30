import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Files as FilesIcon,
  FolderOpen,
  RefreshCw,
  Search,
  ExternalLink,
  X,
} from 'lucide-react'
import type { FileEntry, RootFolder } from '../../shared/types'
import { bridge } from '../bridge'
import { EmptyState } from '../components/ui'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function ago(ms: number): string {
  if (!ms) return ''
  const min = Math.round((Date.now() - ms) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

export default function FilesPage() {
  const [roots, setRoots] = useState<RootFolder[]>([])
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void bridge.fileRoots().then(setRoots).catch(() => setRoots([]))
  }, [])

  const load = useCallback(async () => {
    try {
      setFiles(await bridge.filesRecent(true))
      setError(null)
    } catch {
      setFiles([])
      setError('Could not read your known folders.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (files ?? []).filter((f) => {
      if (folder && f.folder !== folder) return false
      if (!q) return true
      return f.name.toLowerCase().includes(q) || f.ext.includes(q)
    })
  }, [files, query, folder])

  const present = roots.filter((r) => r.exists)

  return (
    <div className="page files-page">
      <div className="notes-head">
        <div>
          <h1 className="page-title">Files</h1>
          <p className="page-subtitle">
            {visible.length} file{visible.length === 1 ? '' : 's'} across{' '}
            {present.length || 'no'} known folder{present.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="notes-head-actions">
          <div className="search-box">
            <Search size={15} />
            <input
              value={query}
              placeholder="Search file names…"
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            {query ? (
              <button aria-label="Clear" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            ) : null}
          </div>
          <button className="btn btn-secondary" onClick={() => void load()}>
            <RefreshCw size={15} /> Rescan
          </button>
        </div>
      </div>

      {present.length > 0 ? (
        <div className="chip-row">
          <button className={`chip${folder === null ? ' active' : ''}`} onClick={() => setFolder(null)}>
            All folders
          </button>
          {present.map((r) => (
            <button
              key={r.label}
              className={`chip${folder === r.label ? ' active' : ''}`}
              onClick={() => setFolder(folder === r.label ? null : r.label)}
              title={r.path}
            >
              <FolderOpen size={12} /> {r.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        {error ? (
          <EmptyState icon={<FilesIcon size={24} />} title="Files unavailable" desc={error} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<FilesIcon size={24} />}
            title={files && files.length > 0 ? 'No matches' : 'No files found'}
            desc={
              files && files.length > 0
                ? 'Try another name or folder.'
                : '1Boost looks in Desktop, Documents, Downloads, Pictures, Music and Videos.'
            }
          />
        ) : (
          <div className="row-list">
            {visible.slice(0, 300).map((f) => (
              <div key={f.path} className="file-row">
                <div className="file-main" onClick={() => void bridge.openFile(f.path)} role="button" tabIndex={0}>
                  <div className="file-name">
                    {f.name}
                    {f.ext ? <span className="file-ext">.{f.ext}</span> : null}
                  </div>
                  <div className="file-meta">
                    {f.folder} · {formatBytes(f.size)} · {ago(f.modifiedMs)}
                  </div>
                </div>
                <div className="file-actions">
                  <button
                    className="btn btn-ghost"
                    aria-label="Open"
                    title="Open with the default app"
                    onClick={() => void bridge.openFile(f.path)}
                  >
                    <ExternalLink size={15} />
                  </button>
                  <button
                    className="btn btn-ghost"
                    aria-label="Show in Explorer"
                    title="Show in Explorer"
                    onClick={() => void bridge.openFile(f.path, true)}
                  >
                    <FolderOpen size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}