//! MCP tool dispatch running inside the desktop app.
//!
//! The sidecar speaks MCP over stdio and forwards tool calls to `/mcp/call`.
//! Every call passes the user-configurable policy (read/write, project scope,
//! allowed statuses) and is written to the local audit log.
//!
//! Layout:
//! - this module: one call = policy gate -> dispatch -> audit
//! - [`policy`]: write-tool classification and the allowlist gate
//! - [`session`]: TAPD identity context and project selection
//! - [`read`], [`write`]: the tool handlers, grouped by effect
//! - [`args`], [`audit`]: argument access and audit-entry writes

mod args;
mod audit;
mod policy;
mod read;
mod session;
mod write;

use serde_json::Value;
use tauri::AppHandle;

use crate::state::SharedState;

use audit::AuditCall;
use policy::{is_write_tool, policy_violation};

pub async fn handle(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let policy = state.config_snapshot().mcp_policy;
    let audit = AuditCall::new(tool, client, arguments);

    if let Some(message) = policy_violation(&policy, tool, arguments) {
        audit.record(state, &policy, "denied", false, Some(message.clone()));
        tracing::info!(tool, client, ok = false, error = %message, "mcp tool denied by policy");
        return Err(message);
    }

    // The local agent must commit before it comments or changes TAPD state.
    if is_write_tool(tool) {
        if let Some(message) = crate::agent::tapd_write_block_reason(app, arguments).await {
            audit.record(state, &policy, "denied", false, Some(message.clone()));
            tracing::info!(tool, client, ok = false, error = %message, "mcp write blocked until commit");
            return Err(message);
        }
    }

    let result = dispatch(app, state, tool, arguments, client).await;
    let (decision, ok) = match &result {
        Ok(_) => ("allowed", true),
        Err(_) => ("error", false),
    };

    audit.record(state, &policy, decision, ok, result.as_ref().err().cloned());

    tracing::info!(
        tool,
        client,
        ok,
        duration_ms = audit.elapsed_ms(),
        error = result.as_ref().err().map(String::as_str).unwrap_or(""),
        "mcp tool call"
    );

    result
}

async fn dispatch(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    // The set of valid names comes from the shared manifest. Every manifest
    // entry must have a handler below; `dispatch_covers_every_manifest_tool`
    // fails the build if the two tables drift apart.
    if tapd_core::mcp::tool(tool).is_none() {
        return Err(format!("tool `{tool}` is not available"));
    }

    match tool {
        "tapd_whoami" => read::whoami(app, state, arguments).await,
        "tapd_list_projects" => read::list_projects(app, state).await,
        "tapd_list_bugs" => read::list_bugs(app, state, arguments).await,
        "tapd_list_my_bugs" => read::list_my_bugs(app, state, arguments).await,
        "tapd_get_bug" => read::get_bug(app, state, arguments).await,
        "tapd_get_bug_transitions" => write::get_bug_transitions(app, state, arguments).await,
        "tapd_add_bug_comment" => write::add_bug_comment(app, state, arguments).await,
        "tapd_update_bug_status" => write::update_bug_status(app, state, arguments).await,
        // Local-only: no TAPD session or workspace scope involved.
        "tapd_notify_user" => crate::notification::ai::mcp_notify(arguments, client).await,
        "tapd_wait_notification" => crate::notification::ai::mcp_wait(arguments).await,
        // Only reachable when a manifest entry was added without a handler;
        // the manifest test below catches that case.
        other => Err(format!("tool `{other}` is not available")),
    }
}

#[cfg(test)]
mod manifest_tests {
    use tapd_core::mcp;

    /// Mirrors the arms in [`super::dispatch`]. The test below fails when this
    /// list and `tapd_core::mcp::TOOLS` drift apart in either direction.
    const DISPATCHED_TOOLS: [&str; 10] = [
        "tapd_whoami",
        "tapd_list_projects",
        "tapd_list_bugs",
        "tapd_list_my_bugs",
        "tapd_get_bug",
        "tapd_get_bug_transitions",
        "tapd_add_bug_comment",
        "tapd_update_bug_status",
        "tapd_notify_user",
        "tapd_wait_notification",
    ];

    #[test]
    fn dispatch_covers_every_manifest_tool() {
        let manifest: Vec<&str> = mcp::names().collect();
        assert_eq!(manifest.len(), DISPATCHED_TOOLS.len());

        for name in &manifest {
            assert!(
                DISPATCHED_TOOLS.contains(name),
                "manifest tool `{name}` has no dispatch arm"
            );
        }
        for name in DISPATCHED_TOOLS {
            assert!(
                mcp::tool(name).is_some(),
                "dispatch arm `{name}` is missing from tapd_core::mcp::TOOLS"
            );
        }
    }
}
