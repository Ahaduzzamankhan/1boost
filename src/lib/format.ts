// Pure formatting helpers (unit-tested in tests/format.test.ts).

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** "8h 42m" / "42m" / "8h" / "0m" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0 && m === 0) return '0m'
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/** "8:42" style clock duration for compact chart labels. */
export function formatDurationShort(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`
}

/** "3h 42m 15s" precision for tooltips. */
export function formatDurationLong(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '0%'
  return `${(fraction * 100).toFixed(digits)}%`
}

/** "5.8 GB" / "512 MB" / "1.2 TB" — binary units, matching what Windows shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024
    u++
  }
  const digits = v >= 100 || u === 0 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(digits)} ${UNITS[u]}`
}

/** "2.4 MB/s" style transfer rates from bytes/sec. */
export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '—'
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
  return `${formatBytes(bytesPerSec)}/s`
}

/** "54 °C" or "unavailable" for sensor values (sentinels never render). */
export function formatTemp(c: number | null): string {
  if (c == null || !Number.isFinite(c) || c <= 0) return 'Unavailable'
  return `${Math.round(c)} °C`
}

/** "September 28" */
export function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
}

/** "September 28, 2026" */
export function formatDayLabelFull(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

/** "Today" / "Yesterday" / weekday / date label. */
export function formatDayRelative(dateKey: string, nowMs = Date.now()): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  const today = new Date(nowMs)
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - date.getTime()) / DAY)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7 && diffDays > 0) {
    return date.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return formatDayLabel(dateKey)
}

export function dayKeyOf(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export { MIN, HOUR, DAY }
