//! System monitoring service — port of electron/main/monitor.ts. Samples
//! continuously for the whole app session (never gated on subscriptions);
//! pushes fan out to the renderer via the `oneboost:monitor` event every 2 s.

use oneboost_native::api::{self, MonitorSample};
use std::sync::Mutex;

pub type MonitorPayload = MonitorSample;

const STALE_FAILS_LOG: u32 = 30;

pub struct Monitor {
    last: Mutex<Option<MonitorSample>>,
    last_error: Mutex<Option<String>>,
    failures: Mutex<u32>,
}

static MON_LOCK: Mutex<()> = Mutex::new(());

impl Monitor {
    pub fn new() -> Monitor {
        Monitor {
            last: Mutex::new(None),
            last_error: Mutex::new(None),
            failures: Mutex::new(0),
        }
    }

    pub fn set_last(&self, s: MonitorSample) {
        if let Ok(mut g) = self.last.lock() {
            *g = Some(s);
        }
        if let Ok(mut f) = self.failures.lock() {
            *f = 0;
        }
    }

    /// Latest cached sample; samples once when nothing is cached yet.
    pub fn current(&self) -> Option<MonitorSample> {
        if let Ok(g) = self.last.lock() {
            if let Some(s) = g.as_ref() {
                return Some(s.clone());
            }
        }
        let s = sample_once()?;
        if let Ok(mut g) = self.last.lock() {
            *g = Some(s.clone());
        }
        Some(s)
    }

    pub fn note_failure(&self, e: String) {
        let count = self.failures.lock().map(|mut f| {
            *f += 1;
            *f
        }).unwrap_or(0);
        if let Ok(mut le) = self.last_error.lock() {
            *le = Some(e);
        }
        if count == 1 || count % STALE_FAILS_LOG == 0 {
            let msg = self.last_error.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
            log::error!("[1boost] monitoring sample failed: {}", msg);
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|g| g.clone())
    }
}

/// One monitoring snapshot from the native layer. Rate metrics need a steady
/// ≥ 0.1 s gap since the previous call (the 2 s run-loop cadence satisfies
/// this; the one-shot seed path primes the counters).
pub fn sample_once() -> Option<MonitorSample> {
    let _guard = MON_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    api::monitor_sample()
}

/// Release the shared PDH query (called at exit).
pub fn shutdown() {
    api::monitor_shutdown();
}
