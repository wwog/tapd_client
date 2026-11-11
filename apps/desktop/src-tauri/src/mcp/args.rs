//! Argument access and the non-sensitive audit summary.
//!
//! Everything here is pure: it only reads the JSON payload a client sent, so
//! the policy gate, the audit trail and the handlers share one definition of
//! "argument is present".

use serde_json::{Map, Value};

/// Trimmed, non-empty string argument.
pub(super) fn string_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

/// Trimmed, non-empty strings from an array argument.
pub(super) fn string_array(arguments: &Value, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Directory the caller is working in: `root` (preferred), or its aliases.
pub(super) fn root_hint(arguments: &Value) -> Option<String> {
    ["root", "repo_path", "repoPath", "cwd"]
        .iter()
        .find_map(|key| string_arg(arguments, key))
}

/// The sidecar marks a `root` it filled from its own process cwd. Such a hint
/// may fall back to the last selected project instead of failing.
pub(super) fn root_is_cwd_hint(arguments: &Value) -> bool {
    string_arg(arguments, "rootSource").as_deref() == Some("cwd")
}

/// Non-sensitive snapshot of the call shape for the audit table.
///
/// Comment and prompt bodies are reduced to lengths so the log never carries
/// user text.
pub(super) fn summarize_arguments(arguments: &Value) -> Value {
    let mut summary = Map::new();
    for key in [
        "workspace_id",
        "bug_id",
        "status",
        "next_status",
        "owner",
        "root",
        "model",
        "limit",
        "page",
        "only_unresolved",
        "tone",
        "waitSeconds",
    ] {
        if let Some(value) = arguments.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    if let Some(comment) = arguments.get("comment").and_then(Value::as_str) {
        summary.insert(
            "commentChars".to_string(),
            Value::from(comment.chars().count() as u64),
        );
    }
    if let Some(fields) = arguments.get("fields").and_then(Value::as_array) {
        summary.insert("fields".to_string(), Value::from(fields.len() as u64));
    }
    if let Some(blocks) = arguments.get("blocks").and_then(Value::as_array) {
        summary.insert("blocks".to_string(), Value::from(blocks.len() as u64));
    }
    if let Some(actions) = arguments.get("actions").and_then(Value::as_array) {
        summary.insert("actions".to_string(), Value::from(actions.len() as u64));
    }
    if let Some(files) = arguments.get("files").and_then(Value::as_array) {
        summary.insert("files".to_string(), Value::from(files.len() as u64));
    }
    if let Some(summary_text) = arguments.get("summary").and_then(Value::as_str) {
        summary.insert(
            "summaryChars".to_string(),
            Value::from(summary_text.chars().count() as u64),
        );
    }
    Value::Object(summary)
}

#[cfg(test)]
mod tests {
    use super::{root_hint, root_is_cwd_hint, summarize_arguments};
    use serde_json::json;

    #[test]
    fn audit_summary_never_contains_comment_text() {
        let summary = summarize_arguments(&json!({
            "bug_id": "1",
            "comment": "secret body",
            "status": "resolved"
        }));
        assert_eq!(summary["bug_id"], "1");
        assert_eq!(summary["status"], "resolved");
        assert_eq!(summary["commentChars"], 11);
        assert!(summary.get("comment").is_none());
    }

    #[test]
    fn root_hint_reads_aliases_and_marks_cwd_source() {
        assert_eq!(root_hint(&json!({ "root": "/a" })).as_deref(), Some("/a"));
        assert_eq!(
            root_hint(&json!({ "repo_path": "/b" })).as_deref(),
            Some("/b")
        );
        assert_eq!(root_hint(&json!({ "cwd": " " })), None);
        assert!(root_is_cwd_hint(&json!({ "rootSource": "cwd" })));
        assert!(!root_is_cwd_hint(&json!({ "root": "/a" })));
    }
}
