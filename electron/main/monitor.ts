// System-monitoring service (main process).
//
// Resilience model (v1.1.5): the native layer is sampled on a steady timer for
// the entire app session — never gated on renderer subscriptions. Subscribing
// only arms *pushing*. This removes the whole class of "page shows one sample
// and freezes" bugs caused by a dropped/never-arriving subscribe round-trip:
// even if IPC registration is lost, the renderer's watchdog fallback poll
// (MonitorPage) still gets fresh data via oneboost:get-monitor.
//
// Pushes fan out to every live renderer while any of them is subscribed.
// Unsubscribed windows stay silent; the timer keeps running so rate metrics
// (bytes/sec, CPU%) stay valid with evenly spaced samples.

import { ipcMain } from 'electron'
import type { MonitorSample } from '../../shared/types'
import { nativeMonitorSample, nativeMonitorShutdown } from './native'

/** Poll cadence for the native layer. Rate metrics (bytes/sec) need an
 *  even spacing; 2 s balances smoothness against resource usage. */
const POLL_MS = 2_000

export class Monitor {
  private timer: NodeJS.Timeout | null = null
  private last: MonitorSample | null = null
  private lastError: string | null = null
  private subscribed = new Set<Electron.WebContents>()
  private stopped = false

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.last = null
    this.lastError = null
    this.subscribed.clear()
    nativeMonitorShutdown()
  }

  /** Latest cached sample; samples once when nothing is cached yet. */
  current(): MonitorSample | null {
    if (!this.last) return this.sampleOnce()
    return this.last
  }

  registerIpc(): void {
    ipcMain.handle('oneboost:get-monitor', () => this.current())
    ipcMain.on('oneboost:monitor-subscribe', (e) => {
      const wc = e.sender
      this.subscribed.add(wc)
      wc.once('destroyed', () => this.subscribed.delete(wc))
      // Seed on the push channel so a fresh sample is never lost to the race
      // between invoke() and the first periodic push.
      const s = this.current()
      if (s && !wc.isDestroyed()) wc.send('oneboost:monitor', s)
    })
    ipcMain.on('oneboost:monitor-unsubscribe', (e) => {
      this.subscribed.delete(e.sender)
    })
  }

  /** Consecutive failures before the native layer is considered broken. */
  private failures = 0

  private sampleOnce(): MonitorSample | null {
    try {
      const s = nativeMonitorSample()
      this.failures = 0
      this.last = s
      return s
    } catch (e) {
      this.failures++
      this.lastError = String(e)
      if (this.failures === 1 || this.failures % 30 === 0) {
        console.error('[1boost] monitoring sample failed:', String(e))
      }
      // Keep the last good sample cached (marked by its staleness) so the UI
      // can keep rendering; the renderer watchdog also polls independently.
      return null
    }
  }

  private tick(): void {
    if (this.stopped) return
    const s = this.sampleOnce()
    if (s) this.push(s)
  }

  private push(s: MonitorSample): void {
    for (const wc of this.subscribed) {
      if (!wc.isDestroyed()) {
        wc.send('oneboost:monitor', s)
      } else {
        this.subscribed.delete(wc)
      }
    }
  }

  /** Diagnostics for support: last error from the native layer, if any. */
  get lastSampleError(): string | null {
    return this.lastError
  }
}
