//! Canonical MCP tool manifest shared by the sidecar and the desktop app.
//!
//! The sidecar renders `tools/list` from this manifest and the app dispatches
//! only names declared here, so a tool cannot appear on one side and go
//! missing on the other.
//!
//! The tool definitions are grouped by workflow in the submodules; [`tools`] is
//! the single place that fixes their `tools/list` order.

mod bug;
mod query;
mod workflow;

use std::sync::OnceLock;

/// One externally visible MCP tool.
#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    /// JSON-RPC tool name, e.g. `tapd_list_bugs`.
    pub name: &'static str,
    /// Human-readable description sent to MCP clients.
    pub description: &'static str,
    /// `inputSchema` as JSON text. Consumers parse it before serving it.
    pub schema: &'static str,
}

/// Every MCP tool the product exposes, in `tools/list` order.
///
/// External agents only read and write TAPD; ownership registration, review
/// gating and lifecycle reporting are desktop-only concerns and no longer
/// appear here.
///
/// Built on first use rather than declared as a `const`: the descriptions and
/// schema descriptions are rendered in the active locale, which needs `tr()`.
/// One manifest per locale is cached, so a language switch does not need a
/// restart.
pub fn tools() -> &'static [ToolSpec] {
    static CACHE: [OnceLock<Vec<ToolSpec>>; 2] = [OnceLock::new(), OnceLock::new()];
    CACHE[usize::from(tapd_i18n::is_en())].get_or_init(|| {
        vec![
            query::whoami(),
            query::list_projects(),
            query::list_bugs(),
            query::list_my_bugs(),
            bug::get_bug(),
            bug::get_bug_transitions(),
            bug::add_bug_comment(),
            bug::update_bug_status(),
            workflow::notify_user(),
            workflow::wait_notification(),
        ]
    })
}

/// Serializes one `inputSchema` and keeps the text for the life of the process:
/// [`ToolSpec`] hands consumers a `&'static str` and the manifest is built once.
pub(super) fn schema(value: serde_json::Value) -> &'static str {
    Box::leak(value.to_string().into_boxed_str())
}

// Argument descriptions shared by several tools: the catalogue key is the
// single source, and `tr` renders it in the active locale.
pub(super) const ARG_ROOT: &str = "mcp.arg.root";
pub(super) const ARG_WORKSPACE_ID: &str = "mcp.arg.workspaceid";
pub(super) const ARG_BUG_ID: &str = "mcp.arg.bugid";
pub(super) const ARG_STATUSES: &str = "mcp.arg.statuses";
pub(super) const ARG_PRIORITIES: &str = "mcp.arg.priorities";
pub(super) const ARG_SEVERITIES: &str = "mcp.arg.severities";
pub(super) const ARG_KEYWORD: &str = "mcp.arg.keyword";
pub(super) const ARG_ONLY_UNRESOLVED: &str = "mcp.arg.onlyunresolved";
pub(super) const ARG_MODIFIED_AFTER: &str = "mcp.arg.modifiedafter";
pub(super) const ARG_CREATED_AFTER: &str = "mcp.arg.createdafter";
pub(super) const ARG_WAIT_SECONDS: &str = "mcp.arg.waitseconds";

/// Looks up a tool by its external name.
pub fn tool(name: &str) -> Option<&'static ToolSpec> {
    tools().iter().find(|tool| tool.name == name)
}

/// Iterates over every external tool name in manifest order.
pub fn names() -> impl Iterator<Item = &'static str> {
    tools().iter().map(|tool| tool.name)
}

#[cfg(test)]
mod tests {
    use super::{names, tool, tools};

    #[test]
    fn manifest_exposes_ten_unique_tool_names() {
        assert_eq!(tools().len(), 10);

        let mut seen = std::collections::HashSet::new();
        for name in names() {
            assert!(!name.is_empty());
            assert!(seen.insert(name), "duplicate tool name: {name}");
        }
        assert_eq!(seen.len(), tools().len());
    }

    #[test]
    fn every_schema_is_a_valid_object_schema() {
        for spec in tools() {
            let schema: serde_json::Value = serde_json::from_str(spec.schema)
                .unwrap_or_else(|error| panic!("{}: invalid schema JSON: {error}", spec.name));
            let object = schema
                .as_object()
                .unwrap_or_else(|| panic!("{}: schema is not a JSON object", spec.name));
            assert_eq!(
                object.get("type").and_then(serde_json::Value::as_str),
                Some("object"),
                "{}: inputSchema type must be object",
                spec.name
            );
        }
    }

    #[test]
    fn lookup_finds_every_declared_name() {
        for spec in tools() {
            let found = tool(spec.name).unwrap_or_else(|| panic!("missing {}", spec.name));
            assert_eq!(found.name, spec.name);
        }
        assert!(tool("tapd_does_not_exist").is_none());
    }
}
