//! Canonical MCP tool manifest shared by the sidecar and the desktop app.
//!
//! The sidecar renders `tools/list` from this manifest and the app dispatches
//! only names declared here, so a tool cannot appear on one side and go
//! missing on the other.
//!
//! The tool definitions are grouped by workflow in the submodules; [`TOOLS`] is
//! the single place that fixes their `tools/list` order.

mod bug;
mod query;
mod workflow;

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
pub const TOOLS: &[ToolSpec] = &[
    query::TAPD_WHOAMI,
    query::TAPD_LIST_PROJECTS,
    query::TAPD_LIST_BUGS,
    query::TAPD_LIST_MY_BUGS,
    bug::TAPD_GET_BUG,
    bug::TAPD_GET_BUG_TRANSITIONS,
    bug::TAPD_ADD_BUG_COMMENT,
    bug::TAPD_UPDATE_BUG_STATUS,
    workflow::TAPD_NOTIFY_USER,
    workflow::TAPD_WAIT_NOTIFICATION,
];

/// Looks up a tool by its external name.
pub fn tool(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// Iterates over every external tool name in manifest order.
pub fn names() -> impl Iterator<Item = &'static str> {
    TOOLS.iter().map(|tool| tool.name)
}

#[cfg(test)]
mod tests {
    use super::{names, tool, TOOLS};

    #[test]
    fn manifest_exposes_ten_unique_tool_names() {
        assert_eq!(TOOLS.len(), 10);

        let mut seen = std::collections::HashSet::new();
        for name in names() {
            assert!(!name.is_empty());
            assert!(seen.insert(name), "duplicate tool name: {name}");
        }
        assert_eq!(seen.len(), TOOLS.len());
    }

    #[test]
    fn every_schema_is_a_valid_object_schema() {
        for spec in TOOLS {
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
        for spec in TOOLS {
            let found = tool(spec.name).unwrap_or_else(|| panic!("missing {}", spec.name));
            assert_eq!(found.name, spec.name);
        }
        assert!(tool("tapd_does_not_exist").is_none());
    }
}
