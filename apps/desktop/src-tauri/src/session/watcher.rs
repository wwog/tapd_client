//! Polls the session webview URL and keeps `loggedIn` in sync, including the
//! logout guard, the login-page bounce and session-expiry cleanup.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::guard::{logout_in_progress, now_millis, release_logout_guard};
use super::url::{
    is_bare_tapd_home, is_login_form_url, is_logged_in_url, looks_like_auth_page, should_evaluate,
};
use super::{SESSION_LABEL, TAPD_LOGIN};
use crate::{notification, state::SharedState};

/// Throttles navigating a logged-out webview away from TAPD's marketing home.
static LOGIN_BOUNCE_UNTIL: AtomicU64 = AtomicU64::new(0);

/// How the watcher must react to one observed URL.
#[derive(Debug, Default, PartialEq, Eq)]
struct TickOutcome {
    /// `config.logged_in` after applying this tick.
    logged_in: bool,
    login_changed: bool,
    expired: bool,
    open_login: bool,
    guard_done: bool,
}

/// Facts the watcher needs from one URL sample. `logged_in` is the config
/// state *before* the tick.
#[derive(Clone, Copy)]
struct TickFacts<'a> {
    url: &'a str,
    blank: bool,
    guarded: bool,
    logged_in: bool,
}

/// Pure session state machine for a single tick. Kept separate from the
/// config write so the transition rules are testable in isolation.
fn decide_tick(facts: TickFacts<'_>) -> TickOutcome {
    let mut outcome = TickOutcome {
        logged_in: facts.logged_in,
        ..TickOutcome::default()
    };

    // A logout just cleared cookies and is still navigating: don't read the
    // old page as a fresh login and flip the state back.
    let suppress_login = facts.guarded && !facts.logged_in;

    if !suppress_login && is_logged_in_url(facts.url) && !facts.logged_in {
        outcome.logged_in = true;
        outcome.login_changed = true;
    } else if !is_logged_in_url(facts.url) && facts.logged_in && looks_like_auth_page(facts.url) {
        // The session expired and TAPD bounced us to the login page. The login
        // screen picks it up from the hidden webview; the window itself must
        // never pop up on its own.
        outcome.logged_in = false;
        outcome.login_changed = true;
        outcome.expired = true;
    }

    // The real login form is on screen, so the logout navigation has finished:
    // release the guard and let the next scan log in immediately instead of
    // being ignored for the whole window.
    if facts.guarded && !outcome.logged_in && is_login_form_url(facts.url) {
        outcome.guard_done = true;
    }

    // TAPD's marketing home (or a blank document left behind by a failed logout
    // navigation) never turns into the login form on its own, which would leave
    // the hidden webview stuck there.
    if !suppress_login
        && !outcome.logged_in
        && (is_bare_tapd_home(facts.url) || facts.blank)
    {
        outcome.open_login = true;
    }

    outcome
}

/// Watches the session webview URL and keeps `loggedIn` in sync.
pub fn spawn_session_watcher(app: AppHandle, state: SharedState) {
    tauri::async_runtime::spawn(async move {
        let mut last_url = String::new();
        let mut was_guarded = false;

        loop {
            tokio::time::sleep(Duration::from_millis(1200)).await;

            let Some(window) = app.get_webview_window(SESSION_LABEL) else {
                continue;
            };
            let Ok(url) = window.url() else {
                continue;
            };
            let url_string = url.to_string();
            let guarded = logout_in_progress();
            let blank = url_string.is_empty() || url_string == "about:blank";

            if !should_evaluate(&url_string, &last_url, guarded, was_guarded) {
                continue;
            }
            was_guarded = guarded;
            last_url = url_string.clone();

            let persisted = state.update_config(|config| {
                if !blank {
                    config.last_session_url = Some(url_string.clone());
                }

                let outcome = decide_tick(TickFacts {
                    url: &url_string,
                    blank,
                    guarded,
                    logged_in: config.logged_in,
                });
                if outcome.login_changed {
                    config.logged_in = outcome.logged_in;
                    if outcome.expired {
                        config.me = None;
                        config.me_avatar = None;
                    }
                }
                outcome
            });
            let outcome = match persisted {
                Ok(outcome) => outcome,
                Err(error) => {
                    tracing::warn!(%error, "failed to persist session state");
                    TickOutcome::default()
                }
            };

            if outcome.guard_done {
                release_logout_guard();
            }

            if outcome.open_login && now_millis() > LOGIN_BOUNCE_UNTIL.load(Ordering::SeqCst) {
                LOGIN_BOUNCE_UNTIL.store(now_millis() + 5000, Ordering::SeqCst);
                if let Ok(login) = tauri::Url::parse(TAPD_LOGIN) {
                    let _ = window.navigate(login);
                }
            }

            if outcome.expired {
                // Cached projects/bugs belong to the session that just ended.
                if let Err(error) = state.cache.clear() {
                    tracing::warn!(%error, "failed to clear offline cache after session expiry");
                }
                notification::reset_session();
            }

            if outcome.login_changed {
                if !outcome.expired {
                    // A real login starts a fresh notification baseline: only
                    // changes after the first round may notify.
                    notification::reset_session();
                }
                // The background window never pops up on its own: the login
                // screen mirrors the QR code and the successful login hides it.
                let _ = window.hide();
                let _ = app.emit("session://changed", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: &str = "https://www.tapd.cn/tapd_fe/my/work";
    const LOGIN: &str = "https://www.tapd.cn/cloud_logins/login?";
    const HOME: &str = "https://www.tapd.cn/";

    fn tick(url: &str, blank: bool, guarded: bool, logged_in: bool) -> TickOutcome {
        decide_tick(TickFacts {
            url,
            blank,
            guarded,
            logged_in,
        })
    }

    #[test]
    fn logged_out_user_on_workspace_page_logs_in() {
        let outcome = tick(WORK, false, false, false);
        assert!(outcome.login_changed);
        assert!(outcome.logged_in);
        assert!(!outcome.expired);
        assert!(!outcome.open_login);
    }

    #[test]
    fn logout_guard_suppresses_the_stale_page() {
        let outcome = tick(WORK, false, true, false);
        assert!(!outcome.login_changed);
        assert!(!outcome.logged_in);
        assert!(!outcome.open_login);
    }

    #[test]
    fn auth_page_while_logged_in_expires_the_session() {
        let outcome = tick(LOGIN, false, false, true);
        assert!(outcome.login_changed);
        assert!(outcome.expired);
        assert!(!outcome.logged_in);
        // The login screen picks the expiry up; do not bounce again.
        assert!(!outcome.open_login);
    }

    #[test]
    fn guard_is_released_on_the_login_form() {
        let outcome = tick(LOGIN, false, true, false);
        assert!(outcome.guard_done);
        assert!(!outcome.login_changed);
        // Still guarded, so the bounce stays suppressed on this tick.
        assert!(!outcome.open_login);
    }

    #[test]
    fn bare_home_or_blank_opens_the_login_page() {
        for (url, blank) in [(HOME, false), ("about:blank", true), ("", true)] {
            let outcome = tick(url, blank, false, false);
            assert!(outcome.open_login, "{url} must bounce to login");
            assert!(!outcome.login_changed);
        }
    }

    #[test]
    fn logged_in_user_on_workspace_page_is_a_no_op() {
        let outcome = tick(WORK, false, false, true);
        assert_eq!(outcome, TickOutcome { logged_in: true, ..Default::default() });
    }
}
