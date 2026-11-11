//! An asset that was downloaded into an export directory.

use serde::{Deserialize, Serialize};

use crate::tapd::model::MediaKind;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub url: String,
    /// Path relative to the export directory, e.g. `assets/att-1-log.ips`.
    pub relative_path: String,
    pub filename: String,
    pub kind: MediaKind,
    pub size: u64,
    pub content_type: String,
}
