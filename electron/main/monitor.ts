// System-monitoring service (main process).
//
// Owns the single poll of the native monitoring layer. The renderer never
// polls: it calls `oneboost:monitor` to subscribe and receives one IPC push
// per sample while at least one subscriber exists. The poll always runs at a
// steady cadence while subscribed (rate metrics need evenly spaced samples),
// with a short overlap after the last unsubscribe so re-opening the page
// doesn't restart from "unavailable".

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
    nativeMonitorShutdown()
  }

  /** Current snapshot: the cached one if fresh, else one fresh sample. */
  current(): MonitorSample | null {
    if (!this.healthy) return null
    if (this.last) return this.last
    return this.sampleOnce()
  }

  subscribe(): () => void {
    this.subscribers++
    this.start()
    const self = this
    return () => {
      self.subscribers = Math.max(0, self.subscribers - 1)
      if (self.subscribers === 0) self.lastUnsubscribeMs = Date.now()
    }
  }

  registerIpc(): void {
    ipcMain.handle('oneboost:get-monitor', () => this.current())
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
