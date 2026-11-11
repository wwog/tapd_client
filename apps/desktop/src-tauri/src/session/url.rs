//! Pure URL classification for the TAPD session webview.

/// True for the marketing home (`tapd.cn/`), which is not a login page.
pub fn is_bare_tapd_home(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let Some((_, rest)) = lower.split_once("tapd.cn") else {
        return false;
    };
    let path = rest.split(['?', '#']).next().unwrap_or("");
    path.is_empty() || path == "/"
}

/// TAPD redirects into a workspace shell after a successful login.
pub fn is_logged_in_url(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    if !lower.contains("tapd.cn") || looks_like_auth_page(&lower) {
        return false;
    }

    let Some((_, rest)) = lower.split_once("tapd.cn") else {
        return false;
    };
    let path = rest.trim_start_matches('/');
    if path.is_empty() {
        return false;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");

    if path.starts_with("tapd_fe/")
        || path.starts_with("my_work")
        || path.starts_with("company/")
        || path.starts_with("dashboard")
    {
        return true;
    }

    // Workspace-scoped pages start with the numeric workspace id.
    let first = path.split('/').next().unwrap_or("");
    !first.is_empty() && first.chars().all(|c| c.is_ascii_digit())
}

pub fn looks_like_auth_page(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("/login")
        || lower.contains("/signin")
        || lower.contains("cloud_logins")
        || lower.contains("/register")
}

/// The actual TAPD login form (not an OAuth callback). Reaching it means the
/// logout cleanup finished navigating, so the logout guard can be released.
pub fn is_login_form_url(raw: &str) -> bool {
    raw.to_ascii_lowercase().contains("/cloud_logins/login")
}

/// Decides whether the session watcher must re-evaluate a URL.
///
/// An unchanged URL is normally skipped to avoid rewriting the config every
/// tick. Two cases must still be evaluated: while the logout guard is active
/// (a login may finish inside it), the first tick after it expires (that login
/// was suppressed and must not be lost), and a blank page (a failed logout
/// navigation needs to be repaired).
pub(super) fn should_evaluate(url: &str, last_url: &str, guarded: bool, was_guarded: bool) -> bool {
    let blank = url.is_empty() || url == "about:blank";
    url != last_url || guarded || was_guarded || blank
}

#[cfg(test)]
mod tests {
    use super::{is_login_form_url, should_evaluate};

    #[test]
    fn reevaluates_once_after_the_logout_guard_expires() {
        let url = "https://www.tapd.cn/tapd_fe/my/work";
        // Same URL, no guard: skipped on purpose.
        assert!(!should_evaluate(url, url, false, false));
        // Same URL right after the guard ended: the suppressed login must be
        // picked up instead of staying logged out forever.
        assert!(should_evaluate(url, url, false, true));
        // While the guard is active the URL is re-checked every tick.
        assert!(should_evaluate(url, url, true, true));
    }

    #[test]
    fn reevaluates_changed_and_blank_urls() {
        let login = "https://www.tapd.cn/cloud_logins/login?";
        assert!(should_evaluate(login, "about:blank", false, false));
        assert!(should_evaluate("about:blank", "about:blank", false, false));
        assert!(should_evaluate("", "", false, false));
    }

    #[test]
    fn detects_the_real_login_form_only() {
        assert!(is_login_form_url("https://www.tapd.cn/cloud_logins/login?"));
        assert!(is_login_form_url(
            "https://www.tapd.cn/cloud_logins/login?redirect_url=https%3A%2F%2Fwww.tapd.cn%2F"
        ));
        // OAuth callbacks are part of an in-flight login, not the form.
        assert!(!is_login_form_url("https://www.tapd.cn/tapd_fe/my/work"));
        assert!(!is_login_form_url(
            "https://www.tapd.cn/cloud_logins/wework_callback"
        ));
    }
}
