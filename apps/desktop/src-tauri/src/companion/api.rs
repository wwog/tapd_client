//! Read and write endpoints of the companion server: login state, workspaces,
//! the members directory, bug list/detail, bug writes (comment / update-field /
//! transitions / transition / claim), the notification mirror and the TAPD
//! media proxy.
//!
//! Every read runs the same desktop command core the UI uses (`observe =
//! false`, so phone refreshes never silence desktop notifications); every write
//! runs the same desktop command core the bug detail panel uses. All answer the
//! shared `{ ok, data }` envelope from the module root.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tapd_core::tapd::WorkspaceMember;

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

// ---------------------------------------------------------------------------
// Members directory
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MembersQuery {
    workspace_id: String,
}

/// People-directory freshness window, matching the desktop UI's two-hour
/// refresh cadence (`MEMBERS_TTL_MS` in the frontend `lib/members.ts`).
const MEMBERS_TTL_SECS: i64 = 2 * 60 * 60;

/// Whether a members snapshot written at `fetched_at` (unix seconds) is still
/// within the freshness window at `now` (unix seconds).
fn members_cache_fresh(fetched_at: i64, now: i64) -> bool {
    now - fetched_at < MEMBERS_TTL_SECS
}

/// Workspace people directory. Cache-first on the same snapshot the desktop
/// UI writes through (`workspace_members` command core): a fresh directory
/// answers without re-requesting TAPD, a stale or missing one falls back to
/// the live fetch, which also refreshes the snapshot for the next reader.
pub(super) async fn api_members(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<MembersQuery>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }

    let workspace_id = query.workspace_id.trim();
    if let Some((members, fetched_at)) = ctx
        .state
        .cache
        .get_workspace_members::<Vec<WorkspaceMember>>(workspace_id)
    {
        if members_cache_fresh(fetched_at, chrono::Utc::now().timestamp()) {
            return ok_data(members);
        }
    }

    match commands::workspace_members_core(&ctx.app, &ctx.state, workspace_id).await {
        Ok(members) => ok_data(members),
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

// ---------------------------------------------------------------------------
// Bug writes
// ---------------------------------------------------------------------------
//
// The phone's write surface: thin endpoints over the same command cores the
// desktop bug detail panel uses (see `commands.rs`). Payloads pass through
// unchanged; validation and TAPD errors surface as the same user-facing text
// the desktop would show (`upstream`). Void writes answer `data: {}`.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BugCommentRequest {
    workspace_id: String,
    bug_id: String,
    comment: String,
}

