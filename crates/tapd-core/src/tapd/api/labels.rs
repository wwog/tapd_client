//! Display mapping for TAPD status / priority / severity keys.
//!
//! TAPD returns bare keys (`new`, `high`) and expects clients to render the
//! localized labels from their own workflow configuration. Responses that carry
//! no workflow configuration fall back to the built-in table below.

use std::collections::BTreeMap;

use tapd_i18n::tr;

/// TAPD's built-in statuses in default workflow order, paired with the labels
/// TAPD ships for them. This is the single source of truth for both
/// [`default_status_map`] and the fallback order used when a response carries
/// no workspace workflow configuration.
pub(super) fn status_labels() -> Vec<(&'static str, &'static str)> {
    vec![
        ("new", tr("core.status.new")),
        ("in_progress", tr("core.status.inprogress")),
        ("resolved", tr("core.status.resolved")),
        ("verified", tr("core.status.verified")),
        ("reopened", tr("core.status.reopened")),
        ("rejected", tr("core.status.rejected")),
        ("closed", tr("core.status.closed")),
        ("open", tr("core.status.open")),
        ("progressing", tr("core.status.progressing")),
        ("done", tr("core.status.done")),
    ]
}

pub(super) fn default_status_map() -> BTreeMap<String, String> {
    status_labels()
        .into_iter()
        .map(|(key, label)| (key.to_string(), label.to_string()))
        .collect()
}

pub fn status_label(key: &str, map: &BTreeMap<String, String>) -> String {
    map.get(key)
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

pub fn priority_label(key: &str) -> String {
    match key {
        "urgent" => tr("core.priority.urgent"),
        "high" => tr("core.priority.high"),
        "medium" => tr("core.priority.medium"),
        "low" => tr("core.priority.low"),
        "insignificant" => tr("core.priority.insignificant"),
        other => other,
    }
    .to_string()
}

pub fn severity_label(key: &str) -> String {
    match key {
        "fatal" => tr("core.severity.fatal"),
        "serious" => tr("core.severity.serious"),
        "normal" => tr("core.severity.normal"),
        "prompt" => tr("core.severity.prompt"),
        "advice" => tr("core.severity.advice"),
        other => other,
    }
    .to_string()
}
