//! `cache_*` command dispatch used by `feature_router`. Read-only: these
//! commands never hit the network and never write to the cache.

use serde_json::Value;
use tapd_core::tapd::BugQuery;
use tapd_i18n::{tr, tr_args};

use crate::state::SharedState;

use super::Cache;

/// Shape returned to the frontend for every cache read: the stored payload
/// plus the timestamp it was fetched at, or `null`s on a miss.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedPayload {
    data: Option<Value>,
    fetched_at: Option<i64>,
}

fn cached(value: Option<(Value, i64)>) -> CachedPayload {
    match value {
        Some((data, fetched_at)) => CachedPayload {
            data: Some(data),
            fetched_at: Some(fetched_at),
        },
        None => CachedPayload {
            data: None,
            fetched_at: None,
        },
    }
}

fn cached_value(value: Option<(Value, i64)>) -> Value {
    serde_json::to_value(cached(value)).unwrap_or(Value::Null)
}

pub async fn command(state: &SharedState, name: &str, payload: Value) -> Result<Value, String> {
    let cache: &Cache = &state.cache;
    match name {
        "cache_workspace_context" => Ok(cached_value(cache.get_workspace_context::<Value>())),
        "cache_bug_list" => {
            let query = parse_bug_query(&payload)?;
            // Exact query snapshot first; otherwise filter the cached bug rows
            // locally so offline filter changes still show data.
            let value = cache.get_bug_list::<Value>(&query).or_else(|| {
                cache.query_bugs(&query).and_then(|(page, fetched_at)| {
                    serde_json::to_value(page).ok().map(|v| (v, fetched_at))
                })
            });
            Ok(cached_value(value))
        }
        "cache_bug_detail" => {
            let workspace_id = payload_str(&payload, "workspaceId");
            let bug_id = payload_str(&payload, "bugId");
            if workspace_id.is_empty() || bug_id.is_empty() {
                return Err(tr("app.cache.ids").to_string());
            }
            Ok(cached_value(
                cache.get_bug_detail::<Value>(&workspace_id, &bug_id),
            ))
        }
        "cache_workspace_members" => {
            let workspace_id = payload_str(&payload, "workspaceId");
            if workspace_id.is_empty() {
                return Err(tr("app.cache.workspace").to_string());
            }
            Ok(cached_value(
                cache.get_workspace_members::<Value>(&workspace_id),
            ))
        }
        other => Err(format!("unknown cache command: {other}")),
    }
}

fn payload_str(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_bug_query(payload: &Value) -> Result<BugQuery, String> {
    let query = payload
        .get("query")
        .cloned()
        .ok_or_else(|| tr("app.cache.query").to_string())?;
    serde_json::from_value(query).map_err(|error| tr_args("app.cache.query.invalid", &[&error]))
}
