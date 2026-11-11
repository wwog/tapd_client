//! Readers for TAPD's loosely typed JSON payloads.
//!
//! The same field arrives as a string, number or bool depending on the
//! endpoint, and absent fields are omitted rather than sent as `null`, so every
//! read has to be defensive.

use serde_json::Value;

/// Reads a scalar as text: strings verbatim, numbers and bools stringified,
/// and anything else (including a missing key) as empty.
pub(super) fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// [`text`] with an empty result collapsed to `None`.
pub(super) fn opt_text(value: &Value, key: &str) -> Option<String> {
    let text = text(value, key);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// First non-empty value among `keys`, for TAPD's "new field name with legacy
/// fallback" shapes (e.g. `modified` with `lastmodify`).
pub(super) fn first_text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| text(value, key))
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

pub(super) fn number(value: &Value, key: &str) -> Option<u32> {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_u64().map(|number| number as u32),
        Some(Value::String(text)) => text.parse::<u32>().ok(),
        _ => None,
    }
}

pub(super) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Formats the `meta` block TAPD returns for a failed call.
pub(super) fn api_error(root: &Value) -> String {
    let code = root.pointer("/meta/code").map(Value::to_string).unwrap_or_default();
    let message = root
        .pointer("/meta/message")
        .and_then(Value::as_str)
        .unwrap_or("unexpected TAPD response");
    format!("TAPD API error (code {code}): {message}")
}
