//! TAPD session webview: URL classification, lifecycle, cookie access and the
//! JS evaluation bridge.
//!
//! The hidden webview both holds the TAPD login session and acts as the data
//! bridge for live API calls. Submodules keep those concerns apart:
//! - [`url`]: pure URL classification (login/expiry/marketing-home detection).
//! - [`guard`]: volatile logout guard shared with the commands.
//! - [`window`]: webview creation/reveal and cookie access.
//! - [`bridge`]: synchronous/async expression evaluation.
//! - [`watcher`]: the polling state machine that keeps `loggedIn` in sync.

mod bridge;
mod guard;
mod url;
mod watcher;
mod window;

pub use bridge::{eval_async_json, eval_sync_json, eval_sync_json_once};
pub use guard::begin_logout_guard;
pub use url::looks_like_auth_page;
pub use watcher::spawn_session_watcher;
pub use window::{cookie_header, cookie_value, ensure_session_window};

pub const SESSION_LABEL: &str = "tapd-session";

pub const TAPD_HOME: &str = "https://www.tapd.cn/";
/// Server-rendered login page. TAPD's marketing home does not redirect logged
/// out visitors here, so the hidden webview must open it directly.
pub const TAPD_LOGIN: &str = "https://www.tapd.cn/cloud_logins/login?";
