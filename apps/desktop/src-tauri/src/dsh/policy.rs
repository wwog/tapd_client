//! Permission modes and the policy plugin's notice channel (P3).
//!
//! Contract: docs/DSH.md §9.3. The rule table itself lives in the Cordis plugin
//! `dsh/plugins/tapd-policy`, which reads the mode from the environment; this
//! module owns the persisted mode and the `notice` frames that plugin sends
//! when the mode is `notify`.
//!
//! `command` is the feature surface both windows and the paired phone use.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::bridge::BridgeState;
use crate::agent_settings::{self, PermissionMode};
use tapd_i18n::tr_args;

/// Dispatches `dsh_policy_get` / `dsh_policy_set`.
pub async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    match name {
        "dsh_policy_get" => Ok(mode_json(agent_settings::config_for(app).permission_mode)),
        "dsh_policy_set" => set(app, &payload).await,
        other => Err(format!("unknown dsh policy command: {other}")),
    }
}

/// The mode travels as its kebab-case serde name (`auto` / `notify` / `full`).
fn mode_json(mode: PermissionMode) -> Value {
    json!({ "mode": mode })
}

/// Validates, writes and pushes the runtime-wide default.
///
/// The default is not startup-only: the plugin keeps it in memory and uses it
/// for every session without an override, so the next tool call already sees
/// the new value.
async fn set(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let raw = payload
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let mode = PermissionMode::parse(raw)
        .ok_or_else(|| tr_args("dsh.policy.unknown", &[&raw]))?;
    let mut config = agent_settings::config_for(app);
    config.permission_mode = mode;
    let saved = agent_settings::save_for(app, &config)?;
    push_default(app, saved.permission_mode);
    Ok(mode_json(saved.permission_mode))
}

/// Best effort: a runtime that is not up already has the new default in its
/// next environment; a live one applies it on the next tool call.
fn push_default(app: &AppHandle, mode: PermissionMode) {
    let Some(bridge) = app.try_state::<Arc<BridgeState>>() else {
        return;
    };
    if let Err(error) = bridge.inner().set_default_mode(mode) {
        tracing::debug!(%error, "default permission mode was not queued");
    }
}

/// One `notice` frame from the policy plugin: notify mode is telling us what it
/// is about to run. Advisory by contract — the call has already been allowed.
pub fn notice(message: &Value) {
    let tool = message.get("tool").and_then(Value::as_str).unwrap_or("");
    let target = message.get("target").and_then(Value::as_str).unwrap_or("");
    let risk = message.get("risk").and_then(Value::as_str).unwrap_or("");
    crate::notification::agent::notice(tool, target, risk);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_keep_their_wire_names() {
        assert_eq!(mode_json(PermissionMode::Auto)["mode"], "auto");
        assert_eq!(mode_json(PermissionMode::Notify)["mode"], "notify");
        assert_eq!(mode_json(PermissionMode::Full)["mode"], "full");
    }
}
