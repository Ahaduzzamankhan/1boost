import { useMemo, useRef, useState } from 'react'
import { formatDuration, formatDurationLong, formatDayLabel } from '../lib/format'
import type { TrendPoint } from '../../shared/types'

/** One live-history point: an indexed tick plus the current value. */
export interface LivePoint {
  t: number
  v: number | null
}

interface Tooltip {
  x: number
  y: number
  title: string
  sub?: string
  value: string
}

function useTooltip() {
  const [tip, setTip] = useState<Tooltip | null>(null)
  const show = (t: Tooltip) => setTip(t)
  const hide = () => setTip(null)
  return { tip, show, hide }
}

function TooltipEl({ tip }: { tip: Tooltip | null }) {
  if (!tip) return null
  return (
    <div
      className="chart-tooltip"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 190), top: Math.max(8, tip.y - 10) }}
    >
      <div className="tt-title">{tip.title}</div>
      {tip.sub ? <div className="tt-sub">{tip.sub}</div> : null}
      <div className="tt-value">{tip.value}</div>
    </div>
  )
}

/** Smooth area chart of active vs PC-on time per day. */
export function TrendChart({
  points,
  height = 220,
  showBaseline = false,
  baseline = 0,
}: {
  points: TrendPoint[]
  height?: number
  showBaseline?: boolean
  baseline?: number
}) {
  const ref = useRef<SVGSVGElement>(null)
  const { tip, show, hide } = useTooltip()
  const [hover, setHover] = useState<number | null>(null)

  const W = 800
  const H = height
  // Wide enough for the longest axis label ("4h 40m") at font-size 10.
  const PADX = 44
  const PADT = 12
  const PADB = 22
  const innerW = W - PADX * 2
  const innerH = H - PADT - PADB

  const maxVal = useMemo(() => {
    const m = Math.max(...points.map((p) => Math.max(p.onMs, p.activeMs)), 1)
    // Round up to a nice hour boundary; never exaggerate differences.
    const hours = Math.ceil(m / 3_600_000)
    return Math.max(hours, 1) * 3_600_000
  }, [points])

  const x = (i: number) =>
    points.length <= 1 ? PADX + innerW / 2 : PADX + (i / (points.length - 1)) * innerW
  const y = (v: number) => PADT + innerH - (v / maxVal) * innerH

  const path = (accessor: (p: TrendPoint) => number) => {
    if (points.length === 0) return ''
    if (points.length === 1) {
      return `M ${x(0)} ${y(accessor(points[0]))}`
    }
    let d = `M ${x(0)} ${y(accessor(points[0]))}`
    for (let i = 1; i < points.length; i++) {
      const x0 = x(i - 1)
      const y0 = y(accessor(points[i - 1]))
      const x1 = x(i)
      const y1 = y(accessor(points[i]))
      const cx = (x0 + x1) / 2
      d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`
    }
    return d
  }

  const areaD = () => {
    if (points.length === 0) return ''
    return `${path((p) => p.onMs)} L ${x(points.length - 1)} ${PADT + innerH} L ${x(0)} ${PADT + innerH} Z`
  }

  const gridLines = 3

  if (points.length === 0) return null

  const fmtHour = (v: number) => formatDuration(v)

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseLeave={() => {
          hide()
          setHover(null)
        }}
        role="img"
        aria-label="Daily PC usage chart"
      >
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {Array.from({ length: gridLines + 1 }, (_, i) => {
          const v = (maxVal / gridLines) * i
          return (
            <g key={i}>
              <line x1={PADX} x2={W - PADX} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
              <text x={PADX - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {fmtHour(v)}
              </text>
            </g>
          )
        })}
        <path d={areaD()} fill="url(#trendFill)" />
        <path d={path((p) => p.onMs)} fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="4 3" />
        <path d={path((p) => p.activeMs)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        {showBaseline && baseline > 0 ? (
          <line
            x1={PADX}
            x2={W - PADX}
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="var(--text-muted)"
            strokeWidth="1"
            strokeDasharray="2 4"
          />
        ) : null}
        {points.map((p, i) => (
          <g key={p.date}>
            <rect
              x={x(i) - innerW / (2 * Math.max(1, points.length - 1))}
              y={PADT}
              width={innerW / Math.max(1, points.length - 1)}
              height={innerH}
              fill="transparent"
              onMouseMove={(e) => {
                show({
                  x: e.clientX,
                  y: e.clientY,
                  title: formatDayLabel(p.date),
                  sub: 'PC on / active',
                  value: `${formatDuration(p.onMs)} · ${formatDuration(p.activeMs)} active`,
                })
                setHover(i)
              }}
            />
            {hover === i ? (
              <>
                <line x1={x(i)} x2={x(i)} y1={PADT} y2={PADT + innerH} stroke="var(--border-strong)" strokeWidth="1" />
                <circle cx={x(i)} cy={y(p.activeMs)} r="3.5" fill="var(--accent)" />
                <circle cx={x(i)} cy={y(p.onMs)} r="3" fill="var(--text-secondary)" />
              </>
            ) : null}
          </g>
        ))}
        {points.length > 1
          ? [0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => (
              <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                {formatDayLabel(points[i].date)}
              </text>
            ))
          : null}
      </svg>
      <TooltipEl tip={tip} />
    </div>
  )
}

/** Vertical bars, one per day (history / stats). */
export function DailyBars({ points, height = 190 }: { points: TrendPoint[]; height?: number }) {
  const { tip, show, hide } = useTooltip()
  const W = 800
  const H = height
  const PADX = 44
  const PADT = 12
  const PADB = 22
  const innerW = W - PADX * 2
  const innerH = H - PADT - PADB

  const maxVal = useMemo(
    () => Math.max(...points.map((p) => Math.max(p.onMs, p.activeMs)), 1),
    [points],
  )

  if (points.length === 0) return null
  const bw = Math.min(26, (innerW / points.length) * 0.55)
  const cx = (i: number) => PADX + (i + 0.5) * (innerW / points.length)
  const bh = (v: number) => (v / maxVal) * innerH

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseLeave={() => hide()}
        role="img"
        aria-label="Daily usage bars"
      >
        {[0.5, 1].map((f) => (
          <line
            key={f}
            x1={PADX}
            x2={W - PADX}
            y1={PADT + innerH - innerH * f}
            y2={PADT + innerH - innerH * f}
            stroke="var(--border)"
          />
        ))}
        <text x={PADX - 6} y={PADT + innerH - innerH + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
          {formatDuration(maxVal)}
        </text>
        {points.map((p, i) => (
          <g key={p.date}>
            <rect
              x={cx(i) - bw / 2}
              y={PADT + innerH - bh(p.onMs)}
              width={bw}
              height={bh(p.onMs)}
              rx={4}
              fill="var(--surface-hover)"
              stroke="var(--border)"
              onMouseMove={(e) =>
                show({
                  x: e.clientX,
                  y: e.clientY,
                  title: formatDayLabel(p.date),
                  sub: 'PC on',
                  value: formatDurationLong(p.onMs),
                })
              }
            />
            <rect
              x={cx(i) - bw / 2}
              y={PADT + innerH - bh(p.activeMs)}
              width={bw}
              height={bh(p.activeMs)}
              rx={4}
              fill="var(--accent)"
              fillOpacity="0.85"
              onMouseMove={(e) =>
                show({
                  x: e.clientX,
                  y: e.clientY,
                  title: formatDayLabel(p.date),
                  sub: 'Active',
                  value: formatDurationLong(p.activeMs),
                })
              }
            />
          </g>
        ))}
        {points.length > 1
          ? [0, points.length - 1].map((i) => (
              <text key={i} x={cx(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                {formatDayLabel(points[i].date)}
              </text>
            ))
          : null}
      </svg>
      <TooltipEl tip={tip} />
    </div>
  )
}

/**
 * Live area chart for the Monitor page. Takes a fixed-capacity history array
 * (oldest first, `null` = unavailable) and renders it without any internal
 * state — the owner keeps exactly one history per metric and re-renders on
 * each push, so history can never grow unbounded.
 */
export function LiveAreaChart({
  points,
  max,
  height = 96,
  formatValue,
  ariaLabel,
}: {
  points: LivePoint[]
  /** Fixed y-axis maximum (e.g. 100 for %). When omitted the axis scales to
   *  the data (never below the largest value, never below 1). */
  max?: number
  height?: number
  formatValue: (v: number) => string
  ariaLabel: string
}) {
  const { tip, show, hide } = useTooltip()
  const W = 600
  const H = height
  const PADX = 2
  const PADT = 6
  const PADB = 4
  const innerW = W - PADX * 2
  const innerH = H - PADT - PADB

  const cap = Math.max(points.length, 1)
  const dataMax = useMemo(() => {
    let m = 1
    for (const p of points) {
      if (p.v != null && p.v > m) m = p.v
    }
    return m
  }, [points])
  const yMax = max != null ? max : dataMax

  const x = (i: number) => PADX + (cap <= 1 ? innerW / 2 : (i / (cap - 1)) * innerW)
  const y = (v: number) => PADT + innerH - (Math.max(0, v) / yMax) * innerH

  // Build path segments, breaking at null (unavailable) values; each segment
  // remembers its first/last index so its area fill closes correctly.
  const segments = useMemo(() => {
    const segs: { d: string; start: number; end: number }[] = []
    let cur = ''
    let start = -1
    let last = -1
    points.forEach((p, i) => {
      if (p.v == null) {
        if (start >= 0) segs.push({ d: cur, start, end: last })
        cur = ''
        start = -1
        return
      }
      if (start < 0) start = i
      last = i
      const cmd = cur === '' ? 'M' : 'L'
      cur += `${cmd} ${x(i)} ${y(p.v)}`
    })
    if (start >= 0) segs.push({ d: cur, start, end: last })
    return segs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, yMax, cap])

  const lastIdx = points.length > 0 ? segments.length > 0 ? segments[segments.length - 1].end : -1 : -1
  const hasData = segments.length > 0

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseLeave={hide}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <linearGradient id="liveFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {hasData ? (
          <>
            {segments.map((s, si) => (
              <path
                key={`a${si}`}
                d={`${s.d} L ${x(s.end)} ${PADT + innerH} L ${x(s.start)} ${PADT + innerH} Z`}
                fill="url(#liveFill)"
                stroke="none"
              />
            ))}
            {segments.map((s, si) => (
              <path
                key={`l${si}`}
                d={s.d}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            <circle cx={x(lastIdx)} cy={y(points[lastIdx].v as number)} r="2.6" fill="var(--accent)" />
          </>
        ) : (
          <line
            x1={PADX}
            x2={W - PADX}
            y1={PADT + innerH}
            y2={PADT + innerH}
            stroke="var(--border)"
            strokeDasharray="3 4"
          />
        )}
        <rect
          x={0}
          y={0}
          width={W}
          height={H}
          fill="transparent"
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
            const rel = (e.clientX - rect.left) / rect.width
            const idx = Math.min(cap - 1, Math.max(0, Math.round(rel * (cap - 1))))
            const p = points[idx]
            show({
              x: e.clientX,
              y: e.clientY,
              title: `t−${cap - 1 - idx} sample${cap - 1 - idx === 1 ? '' : 's'}`,
              value: p?.v == null ? 'unavailable' : formatValue(p.v),
            })
          }}
        />
      </svg>
      <TooltipEl tip={tip} />
    </div>
  )
}

/** Single horizontal proportion bar used in app lists. */
export function HBar({ fraction, color }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100
  return (
    <div className="bar" style={{ width: '100%' }}>
      <div style={{ width: `${pct}%`, background: color ?? 'var(--accent)' }} />
    </div>
  )
}
