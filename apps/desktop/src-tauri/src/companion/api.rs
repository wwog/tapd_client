//! Read endpoints of the companion server: login state, workspaces, bug
//! list/detail, the notification mirror and the TAPD media proxy.
//!
//! Every endpoint runs the same desktop command core the UI uses
//! (`observe = false`, so phone refreshes never silence desktop notifications)
//! and answers the shared `{ ok, data }` envelope from the module root.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::{commands, notification, server};

use super::{err_data, ok_data, upstream_error, CompanionCtx};
use super::pairing::{authorize, authorize_token, bearer_token, require_logged_in};

/// Login state, app version and signed-in user. Read-only config, no network:
/// this is how the phone renders its "desktop offline" state.
pub(super) async fn api_state(State(ctx): State<CompanionCtx>, headers: HeaderMap) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    let config = ctx.state.config_snapshot();
    ok_data(json!({
        "loggedIn": config.logged_in,
        "version": env!("CARGO_PKG_VERSION"),
        "me": config.me,
    }))
}

pub(super) async fn api_workspaces(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::workspace_context_core(&ctx.app, &ctx.state).await {
        Ok(context) => ok_data(context),
        Err(error) => upstream_error(error),
    }
}

pub(super) async fn api_bugs(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    // Same body the desktop command takes; the container-level serde default
    // lets the phone send just `{ workspaceId }`.
    Json(query): Json<tapd_core::tapd::api::BugQuery>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::bug_list_core(&ctx.app, &ctx.state, query, false).await {
        Ok(page) => ok_data(page),
        Err(error) => upstream_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BugDetailQuery {
    workspace_id: String,
    bug_id: String,
}

pub(super) async fn api_bug_detail(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<BugDetailQuery>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::bug_detail_core(
        &ctx.app,
        &ctx.state,
        &query.workspace_id,
        &query.bug_id,
    )
    .await
    {
        Ok(detail) => ok_data(detail),
        Err(error) => upstream_error(error),
    }
}

/// Mirrors the desktop's current notification entries as a bare array. Read-only:
/// the phone keeps its own read state and never writes back.
pub(super) async fn api_notifications(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    ok_data(json!(notification::items_snapshot()))
}

#[derive(Deserialize)]
pub(super) struct MediaQuery {
    url: String,
    /// Session token, for `<img>`/`<video>` requests that cannot set headers.
    t: Option<String>,
}

/// Proxies a TAPD-hosted image/video with the desktop's webview session. The
/// phone never sees any capability token — its own session token is the only
/// key, and hosts outside `*.tapd.cn` are rejected by the shared fetcher.
pub(super) async fn api_media(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<MediaQuery>,
) -> Response {
    if let Some(response) = authorize_token(&ctx.state, bearer_token(&headers).or(query.t)) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    match server::fetch_tapd_media(&ctx.app, &query.url, range).await {
        Ok(fetch) => server::media_response(fetch),
        Err((status, message)) => err_data(status, "media", &message),
    }
}
