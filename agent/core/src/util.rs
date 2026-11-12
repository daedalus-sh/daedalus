//! Small helpers every part of a node shares.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// The service's stop, and the updater's "check now": one token every
/// worker holds a clone of. Waiting on it is a condition variable, not a
/// poll — a stop reaches every waiter at once.
#[derive(Clone, Default)]
pub struct Shutdown(Arc<(Mutex<Flags>, Condvar)>);

#[derive(Default)]
struct Flags {
    stopped: bool,
    /// Bumped by `nudge`; a waiter that asked for nudges wakes when it moves.
    nudges: u64,
}

impl Shutdown {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stop: every wait returns true from now on.
    pub fn stop(&self) {
        let (lock, cv) = &*self.0;
        lock.lock_ok().stopped = true;
        cv.notify_all();
    }

    pub fn is_stopped(&self) -> bool {
        self.0 .0.lock_ok().stopped
    }

    /// Wake the waiters that asked for nudges (`wait_nudged`) without
    /// stopping anyone.
    pub fn nudge(&self) {
        let (lock, cv) = &*self.0;
        lock.lock_ok().nudges += 1;
        cv.notify_all();
    }

    /// How many nudges so far: what `wait_nudged` compares against, taken
    /// before the caller looks at what a nudge asks for, so none is missed.
    pub fn nudges(&self) -> u64 {
        self.0 .0.lock_ok().nudges
    }

    /// Wait `total` or until stopped; true when stopped.
    pub fn wait(&self, total: Duration) -> bool {
        self.wait_for(total, None)
    }

    /// The same, also cut short by a nudge after `since` (`nudges`).
    pub fn wait_nudged(&self, since: u64, total: Duration) -> bool {
        self.wait_for(total, Some(since))
    }

    fn wait_for(&self, total: Duration, since: Option<u64>) -> bool {
        let until = std::time::Instant::now() + total;
        let (lock, cv) = &*self.0;
        let mut f = lock.lock_ok();
        loop {
            if f.stopped {
                return true;
            }
            if since.is_some_and(|s| f.nudges != s) {
                return false;
            }
            let left = until.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            f = cv
                .wait_timeout(f, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }
}

/// A mutex's guard whether or not a thread panicked holding it: every
/// lock here guards plain data that stays consistent between statements,
/// so a poisoned one is taken as it is rather than spreading the panic.
pub trait LockExt<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for std::sync::Mutex<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A unit variant as serde names it on the wire: the one spelling, for a
/// log line or a label (`Display` of the wire enums).
pub fn wire_name<T: serde::Serialize>(v: &T, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => f.write_str(&s),
        _ => f.write_str("?"),
    }
}

/// `host:port`, `a.b.c.d:port` or `[v6]:port`, with a port that is not 0.
pub fn valid_host_port(s: &str) -> bool {
    let Some((host, port)) = s.rsplit_once(':') else {
        return false;
    };
    let host_ok = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(v6) => v6.parse::<std::net::Ipv6Addr>().is_ok(),
        None => {
            !host.is_empty()
                && host.len() <= 253
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        }
    };
    host_ok && port.parse::<u16>().is_ok_and(|p| p != 0)
}
