//! The legacy server-rendered change history of a bug.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeField {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub seq: u32,
    pub time: String,
    pub author: String,
    pub kind: String,
    pub fields: Vec<ChangeField>,
}

/// Result of the legacy `changes_list` page, which is server-rendered HTML.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHistory {
    pub total: u32,
    pub changes: Vec<ChangeEntry>,
    /// Why the history could not be loaded, when the request or parse failed.
    pub error: Option<String>,
}
