//! Bearer-token auth shared by every loopback route.

use axum::{
    http::{header, HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};

use crate::state::SharedState;

pub(super) fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "unauthorized" })),
    )
}

pub(super) fn authorized(state: &SharedState, headers: &HeaderMap) -> bool {
    let Some(runtime) = state.runtime_info() else {
        return false;
    };
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };

    value == format!("Bearer {}", runtime.token)
}
