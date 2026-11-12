//! Whitelisted feature proxy for the companion: `POST /companion/api/feature`.
//!
//! The desktop exposes one generic command surface to its feature windows
//! (`feature_router::dispatch`, names like `agent_*` / `notification_*` /
//! `coworker_*`). Mobile v2 reuses that surface for its new capabilities —
//! Agent task view/review/history/enqueue/cancel/retry, Agent config, check-in
//! notification settings and coworker packages — through the narrow allowlist
//! below, so the LAN endpoint can never become a generic command relay.
//!
//! Deliberately no `require_logged_in` gate: Agent config/history and coworker
//! packages are meaningful without a TAPD session, and the whitelisted
//! commands that do depend on one return their own business error from the
//! desktop side, which passes through unchanged (`ok: false, upstream`).
//!
//! Rate limiting is a fresh per-IP 60/minute budget on top of session auth;
//! the pairing limiter stays pairing-specific.

use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::{feature_router, state::SharedState};

use super::{
    pairing::{authorize, RateLimiter},
    err_data, ok_data, upstream_error, CompanionCtx,
};

/// Feature commands the companion may call. Every name must be an arm of
/// `feature_router::dispatch`; anything else answers 403 `forbidden` before
/// the desktop command layer is ever reached.
const ALLOWED_FEATURES: &[&str] = &[
    // Agent 任务：查看 / 历史 / 入队
    "agent_tasks_list",
    "agent_tasks_history",
    "agent_enqueue_bug",
    // Agent 审核 / 合并
    "agent_review_approve",
    "agent_review_stop",
    "agent_review_diff",
    "agent_merge_start",
    "agent_merge_verify",
    // Agent 任务控制
    "agent_task_cancel",
    "agent_task_retry",
    // Agent 配置与检测
    "agent_config_get",
    "agent_config_set",
    "agent_runtimes",
    "agent_scan",
    // 通知设置
    "notification_settings_get",
    "notification_settings_set",
    // 同事包
    "coworker_list",
    "coworker_select",
];

/// Feature-proxy budget: at most 60 requests per IP per minute.
const FEATURE_MAX_REQUESTS: usize = 60;
const FEATURE_WINDOW: Duration = Duration::from_secs(60);

/// The feature proxy's own limiter; the budget numbers live here only.
pub(super) fn rate_limiter() -> RateLimiter {
    RateLimiter::new(FEATURE_MAX_REQUESTS, FEATURE_WINDOW)
}

#[derive(Deserialize)]
pub(super) struct FeatureRequest {
    name: String,
    /// Command payload; commands that need none accept `null` (serde default).
    #[serde(default)]
    payload: Value,
}

/// Whitelisted feature proxy. Check order: session auth first (an
/// unauthenticated caller never consumes the paired phone's budget), then the
/// rate limit, then the allowlist, then dispatch.
pub(super) async fn api_feature(
    State(ctx): State<CompanionCtx>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<FeatureRequest>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    let allowed = ctx
        .feature_limiter
        .lock()
        .expect("feature rate limiter lock")
        .allows(peer.ip(), Instant::now());
    if !allowed {
        return err_data(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "请求过于频繁，请稍后再试",
        );
    }
    feature_response(&ctx.app, &ctx.state, &request.name, request.payload).await
}

