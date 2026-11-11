//! Workspace identity, as returned by the workspace picker endpoints.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pretty_name: String,
    pub category: String,
    pub status: String,
    pub logo_color: Option<String>,
    pub last_visited_time: Option<String>,
    pub jump_url: Option<String>,
}

/// A workspace member offered by the owner / developer pickers.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMember {
    /// TAPD nickname; this is the value stored in user fields.
    pub nick: String,
    /// TAPD user id, when the API exposes it.
    pub user_id: String,
    /// Display name when it differs from the nickname.
    pub name: String,
    /// Avatar URL, when available.
    pub avatar: String,
}
