import { useMemo, useRef, useState } from 'react'
import { formatDuration, formatDurationLong, formatDayLabel } from '../lib/format'
import type { TrendPoint } from '../../shared/types'

/** One live-history point: an indexed tick plus the current value. */
export interface LivePoint {
  t: number
  v: number | null
}

/** Round to 2 decimals — keeps live path strings short at 60 samples. */
const r2 = (v: number): number => Math.round(v * 100) / 100

/**
 * Smooth SVG path through the given points (Catmull-Rom → cubic bezier).
 * Control points are clamped into the [min(p1.y,p2.y), max(p1.y,p2.y)] band,
 * so the curve can never overshoot the sampled range — no phantom dips below
 * 0 % or spikes above peaks between samples, which raw Catmull-Rom produces
 * on spiky time-series. Vertices stay exactly on the samples.
 */
export function smoothLinePath(pts: { x: number; y: number }[]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M ${r2(pts[0].x)} ${r2(pts[0].y)}`
  let d = `M ${r2(pts[0].x)} ${r2(pts[0].y)}`
  for (let i = 1; i < n; i++) {
    const p1 = pts[i - 1]
    const p2 = pts[i]
    const p0 = pts[i - 2] ?? p1
    const p3 = pts[i + 1] ?? p2
    const dx = p2.x - p1.x
    let c1y = p1.y + (p2.y - p0.y) / 6
    let c2y = p2.y - (p3.y - p1.y) / 6
    const lo = Math.min(p1.y, p2.y)
    const hi = Math.max(p1.y, p2.y)
    c1y = Math.max(lo, Math.min(hi, c1y))
    c2y = Math.max(lo, Math.min(hi, c2y))
    d += ` C ${r2(p1.x + dx / 3)} ${r2(c1y)}, ${r2(p2.x - dx / 3)} ${r2(c2y)}, ${r2(p2.x)} ${r2(p2.y)}`
  }
  return d
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
    const pts = points.map((p, i) => ({ x: x(i), y: y(accessor(p)) }))
    // One or two samples cannot make a line. A flat run across the plot is
    // honest about what was measured and, unlike a lone "M x y", actually
    // draws something.
    if (pts.length === 1) {
      const y0 = r2(pts[0].y)
      return `M ${r2(pts[0].x - innerW / 4)} ${y0} L ${r2(pts[0].x + innerW / 4)} ${y0}`
    }
    return smoothLinePath(pts)
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

/**
 * Today's usage, one column per local hour.
 *
 * The dashboard used to draw this range through `TrendChart`, which is a line
 * chart: given a single day it produced a zero-width path and nothing appeared
 * at all. Hours are also the right shape for one day — "when was I at this
 * PC" has no answer in daily totals.
 */
export function HourChart({
  hours,
  activeHours,
  height = 210,
}: {
  hours: number[]
  activeHours: number[]
  height?: number
}) {
  const { tip, show, hide } = useTooltip()
  const [hover, setHover] = useState<number | null>(null)

  const W = 800
  const H = height
  const PADX = 10
  const PADT = 10
  const PADB = 24
  const innerW = W - PADX * 2
  const innerH = H - PADT - PADB

  const maxVal = Math.max(...hours, 1)
  const colW = innerW / 24
  const barW = Math.max(3, colW * 0.52)
  // The hour the user is currently in, so the live edge of the day is obvious.
  const nowHour = new Date().getHours()

  const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

  if (hours.every((v) => v <= 0)) {
    return (
      <div className="chart-empty-note">
        Nothing recorded yet today — 1Boost fills this in as you use the PC.
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseLeave={() => {
          hide()
          setHover(null)
        }}
        role="img"
        aria-label="PC usage by hour today"
      >
        {/* Baseline, so empty hours read as empty rather than as missing data. */}
        <line x1={PADX} x2={W - PADX} y1={PADT + innerH} y2={PADT + innerH} stroke="var(--border)" strokeWidth="1" />
        {hours.map((on, h) => {
          const active = activeHours[h] ?? 0
          const cx = PADX + colW * (h + 0.5)
          const onH = (Math.min(on, maxVal) / maxVal) * innerH
          const activeH = (Math.min(active, maxVal) / maxVal) * innerH
          const future = h > nowHour
          return (
            <g key={h}>
              {/* Full-height hit area: the whole column is hoverable, even
                  when the column itself is a sliver. */}
              <rect
                x={cx - colW / 2}
                y={PADT}
                width={colW}
                height={innerH}
                fill="transparent"
                onMouseMove={(e) => {
                  show({
                    x: e.clientX,
                    y: e.clientY,
                    title: `${hourLabel(h)} – ${hourLabel((h + 1) % 24)}`,
                    sub: future ? 'later today' : 'PC on / active',
                    value:
                      on > 0
                        ? `${formatDuration(on)} on · ${formatDuration(active)} active`
                        : 'PC off',
                  })
                  setHover(h)
                }}
              />
              {on > 0 && !future ? (
                <rect
                  x={cx - barW / 2}
                  y={PADT + innerH - onH}
                  width={barW}
                  height={Math.max(onH, 1.5)}
                  rx="2"
                  fill="var(--accent)"
                  opacity={hover === null || hover === h ? 0.32 : 0.16}
                />
              ) : null}
              {active > 0 && !future ? (
                <rect
                  x={cx - barW / 2}
                  y={PADT + innerH - activeH}
                  width={barW}
                  height={Math.max(activeH, 1.5)}
                  rx="2"
                  fill="var(--accent)"
                />
              ) : null}
              {hover === h ? (
                <line x1={cx} x2={cx} y1={PADT} y2={PADT + innerH} stroke="var(--border-strong)" strokeWidth="1" />
              ) : null}
            </g>
          )
        })}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <text
            key={h}
            x={PADX + colW * (h + 0.5)}
            y={H - 8}
            textAnchor="middle"
            fontSize="10"
            fill="var(--text-muted)"
          >
            {String(h).padStart(2, '0')}
          </text>
        ))}
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
  // remembers its first/last index so its area fill closes correctly. Lines
  // are smoothed (clamped Catmull-Rom) so live updates read as flowing curves
  // instead of jagged polylines — values themselves are untouched.
  const segments = useMemo(() => {
    const segs: { d: string; areaD: string; start: number; end: number }[] = []
    let pts: { x: number; y: number }[] = []
    let start = -1
    let last = -1
    const flush = () => {
      if (start >= 0 && pts.length > 0) {
        const d = smoothLinePath(pts)
        segs.push({
          d,
          areaD: `${d} L ${x(last)} ${PADT + innerH} L ${x(start)} ${PADT + innerH} Z`,
          start,
          end: last,
        })
      }
      pts = []
      start = -1
    }
    points.forEach((p, i) => {
      if (p.v == null) {
        flush()
        return
      }
      if (start < 0) start = i
      last = i
      pts.push({ x: x(i), y: y(p.v) })
    })
    flush()
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
                d={s.areaD}
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