/// Appends a comment to a bug.
pub(super) async fn api_bug_comment(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<BugCommentRequest>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::bug_add_comment_core(
        &ctx.app,
        &request.workspace_id,
        &request.bug_id,
        &request.comment,
    )
    .await
    {
        Ok(()) => ok_data(json!({})),
        Err(error) => upstream_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BugUpdateFieldRequest {
    workspace_id: String,
    bug_id: String,
    field: String,
    value: String,
    /// `true` for the explicit claim button; defaults to `false`.
    #[serde(default)]
    claim: bool,
}

/// Updates one user field (`current_owner` / `de`); field and value pass
/// through to the desktop command core unchanged.
pub(super) async fn api_bug_update_field(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<BugUpdateFieldRequest>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::bug_update_field_core(
        &ctx.app,
        &ctx.state,
        &request.workspace_id,
        &request.bug_id,
        &request.field,
        &request.value,
        request.claim,
    )
    .await
    {
        Ok(()) => ok_data(json!({})),
        Err(error) => upstream_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BugTransitionsQuery {
    workspace_id: String,
    bug_id: String,
}

/// Lists the workflow transitions available from a bug's current status.
pub(super) async fn api_bug_transitions(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<BugTransitionsQuery>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::bug_transitions_core(&ctx.app, &query.workspace_id, &query.bug_id).await {
        Ok(info) => ok_data(info),
        Err(error) => upstream_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BugTransitionRequest {
    workspace_id: String,
    bug_id: String,
    status: String,
    /// Optional transition-form overrides, same shape the desktop command
    /// takes: `{"current_owner": "张三"}` or `[{"name": ..., "value": ...}]`.
    #[serde(default)]
    form: Option<Value>,
}

/// Moves a bug to another workflow status; `form` passes through to the
/// desktop command core as the caller's field overrides.
pub(super) async fn api_bug_transition(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<BugTransitionRequest>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    match commands::bug_transition_core(
        &ctx.app,
        &request.workspace_id,
        &request.bug_id,
        &request.status,
        request.form,
    )
    .await
    {
        Ok(result) => ok_data(result),
        Err(error) => upstream_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BugClaimRequest {
    workspace_id: String,
    bug_id: String,
}

/// The owner field (处理人) the claim endpoint writes. Must stay inside the
/// desktop command core's `EDITABLE_USER_FIELDS`.
const CLAIM_FIELD: &str = "current_owner";

/// Resolves the owner value for the claim endpoint: the desktop's configured
/// nickname, trimmed. A missing/blank `me` is a business error the phone
/// renders directly — the desktop simply never captured the current user —
/// not an upstream failure.
fn claim_owner(me: Option<String>) -> Result<String, Response> {
    let nick = me
        .map(|nick| nick.trim().to_string())
        .filter(|nick| !nick.is_empty());
    nick.ok_or_else(|| {
        err_data(
            StatusCode::BAD_REQUEST,
            "no_current_user",
            "桌面端未获取到当前用户",
        )
    })
}

/// Claims a bug: writes the desktop's current user into 处理人 with
/// `claim = true`, so the assignment counts as our own write and never comes
/// back as a transfer notification.
pub(super) async fn api_bug_claim(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<BugClaimRequest>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if let Some(response) = require_logged_in(&ctx.state) {
        return response;
    }
    let owner = match claim_owner(ctx.state.config_snapshot().me) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match commands::bug_update_field_core(
        &ctx.app,
        &ctx.state,
        &request.workspace_id,
        &request.bug_id,
        CLAIM_FIELD,
        &owner,
        true,
    )
    .await
    {
        Ok(()) => ok_data(json!({})),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bug_write::EDITABLE_USER_FIELDS;
    use axum::body::to_bytes;

    async fn envelope_of(response: Response) -> (StatusCode, serde_json::Value) {
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.expect("read response body");
        let json =
            serde_json::from_slice(&bytes).expect("parse response body as JSON");
        (parts.status, json)
    }

    #[tokio::test]
    async fn claim_without_a_desktop_user_is_a_400_business_error() {
        let response = claim_owner(None).expect_err("missing me must be rejected");

        let (status, json) = envelope_of(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["ok"], false);
        assert_eq!(json["code"], "no_current_user");
        assert_eq!(json["error"], "桌面端未获取到当前用户");
    }

    #[tokio::test]
    async fn claim_with_a_blank_desktop_user_is_rejected_too() {
        let response =
            claim_owner(Some("   ".to_string())).expect_err("blank me counts as missing");

        let (status, json) = envelope_of(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["code"], "no_current_user");
    }

    #[test]
    fn claim_uses_the_trimmed_desktop_nickname() {
        assert_eq!(
            claim_owner(Some(" 张三 ".to_string())).ok(),
            Some("张三".to_string())
        );
    }

    #[test]
    fn claim_writes_the_owner_field_the_core_accepts() {
        // 硬编码的认领字段必须一直是桌面核心允许编辑的字段之一，否则核心会
        // 以「只支持修改处理人与开发人员」拒绝，认领端点整体失效。
        assert!(EDITABLE_USER_FIELDS.contains(&CLAIM_FIELD));
    }

    #[test]
    fn members_cache_is_fresh_within_two_hours_only() {
        let now = 1_800_000_000;
        // 窗口内新鲜；整 2 小时及以上视为过期（与前端 `MEMBERS_TTL_MS` 一致）。
        assert!(members_cache_fresh(now - MEMBERS_TTL_SECS + 1, now));
        assert!(!members_cache_fresh(now - MEMBERS_TTL_SECS, now));
        assert!(!members_cache_fresh(now - MEMBERS_TTL_SECS - 1, now));
    }

    #[test]
    fn update_field_request_defaults_claim_to_false() {
        let request: BugUpdateFieldRequest = serde_json::from_str(
            r#"{"workspaceId":"w1","bugId":"1001","field":"current_owner","value":"张三"}"#,
        )
        .expect("parse request without claim");

        assert_eq!(request.workspace_id, "w1");
        assert_eq!(request.bug_id, "1001");
        assert_eq!(request.field, "current_owner");
        assert_eq!(request.value, "张三");
        assert!(!request.claim, "claim must default to false");
    }

    #[test]
    fn update_field_request_passes_claim_through() {
        let request: BugUpdateFieldRequest = serde_json::from_str(
            r#"{"workspaceId":"w1","bugId":"1001","field":"de","value":"李四","claim":true}"#,
        )
        .expect("parse request with claim");

        assert!(request.claim);
    }

    #[test]
    fn transition_request_form_is_optional_and_passes_through() {
        let without: BugTransitionRequest = serde_json::from_str(
            r#"{"workspaceId":"w1","bugId":"1001","status":"resolved"}"#,
        )
        .expect("parse request without form");
        assert_eq!(without.form, None);

        let with: BugTransitionRequest = serde_json::from_str(
            r#"{"workspaceId":"w1","bugId":"1001","status":"resolved","form":{"current_owner":"张三"}}"#,
        )
        .expect("parse request with form");
        assert_eq!(with.form, Some(json!({ "current_owner": "张三" })));
    }

    #[test]
    fn comment_and_transition_queries_parse_camel_case() {
        let comment: BugCommentRequest = serde_json::from_str(
            r#"{"workspaceId":"w1","bugId":"1001","comment":"已修复"}"#,
        )
        .expect("parse comment request");
        assert_eq!(comment.comment, "已修复");

        let query: BugTransitionsQuery =
            serde_json::from_str(r#"{"workspaceId":"w1","bugId":"1001"}"#)
                .expect("parse transitions query");
        assert_eq!(query.workspace_id, "w1");
        assert_eq!(query.bug_id, "1001");

        let members: MembersQuery =
            serde_json::from_str(r#"{"workspaceId":"w1"}"#).expect("parse members query");
        assert_eq!(members.workspace_id, "w1");
    }
}
