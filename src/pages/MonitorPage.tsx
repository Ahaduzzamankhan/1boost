import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Monitor as MonitorIcon,
  Thermometer,
  Wifi,
  Zap,
} from 'lucide-react'
import type { MonitorSample } from '../../shared/types'
import { bridge } from '../bridge'
import { formatBytes, formatRate, formatTemp } from '../lib/format'
import { LiveAreaChart, type LivePoint } from '../components/charts'
import { EmptyState } from '../components/ui'

/** History length per metric: 60 samples × 2 s ≈ the last two minutes. */
const HISTORY_CAP = 60

/** A fixed-capacity ring buffer for one metric's history. */
function pushPoint(buf: LivePoint[], v: number | null, t: number): LivePoint[] {
  const next = buf.length >= HISTORY_CAP ? buf.slice(1) : buf.slice()
  next.push({ v, t })
  return next
}

function freshHistory(): LivePoint[] {
  return [{ v: null, t: 0 }]
}

interface MetricHistory {
  cpu: LivePoint[]
  memPct: LivePoint[]
  gpu: LivePoint[]
  disk: LivePoint[]
  down: LivePoint[]
  up: LivePoint[]
  tick: number
}

function freshHistories(): MetricHistory {
  return {
    cpu: freshHistory(),
    memPct: freshHistory(),
    gpu: freshHistory(),
    disk: freshHistory(),
    down: freshHistory(),
    up: freshHistory(),
    tick: 0,
  }
}

/** True when a value arrived and is displayable. */
function has(v: number | null | undefined): boolean {
  return v != null && Number.isFinite(v)
}

interface MetricCardProps {
  icon: React.ReactNode
  title: string
  /** Big value line (already formatted). */
  value: string
  /** Secondary line, e.g. used/total or the sensor reading. */
  sub?: string
  /** Optional third chip, e.g. temperature. */
  chip?: { icon: React.ReactNode; text: string } | null
  history: LivePoint[]
  historyMax?: number
  formatValue: (v: number) => string
  ariaLabel: string
}

function MetricCard({
  icon,
  title,
  value,
  sub,
  chip,
  history,
  historyMax,
  formatValue,
  ariaLabel,
}: MetricCardProps) {
  return (
    <div className="card monitor-card">
      <div className="monitor-head">
        <div className="metric-label">
          {icon} {title}
        </div>
        {chip ? (
          <span className="monitor-chip">
            {chip.icon} {chip.text}
          </span>
        ) : null}
      </div>
      <div className="metric-value monitor-value">{value}</div>
      <div className="metric-sub">{sub ?? ' '}</div>
      <LiveAreaChart
        points={history}
        max={historyMax}
        formatValue={formatValue}
        ariaLabel={ariaLabel}
      />
    </div>
  )
}

