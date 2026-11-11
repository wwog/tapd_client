//! Display mapping for TAPD status / priority / severity keys.
//!
//! TAPD returns bare keys (`new`, `high`) and expects clients to render the
//! localized labels from their own workflow configuration. Responses that carry
//! no workflow configuration fall back to the built-in table below.

use std::collections::BTreeMap;

/// TAPD's built-in statuses in default workflow order, paired with the labels
/// TAPD ships for them. This is the single source of truth for both
/// [`default_status_map`] and the fallback order used when a response carries
/// no workspace workflow configuration.
pub(super) const STATUS_LABELS: &[(&str, &str)] = &[
    ("new", "新"),
    ("in_progress", "接受/处理"),
    ("resolved", "已解决"),
    ("verified", "已验证"),
    ("reopened", "重新打开"),
    ("rejected", "已拒绝"),
    ("closed", "已关闭"),
    ("open", "未开始"),
    ("progressing", "进行中"),
    ("done", "已完成"),
];

pub(super) fn default_status_map() -> BTreeMap<String, String> {
    STATUS_LABELS
        .iter()
        .map(|(key, label)| ((*key).to_string(), (*label).to_string()))
        .collect()
}

pub fn status_label(key: &str, map: &BTreeMap<String, String>) -> String {
    map.get(key)
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

pub fn priority_label(key: &str) -> String {
    match key {
        "urgent" => "紧急",
        "high" => "高",
        "medium" => "中",
        "low" => "低",
        "insignificant" => "无关紧要",
        other => other,
    }
    .to_string()
}

pub fn severity_label(key: &str) -> String {
    match key {
        "fatal" => "致命",
        "serious" => "严重",
        "normal" => "一般",
        "prompt" => "提示",
        "advice" => "建议",
        other => other,
    }
    .to_string()
}
