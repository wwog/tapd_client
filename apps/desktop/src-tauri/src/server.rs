//! Loopback HTTP API consumed by the `tapd-mcp` sidecar and dev tooling.
//!
//! The server binds an ephemeral port on `127.0.0.1` and publishes it (plus a
//! bearer token) through the runtime file. Routes:
//! - `/healthz`, `/mcp/call`, `/agent/hook`, `/media` — shipped.
//! - `/dev/*` — debug builds only (`dev` module).

mod auth;
#[cfg(debug_assertions)]
mod dev;
mod proxy;

use std::collections::HashMap;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tauri::AppHandle;
use tapd_core::runtime::RuntimeInfo;

use crate::state::SharedState;

use auth::{authorized, unauthorized};
pub(crate) use proxy::{fetch_tapd_media, media_response};

#[derive(Clone)]
struct ApiState {
    app: AppHandle,
    state: SharedState,
}

/// Starts the loopback API consumed by the `tapd-mcp` sidecar and dev tooling.
pub async fn run(app: AppHandle, state: SharedState) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;

    let token = opaque_token();
    let media_token = opaque_token();
    let runtime = RuntimeInfo {
        app: "tapd-client".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        port: address.port(),
        token,
        media_token,
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    runtime
        .write(&state.paths.runtime_file)
        .map_err(|error| error.to_string())?;
    *state.runtime.lock().expect("runtime lock") = Some(runtime);

    tracing::info!(port = address.port(), "local API listening");

    let api_state = ApiState {
        app,
        state: state.clone(),
    };

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/mcp/call", post(mcp_call))
        .route("/agent/hook", post(agent_hook))
        .route("/media", get(proxy::media_proxy));

    // Debug-only escape hatches for mapping TAPD's internal API. They never
    // ship in a release binary.
    #[cfg(debug_assertions)]
    let router = router
        .route("/dev/eval", post(dev::dev_eval))
        .route("/dev/call", post(dev::dev_call))
        .route("/dev/cookies", get(dev::dev_cookies))
        .route("/dev/export", post(dev::dev_export))
        .route("/dev/feature", post(dev::dev_feature));

    let router = router.with_state(api_state);

    axum::serve(listener, router)
        .await
        .map_err(|error| error.to_string())
}

async fn healthz(State(state): State<ApiState>) -> impl IntoResponse {
    let logged_in = state.state.config.lock().expect("config lock").logged_in;
    let port = state.state.runtime_info().map(|runtime| runtime.port);

    Json(json!({
        "ok": true,
        "app": "tapd-client",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "port": port,
        "loggedIn": logged_in,
    }))
}

async fn mcp_call(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    let tool = payload
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let arguments = payload.get("arguments").cloned().unwrap_or(Value::Null);
    let client = payload
        .get("client")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    match crate::mcp::handle(&ctx.app, &ctx.state, tool, &arguments, client).await {
        Ok(data) => (StatusCode::OK, Json(json!({ "ok": true, "data": data }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Agent 原生 hook 的入口。
///
/// 客户端脚本用 `application/x-www-form-urlencoded` 提交，避免在 shell 里
/// 拼 JSON。鉴权用任务级 `X-Tapd-Hook-Token`，与主 API 的 bearer token 隔离。
async fn agent_hook(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get("x-tapd-hook-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let form = parse_hook_form(&body);
    let task_id = form.get("taskId").map(String::as_str).unwrap_or_default();
    if token.is_empty() || task_id.is_empty() {
        return unauthorized();
    }
    let event = form
        .get("event")
        .map(String::as_str)
        .filter(|event| !event.is_empty())
        .unwrap_or("agent_end");
    let payload = form
        .get("payload")
        .and_then(|payload| serde_json::from_str::<Value>(payload).ok());
    let session_id = form
        .get("sessionId")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            payload
                .as_ref()
                .and_then(crate::agent::extract_hook_session_id)
        });
    let will_continue = form.get("willContinue").is_some_and(|value| value == "true");
    let awaiting_async_work = form
        .get("awaitingAsyncWork")
        .is_some_and(|value| value == "true");

    let report = crate::agent::HookReport {
        token: token.to_string(),
        task_id: task_id.to_string(),
        event: event.to_string(),
        session_id,
        payload,
        will_continue,
        awaiting_async_work,
    };
    match crate::agent::handle_session_hook(&ctx.app, report) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(crate::agent::HookError::Unauthorized) => unauthorized(),
        Err(crate::agent::HookError::UnknownTask) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "unknown task" })),
        ),
        Err(crate::agent::HookError::Internal) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "hook unavailable" })),
        ),
    }
}

/// 解析 `application/x-www-form-urlencoded`。curl 的 `--data-urlencode`
/// 用 `+` 表示空格，percent-decoding 前先还原。
fn parse_hook_form(body: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(body);
    text.split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (decode_form(key), decode_form(value)))
        .collect()
}

fn decode_form(value: &str) -> String {
    let normalized = value.replace('+', " ");
    percent_encoding::percent_decode_str(&normalized)
        .decode_utf8_lossy()
        .into_owned()
}

/// Two concatenated v4 UUIDs: 64 hex characters of unpredictable token.
pub(crate) fn opaque_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(test)]
mod tests {
    use super::parse_hook_form;

    #[test]
    fn parses_url_encoded_hook_payloads() {
        // curl --data-urlencode 会把空格写成 +、引号和换行写成 %XX。
        let body = b"taskId=task-1&event=agent_end&sessionId=abc&payload=%7B%22session_id%22%3A%22abc%22%7D&willContinue=false";
        let form = parse_hook_form(body);

        assert_eq!(form.get("taskId").map(String::as_str), Some("task-1"));
        assert_eq!(form.get("event").map(String::as_str), Some("agent_end"));
        assert_eq!(form.get("sessionId").map(String::as_str), Some("abc"));
        assert_eq!(
            form.get("payload").map(String::as_str),
            Some(r#"{"session_id":"abc"}"#)
        );
        assert_eq!(form.get("willContinue").map(String::as_str), Some("false"));
    }

    #[test]
    fn form_decoding_restores_spaces_and_ignores_empty_pairs() {
        let body = b"a=hello+world&b=&broken";
        let form = parse_hook_form(body);

        assert_eq!(form.get("a").map(String::as_str), Some("hello world"));
        assert_eq!(form.get("b").map(String::as_str), Some(""));
        assert!(!form.contains_key("broken"));
    }
}