export default function MonitorPage() {
  const [sample, setSample] = useState<MonitorSample | null>(null)
  const [hist, setHist] = useState<MetricHistory>(freshHistories)
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    let lastAppliedMs = -1
    // Latest sample feeds both the numbers and the history rings. The one-shot
    // seed and the first push can deliver the same cached snapshot — dedupe by
    // timestamp so no history point is ever doubled.
    const apply = (s: MonitorSample) => {
      if (!s || s.nowMs === lastAppliedMs) return
      lastAppliedMs = s.nowMs
      lastAppliedAt = Date.now()
      setSample(s)
      setAvailable(true)
      const total = s.memory.totalBytes || 0
      const memPct = total > 0 ? (s.memory.usedBytes / total) * 100 : null
      setHist((h) => ({
        tick: h.tick + 1,
        cpu: pushPoint(h.cpu, s.cpu.usage, s.nowMs),
        memPct: pushPoint(h.memPct, memPct != null && Number.isFinite(memPct) ? memPct : null, s.nowMs),
        gpu: pushPoint(h.gpu, s.gpu.usage, s.nowMs),
        disk: pushPoint(h.disk, s.disk.activePct, s.nowMs),
        down: pushPoint(h.down, s.network.downloadBps, s.nowMs),
        up: pushPoint(h.up, s.network.uploadBps, s.nowMs),
      }))
    }
    let cancelled = false
    let lastAppliedAt = 0
    bridge
      .getMonitorSample()
      .then((s) => {
        if (!cancelled && s) apply(s)
        else if (!cancelled && !s) setAvailable(false)
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })
    unsubscribe = bridge.monitor(apply)
    // Watchdog: if pushes stall (dropped subscription, IPC hiccup), fall back
    // to polling so the page can never freeze on a stale seed sample.
    const watchdog = setInterval(() => {
      if (cancelled) return
      if (Date.now() - lastAppliedAt > 6_000) {
        void bridge
          .getMonitorSample()
          .then((s) => {
            if (!cancelled && s) apply(s)
          })
          .catch(() => undefined)
      }
    }, 4_000)
    return () => {
      cancelled = true
      clearInterval(watchdog)
      unsubscribe?.()
    }
  }, [])

  const cpuName = sample?.cpu.name?.trim() || 'Processor'
  const gpuAvailable = has(sample?.gpu.usage) || (sample?.gpu.memUsedBytes ?? 0) > 0
  const osLine = useMemo(() => {
    if (!sample) return ''
    const parts = [sample.os.name?.trim() || 'Windows']
    const v = sample.os.version?.trim()
    if (v) parts.push(v)
    return parts.join(' · ')
  }, [sample])

  if (available === false) {
    return (
      <div className="page">
        <h1 className="page-title">Monitor</h1>
        <p className="page-subtitle">Live system performance</p>
        <div className="card" style={{ marginTop: 16 }}>
          <EmptyState
            icon={<MonitorIcon size={24} />}
            title="Monitoring unavailable"
            desc="The native monitoring layer could not be loaded on this system. Usage tracking continues normally."
          />
        </div>
      </div>
    )
  }

  const memTotal = sample ? sample.memory.totalBytes : 0
  const memUsed = sample ? sample.memory.usedBytes : 0
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Monitor</h1>
          <p className="page-subtitle">Live system performance{osLine ? ` — ${osLine}` : ''}</p>
        </div>
      </div>

      <div className="grid-metrics monitor-grid">
        <MetricCard
          icon={<Cpu size={13} />}
          title="CPU"
          value={has(sample?.cpu.usage) ? `${sample!.cpu.usage!.toFixed(0)}%` : '—'}
          sub={`${cpuName}${sample?.cpu.cores ? ` · ${sample.cpu.cores} threads` : ''}`}
          chip={
            has(sample?.cpu.tempC)
              ? { icon: <Thermometer size={12} />, text: formatTemp(sample!.cpu.tempC) }
              : null
          }
          history={hist.cpu}
          historyMax={100}
          formatValue={(v) => `${v.toFixed(0)}%`}
          ariaLabel="CPU usage history"
        />

        <MetricCard
          icon={<MemoryStick size={13} />}
          title="Memory"
          value={
            memTotal > 0
              ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`
              : '—'
          }
          sub={memTotal > 0 ? `${memPct.toFixed(0)}% used` : undefined}
          history={hist.memPct}
          historyMax={100}
          formatValue={(v) => `${v.toFixed(0)}%`}
          ariaLabel="Memory usage history"
        />

        <MetricCard
          icon={<Zap size={13} />}
          title="GPU"
          value={
            gpuAvailable
              ? has(sample?.gpu.usage)
                ? `${sample!.gpu.usage!.toFixed(0)}%`
                : 'In use'
              : 'Unavailable'
          }
          sub={
            gpuAvailable
              ? sample?.gpu.name?.trim() || 'Graphics adapter'
              : 'No GPU performance counters on this system'
          }
          chip={
            has(sample?.gpu.tempC)
              ? { icon: <Thermometer size={12} />, text: formatTemp(sample!.gpu.tempC) }
              : null
          }
          history={hist.gpu}
          historyMax={100}
          formatValue={(v) => `${v.toFixed(0)}%`}
          ariaLabel="GPU usage history"
        />

        <MetricCard
          icon={<Activity size={13} />}
          title="Disk activity"
          value={has(sample?.disk.activePct) ? `${sample!.disk.activePct!.toFixed(0)}%` : '—'}
          sub={
            has(sample?.disk.readBps) || has(sample?.disk.writeBps)
              ? `R ${formatRate(sample!.disk.readBps ?? 0)} · W ${formatRate(sample!.disk.writeBps ?? 0)}`
              : 'Unavailable'
          }
          history={hist.disk}
          historyMax={100}
          formatValue={(v) => `${v.toFixed(0)}%`}
          ariaLabel="Disk activity history"
        />
      </div>

      <div className="grid-metrics monitor-grid" style={{ marginTop: 16 }}>
        <MetricCard
          icon={<Wifi size={13} />}
          title="Download"
          value={has(sample?.network.downloadBps) ? formatRate(sample!.network.downloadBps!) : '—'}
          sub={sample?.network.interface ?? undefined}
          history={hist.down}
          formatValue={formatRate}
          ariaLabel="Network download history"
        />
        <MetricCard
          icon={<Wifi size={13} />}
          title="Upload"
          value={has(sample?.network.uploadBps) ? formatRate(sample!.network.uploadBps!) : '—'}
          sub={sample?.network.interface ?? undefined}
          history={hist.up}
          formatValue={formatRate}
          ariaLabel="Network upload history"
        />

        <div className="card monitor-card">
          <div className="monitor-head">
            <div className="metric-label">
              <HardDrive size={13} /> Storage
            </div>
          </div>
          {sample && sample.drives.length > 0 ? (
            <div className="drive-list">
              {sample.drives.map((d) => {
                const usedFrac = d.totalBytes > 0 ? 1 - d.freeBytes / d.totalBytes : 0
                return (
                  <div key={d.letter} className="drive-row">
                    <span className="drive-letter">{d.letter}:</span>
                    <div className="bar" style={{ flex: 1 }}>
                      <div style={{ width: `${Math.min(100, Math.max(0, usedFrac * 100))}%` }} />
                    </div>
                    <span className="drive-usage">
                      {formatBytes(d.totalBytes - d.freeBytes)} used of {formatBytes(d.totalBytes)}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="metric-sub" style={{ marginTop: 8 }}>
              No fixed drives reported yet
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
