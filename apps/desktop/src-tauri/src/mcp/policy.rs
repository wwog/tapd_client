//! Read/write classification and the policy gate.

use serde_json::Value;
use tapd_core::config::McpPolicy;

/// Tools that change TAPD state. Both the policy write switch and the local
/// agent's commit-before-write rule key off this set, so it is defined once.
pub(super) fn is_write_tool(tool: &str) -> bool {
    matches!(tool, "tapd_add_bug_comment" | "tapd_update_bug_status")
}

/// Returns a user-facing reason when the policy forbids the call.
///
/// The check order is user-visible: the write switch is reported before the
/// project allowlist, so a disabled write never leaks a project mismatch.
pub(super) fn policy_violation(
    policy: &McpPolicy,
    tool: &str,
    arguments: &Value,
) -> Option<String> {
    if is_write_tool(tool) && !policy.writes_enabled {
        return Some("MCP 写操作已在「MCP 策略」中关闭".to_string());
    }

    if let Some(workspace_id) = super::args::string_arg(arguments, "workspace_id") {
        if !policy.allows_workspace(&workspace_id) {
            return Some(format!("项目 {workspace_id} 不在 MCP 策略允许的项目范围内"));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::policy_violation;
    use serde_json::json;
    use tapd_core::config::McpPolicy;

    #[test]
    fn writes_can_be_disabled() {
        let args = json!({ "bug_id": "1", "comment": "hello" });
        let mut policy = McpPolicy::default();
        assert!(policy_violation(&policy, "tapd_add_bug_comment", &args).is_none());

        policy.writes_enabled = false;
        assert!(policy_violation(&policy, "tapd_add_bug_comment", &args).is_some());
        // Read tools stay available.
        assert!(policy_violation(&policy, "tapd_get_bug", &args).is_none());
    }

    #[test]
    fn project_allowlist_is_enforced() {
        let policy = McpPolicy {
            allowed_workspace_ids: vec!["45336192".to_string()],
            ..McpPolicy::default()
        };
        assert!(policy_violation(
            &policy,
            "tapd_get_bug",
            &json!({ "workspace_id": "45336192" })
        )
        .is_none());
        assert!(
            policy_violation(&policy, "tapd_get_bug", &json!({ "workspace_id": "999" })).is_some()
        );
    }
}
