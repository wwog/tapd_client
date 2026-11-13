//! Read-only files routed for the mobile companion.
//!
//! Same contract as the desktop commands: a workspace id selects the project's
//! configured folder, `path` is relative to it and resolves through
//! [`crate::fs`] (absolute paths, `..`, NUL and symlink escapes are rejected).
//! JSON routes use the paired-device bearer token; `file/raw` also accepts the
//! media-style `?t=` capability because `<img>`/`<video>` cannot set headers.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use serde::Deserialize;

use crate::{
    fs::{self, FsError, FsErrorKind},
    server,
};

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

/// JSON error envelope for a failed filesystem operation.
fn fs_error(error: &FsError) -> Response {
    let (status, code) = match error.kind {
        FsErrorKind::NoFolder => (StatusCode::NOT_FOUND, "no_folder"),
        FsErrorKind::InvalidRequest => (StatusCode::BAD_REQUEST, "bad_request"),
        FsErrorKind::OutsideRoot => (StatusCode::FORBIDDEN, "forbidden"),
        FsErrorKind::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        FsErrorKind::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
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
