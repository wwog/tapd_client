//! Audit writes for MCP tool calls.
//!
//! `handle` records each call exactly once, at the decision point, so the audit
//! order always matches the order in which calls were decided. Persistence
//! failures are logged and never fail the tool call.

use std::time::Instant;

use serde_json::Value;
use tapd_core::config::McpPolicy;

use crate::{mcp_audit::McpAuditEntry, state::SharedState};

use super::args::{string_arg, summarize_arguments};

/// One in-flight call: everything an audit entry needs, captured up front so
/// the duration covers the whole policy + dispatch path.
pub(super) struct AuditCall<'a> {
    tool: &'a str,
    client: &'a str,
    started: Instant,
    arguments: &'a Value,
    summary: Value,
}

impl<'a> AuditCall<'a> {
    pub(super) fn new(tool: &'a str, client: &'a str, arguments: &'a Value) -> Self {
        Self {
            tool,
            client,
            started: Instant::now(),
            arguments,
            summary: summarize_arguments(arguments),
        }
    }

    /// Milliseconds since the call started, for the tracing log line.
    pub(super) fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Appends one entry when auditing is enabled. `decision` is one of
    /// `allowed` / `denied` / `error`.
    pub(super) fn record(
        &self,
        state: &SharedState,
        policy: &McpPolicy,
        decision: &str,
        ok: bool,
        error: Option<String>,
    ) {
        if !policy.audit_enabled {
            return;
        }

        let entry = McpAuditEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            ts: chrono::Local::now().to_rfc3339(),
            tool: self.tool.to_string(),
            client: self.client.to_string(),
            decision: decision.to_string(),
            ok,
            duration_ms: self.started.elapsed().as_millis() as u64,
            workspace_id: string_arg(self.arguments, "workspace_id"),
            bug_id: string_arg(self.arguments, "bug_id"),
            error,
            summary: self.summary.clone(),
        };

        if let Err(error) = state.mcp_audit.record(entry) {
            tracing::warn!(%error, "failed to persist MCP audit entry");
        }
    }
}