/// Allowlist gate plus dispatch, HTTP-free so the contract is unit-testable
/// without a live server.
async fn feature_response(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Response {
    if let Some(rejection) = whitelist_rejection(name) {
        return rejection;
    }
    dispatch_response(feature_router::dispatch(app, state, name, payload).await)
}

/// A name outside the allowlist is rejected with 403 `forbidden`; whitelisted
/// names pass through (`None`).
fn whitelist_rejection(name: &str) -> Option<Response> {
    (!ALLOWED_FEATURES.contains(&name)).then(|| {
        err_data(StatusCode::FORBIDDEN, "forbidden", "该功能未对移动端开放")
    })
}

/// Maps `dispatch`'s result onto the companion envelope: `Ok(data)` wraps as
/// `{ ok: true, data }`; `Err(text)` keeps the same 502 upstream shape — and
/// the same user-facing message — as the read endpoints.
fn dispatch_response(result: Result<Value, String>) -> Response {
    match result {
        Ok(data) => ok_data(data),
        Err(error) => upstream_error(error),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::collections::HashSet;
    use std::net::{IpAddr, Ipv4Addr};

    /// The feature surface mobile v2 documents. The allowlist must cover every
    /// documented name (each one is also an arm of `feature_router::dispatch`).
    const DOCUMENTED_FEATURES: &[&str] = &[
        "agent_tasks_list",
        "agent_tasks_history",
        "agent_enqueue_bug",
        "agent_review_approve",
        "agent_review_stop",
        "agent_review_diff",
        "agent_merge_start",
        "agent_merge_verify",
        "agent_task_cancel",
        "agent_task_retry",
        "agent_config_get",
        "agent_config_set",
        "agent_runtimes",
        "agent_scan",
        "notification_settings_get",
        "notification_settings_set",
        "coworker_list",
        "coworker_select",
    ];

    async fn envelope_of(response: Response) -> (StatusCode, serde_json::Value) {
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.expect("read response body");
        let json =
            serde_json::from_slice(&bytes).expect("parse response body as JSON");
        (parts.status, json)
    }

    #[tokio::test]
    async fn feature_outside_whitelist_is_rejected_as_forbidden() {
        // 桌面自身的能力（如 MCP 策略）不允许被局域网端点转发。
        let rejection =
            whitelist_rejection("mcp_policy_set").expect("names outside the allowlist are rejected");

        let (status, json) = envelope_of(rejection).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["ok"], false);
        assert_eq!(json["code"], "forbidden");
        assert!(!json["error"].as_str().expect("error message").is_empty());
    }

    #[test]
    fn whitelisted_names_pass_the_gate() {
        assert!(whitelist_rejection("agent_review_approve").is_none());
        assert!(whitelist_rejection("agent_enqueue_bug").is_none());
        assert!(whitelist_rejection("coworker_list").is_none());
    }

    #[test]
    fn whitelist_covers_the_documented_companion_surface() {
        for name in DOCUMENTED_FEATURES {
            assert!(
                ALLOWED_FEATURES.contains(name),
                "documented feature missing from the allowlist: {name}"
            );
        }
        // 单一事实来源：白名单里不允许出现重复项。
        let mut seen = HashSet::new();
        for name in ALLOWED_FEATURES {
            assert!(seen.insert(*name), "duplicate allowlist entry: {name}");
        }
    }

    #[tokio::test]
    async fn dispatch_error_passes_through_as_ok_false() {
        // 白名单放行的名字若 dispatch 不认识（或桌面侧报业务错误），错误文案
        // 原样透传，不吞错。
        let response = dispatch_response(Err("unknown agent command: agent_nonexistent".to_string()));

        let (status, json) = envelope_of(response).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(json["ok"], false);
        assert_eq!(json["code"], "upstream");
        assert_eq!(json["error"], "unknown agent command: agent_nonexistent");
    }

    #[tokio::test]
    async fn dispatch_result_wraps_as_ok_true() {
        let response = dispatch_response(Ok(serde_json::json!({ "task": { "id": "t1" } })));

        let (status, json) = envelope_of(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["ok"], true);
        assert_eq!(json["data"]["task"]["id"], "t1");
    }

    #[test]
    fn feature_rate_limit_blocks_requests_over_the_minute_budget() {
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut limiter = rate_limiter();
        let now = Instant::now();

        for _ in 0..FEATURE_MAX_REQUESTS {
            assert!(limiter.allows(ip, now));
        }
        // 第 61 次/分钟：拒绝。
        assert!(!limiter.allows(ip, now));
    }
}
