// System-monitoring service (main process).
//
// The renderer never polls: opening the Monitor page calls
// `oneboost:monitor-subscribe` (sent by the preload bridge when a listener is
// registered), which starts the shared poll and delivers a fresh seed sample.
// Subsequent samples arrive as one IPC push per tick while at least one
// subscriber exists. The poll always runs at a steady cadence while subscribed
// (rate metrics need evenly spaced samples), with a short overlap after the
// last unsubscribe so re-opening the page doesn't restart from "unavailable".

import { BrowserWindow, ipcMain } from 'electron'
import type { MonitorSample } from '../../shared/types'
import { nativeMonitorSample, nativeMonitorShutdown } from './native'

/** Poll cadence for the native layer. Rate metrics (bytes/sec) need an
 *  even spacing; 2 s balances smoothness against resource usage. */
const POLL_MS = 2_000
/** Keep sampling this long after the last subscriber unsubscribes, so briefly
 *  switching pages does not zero out the rate counters. */
const IDLE_LINGER_MS = 30_000

export class Monitor {
  private timer: NodeJS.Timeout | null = null
  private last: MonitorSample | null = null
  private subscribers = 0
  private rendererUnsub: (() => void) | null = null
  private lastUnsubscribeMs = 0
  private healthy = true
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
    this.rendererUnsub = null
    nativeMonitorShutdown()
  }

  /** Current snapshot: the cached one if fresh, else one fresh sample. */
  subscribe(): () => void {
    this.subscribers++
    this.start()
    const self = this
    return () => {
      self.subscribers = Math.max(0, self.subscribers - 1)
      if (self.subscribers === 0) self.lastUnsubscribeMs = Date.now()
    }
  }

  /** Seed sample on demand: fresh when none is cached yet. */
  current(): MonitorSample | null {
    if (!this.healthy) return null
    if (!this.last) return this.sampleOnce()
    return this.last
  }

  registerIpc(): void {
    ipcMain.handle('oneboost:get-monitor', () => this.current())
    ipcMain.on('oneboost:monitor-subscribe', (e) => {
      // One live subscription per renderer; the unsubscribe callback is
      // refcounted, so two Monitor pages (never happens) would still be safe.
      if (this.subscribers === 0 || !this.rendererUnsub) {
        this.rendererUnsub = this.subscribe()
      }
      // Answer on the same channel the renderer listens to for pushes, so a
      // fresh seed is never lost to the race between invoke() and push.
      const s = this.current()
      if (s && !e.sender.isDestroyed()) e.sender.send('oneboost:monitor', s)
    })
    ipcMain.on('oneboost:monitor-unsubscribe', () => {
      if (this.rendererUnsub) {
        this.rendererUnsub()
        this.rendererUnsub = null
      }
    })
  }

  private sampleOnce(): MonitorSample | null {
    try {
      const s = nativeMonitorSample()
      if (!this.healthy) {
        this.healthy = true
      }
      this.last = s
      return s
    } catch (e) {
      // Native layer missing/failed: report null and stop pushing until it
      // recovers. The renderer shows a graceful "unavailable" state.
      if (this.healthy) {
        this.healthy = false
        console.error('[1boost] monitoring unavailable:', String(e))
      }
      return null
    }
  }

  private tick(): void {
    if (this.stopped) return
    if (this.subscribers === 0) {
      if (Date.now() - this.lastUnsubscribeMs > IDLE_LINGER_MS) {
        // Nothing is listening: drop the timer entirely and free the PDH query.
        this.stop()
      }
      return
    }
    const s = this.sampleOnce()
    if (s) this.push(s)
  }

  private push(s: MonitorSample): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('oneboost:monitor', s)
    }
  }
}
