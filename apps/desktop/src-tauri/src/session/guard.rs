//! Volatile session guards. Both are process-wide timestamps, not persisted:
//! they only suppress watcher actions while an asynchronous navigation is in
//! flight.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// While a logout is running, the URL watcher must not resurrect `loggedIn`
/// from the still-loaded TAPD page (navigation happens asynchronously).
static LOGOUT_GUARD_UNTIL: AtomicU64 = AtomicU64::new(0);

pub(super) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Suppresses session auto-detection for `millis`, so a logout does not flip
/// straight back to "logged in" before TAPD lands on the login page.
pub fn begin_logout_guard(millis: u64) {
    LOGOUT_GUARD_UNTIL.store(now_millis() + millis, Ordering::SeqCst);
}

pub(super) fn logout_in_progress() -> bool {
    now_millis() < LOGOUT_GUARD_UNTIL.load(Ordering::SeqCst)
}

/// Releases the guard once the logout navigation reached the login form.
pub(super) fn release_logout_guard() {
    LOGOUT_GUARD_UNTIL.store(0, Ordering::SeqCst);
}
