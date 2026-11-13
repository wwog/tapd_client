//! Project files routed for the mobile companion.
//!
//! Same contract as the desktop commands: a workspace id selects the project's
//! configured folder, `path` is relative to it and resolves through
//! [`crate::fs`] (absolute paths, `..`, NUL and symlink escapes are rejected).
//! Reading is always available; writing overwrites existing text files and is
//! off until the desktop (or a manager phone) enables it.
//! JSON routes use the paired-device bearer token; `file/raw` also accepts the
//! media-style `?t=` capability because `<img>`/`<video>` cannot set headers.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::json;
use tapd_i18n::tr;

use crate::{
    fs::{self, FsError, FsErrorKind},
    server,
};

use super::devices::manage_guard;
use super::pairing::{authorize, authorize_token, bearer_token};
use super::{err_data, ok_data, CompanionCtx};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilesQuery {
    workspace_id: String,
    /// Relative directory; omitted or "" is the project root.
    #[serde(default)]
    path: String,
}

/// `GET /companion/api/files?workspaceId=&path=` — one directory level.
pub(super) async fn api_files(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<FilesQuery>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    let root = match fs::root_for(&ctx.app, &query.workspace_id) {
        Ok(root) => root,
        Err(error) => return fs_error(&error),
    };
    let path = query.path;
    match tokio::task::spawn_blocking(move || fs::list_dir(&root, &path)).await {
        Ok(Ok(listing)) => ok_data(listing),
        Ok(Err(error)) => fs_error(&error),
        Err(error) => err_data(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

/// `GET /companion/api/file?workspaceId=&path=` — one file preview payload.
pub(super) async fn api_file(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<FilesQuery>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    let root = match fs::root_for(&ctx.app, &query.workspace_id) {
        Ok(root) => root,
        Err(error) => return fs_error(&error),
    };
    let path = query.path;
    match tokio::task::spawn_blocking(move || fs::read_file(&root, &path)).await {
        Ok(Ok(content)) => ok_data(content),
        Ok(Err(error)) => fs_error(&error),
        Err(error) => err_data(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawQuery {
    /// Session token fallback for media elements; a bearer header still wins.
    t: Option<String>,
    workspace_id: String,
    #[serde(default)]
    path: String,
}

/// `GET /companion/api/file/raw?t=<token>&workspaceId=&path=` — file bytes.
pub(super) async fn api_file_raw(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Query(query): Query<RawQuery>,
) -> Response {
    if let Some(response) = authorize_token(&ctx.state, bearer_token(&headers).or(query.t)) {
        return response;
    }
    let root = match fs::root_for(&ctx.app, &query.workspace_id) {
        Ok(root) => root,
        Err(error) => return fs_error(&error),
    };
    let path = query.path;
    let result = tokio::task::spawn_blocking(move || fs::read_bytes(&root, &path)).await;
    let (bytes, content_type) = match result {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => return fs_error(&error),
        Err(error) => return err_data(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    server::file_stream_response(bytes, &content_type, range)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WriteRequest {
    workspace_id: String,
    path: String,
    /// Required: a missing body must not silently blank the file.
    text: String,
    /// Loaded mtime in milliseconds; a mismatch is a conflict unless `force`.
    #[serde(default)]
    mtime_ms: Option<u64>,
    #[serde(default)]
    force: bool,
}

/// `GET /companion/api/file/write` — whether phones may edit project files.
pub(super) async fn api_file_write_state(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    let enabled = ctx.state.config_snapshot().companion.allow_file_write;
    ok_data(json!({ "enabled": enabled }))
}

/// `POST /companion/api/file/write` — overwrite one existing text file.
pub(super) async fn api_file_write(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<WriteRequest>,
) -> Response {
    if let Some(response) = authorize(&ctx.state, &headers) {
        return response;
    }
    if !ctx.state.config_snapshot().companion.allow_file_write {
        return err_data(
            StatusCode::FORBIDDEN,
            "write_disabled",
            tr("companion.files.writeDisabled"),
        );
    }
    let root = match fs::root_for(&ctx.app, &request.workspace_id) {
        Ok(root) => root,
        Err(error) => return fs_error(&error),
    };
    let result = tokio::task::spawn_blocking(move || {
        fs::write_file(
            &root,
            &request.path,
            &request.text,
            request.mtime_ms,
            request.force,
        )
    })
    .await;
    match result {
        Ok(Ok(stat)) => ok_data(stat),
        Ok(Err(error)) => fs_error(&error),
        Err(error) => err_data(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WriteSettingRequest {
    enabled: bool,
}

/// `POST /companion/api/file/write-setting` — manager-only switch.
pub(super) async fn api_file_write_setting(
    State(ctx): State<CompanionCtx>,
    headers: HeaderMap,
    Json(request): Json<WriteSettingRequest>,
) -> Response {
    if let Err(response) = manage_guard(&ctx, &headers) {
        return response;
    }
    match ctx
        .state
        .update_config(|config| config.companion.allow_file_write = request.enabled)
    {
        Ok(()) => ok_data(json!({ "enabled": request.enabled })),
        Err(error) => err_data(
            StatusCode::INTERNAL_SERVER_ERROR,
            "io",
            &format!("{}: {error}", tr("companion.files.writeSetting")),
        ),
    }
}

/// JSON error envelope for a failed filesystem operation.
fn fs_error(error: &FsError) -> Response {
    let (status, code) = match error.kind {
        FsErrorKind::NoFolder => (StatusCode::NOT_FOUND, "no_folder"),
        FsErrorKind::InvalidRequest => (StatusCode::BAD_REQUEST, "bad_request"),
        FsErrorKind::OutsideRoot => (StatusCode::FORBIDDEN, "forbidden"),
        FsErrorKind::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        FsErrorKind::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
        FsErrorKind::Conflict => (StatusCode::CONFLICT, "conflict"),
        FsErrorKind::Io => (StatusCode::INTERNAL_SERVER_ERROR, "io"),
    };
    err_data(status, code, &error.message())
}

#[cfg(test)]
mod tests {
    use super::FilesQuery;

    #[test]
    fn path_defaults_to_the_project_root() {
        let query: FilesQuery =
            serde_json::from_str(r#"{"workspaceId":"42"}"#).expect("parse query");
        assert_eq!(query.workspace_id, "42");
        assert_eq!(query.path, "");
    }

    #[test]
    fn path_is_required_to_be_relative_but_may_be_nested() {
        let query: FilesQuery =
            serde_json::from_str(r#"{"workspaceId":"42","path":"src/main.rs"}"#)
                .expect("parse query");
        assert_eq!(query.path, "src/main.rs");
    }
}
