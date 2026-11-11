//! Loopback HTTP API consumed by the `tapd-mcp` sidecar and dev tooling.
//!
//! The server binds an ephemeral port on `127.0.0.1` and publishes it (plus a
//! bearer token) through the runtime file. Routes:
//! - `/healthz`, `/mcp/call`, `/media` — shipped.
//! - `/dev/*` — debug builds only (`dev` module).

mod auth;
#[cfg(debug_assertions)]
mod dev;
mod proxy;

use axum::{
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

/// Two concatenated v4 UUIDs: 64 hex characters of unpredictable token.
fn opaque_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
