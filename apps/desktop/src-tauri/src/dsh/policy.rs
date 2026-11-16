//! Permission modes and the policy plugin's notice channel (P3).
//!
//! Contract: docs/DSH.md §9.3. The rule table itself lives in the Cordis plugin
//! `dsh/plugins/tapd-policy`, which reads the mode from the environment; this
//! module owns the persisted mode and the `notice` frames that plugin sends
//! when the mode is `notify`.
//!
//! `command` is the feature surface both windows and the paired phone use.

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::agent_settings::{self, PermissionMode};
use tapd_i18n::tr_args;

/// Dispatches `dsh_policy_get` / `dsh_policy_set`.
pub async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    match name {
        "dsh_policy_get" => Ok(mode_json(agent_settings::config_for(app).permission_mode)),
        "dsh_policy_set" => set(app, &payload),
        other => Err(format!("unknown dsh policy command: {other}")),
    }
}

/// The mode travels as its kebab-case serde name (`auto` / `notify` / `full`).
fn mode_json(mode: PermissionMode) -> Value {
    json!({ "mode": mode })
}

/// Validates and writes the mode.
///
/// A running runtime keeps the gate it booted with, so the caller is expected to
/// say that a restart is needed; silently restarting would interrupt turns.
fn set(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let raw = payload
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let mode = match raw {
        "auto" => PermissionMode::Auto,
        "notify" => PermissionMode::Notify,
        "full" => PermissionMode::Full,
        other => return Err(tr_args("dsh.policy.unknown", &[&other])),
    };
    let mut config = agent_settings::config_for(app);
    config.permission_mode = mode;
    let saved = agent_settings::save_for(app, &config)?;
    Ok(mode_json(saved.permission_mode))
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
