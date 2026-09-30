//! System monitoring service — port of electron/main/monitor.ts. Samples
//! continuously for the whole app session (never gated on subscriptions);
//! pushes fan out to the renderer via the `oneboost:monitor` event every 2 s.

use oneboost_native::api::{self, MonitorSample};
use std::sync::Mutex;
use std::time::Instant;

pub type MonitorPayload = MonitorSample;

const STALE_FAILS_LOG: u32 = 30;

pub struct Monitor {
    last: Option<MonitorSample>,
    last_error: Option<String>,
    failures: u32,
    prev_instant: Option<Instant>,
}

static MON_LOCK: Mutex<()> = Mutex::new(());

impl Monitor {
    pub fn new() -> Monitor {
        Monitor { last: None, last_error: None, failures: 0, prev_instant: None }
    }

    pub fn set_last(&mut self, s: MonitorSample) {
        self.last = Some(s);
        self.failures = 0;
    }

    /// Latest cached sample; samples once when nothing is cached yet.
    pub fn current(&mut self) -> Option<MonitorSample> {
        if self.last.is_none() {
            return sample_once().map(|s| {
                self.last = Some(s.clone());
                s
            });
        }
        self.last.clone()
    }

    pub fn note_failure(&mut self, e: String) {
        self.failures += 1;
        self.last_error = Some(e);
        if self.failures == 1 || self.failures % STALE_FAILS_LOG == 0 {
            log::error!("[1boost] monitoring sample failed: {}", self.last_error.clone().unwrap_or_default());
        }
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.clone()
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
