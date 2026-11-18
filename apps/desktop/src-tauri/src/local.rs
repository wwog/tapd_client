//! Local-only projects and their work items.
//!
//! A local project is a folder on this machine with no TAPD workspace behind
//! it; its items are never written back to TAPD. The data lives in its own
//! SQLite file ([`tapd_core::paths::AppPaths::local_db_file`]) so TAPD logout
//! and "清理缓存" cannot delete it.
//!
//! Layout:
//! - [`store`]: schema, validation and all persistence.
//! - [`command`]: the `local_*` feature commands (desktop + paired phone).

use serde_json::json;
use tauri::{AppHandle, Emitter};

pub(crate) mod command;
mod store;

pub use store::LocalStore;

/// Emitted whenever a task changes a local item's status or task link. The
/// desktop item page keeps its tab counts live from this instead of polling.
pub(crate) const EVENT_ITEMS: &str = "local://items";

/// `projectId` scopes the refresh; `itemId`/`status` let a page that is showing
/// the item follow it into its new tab. Anything absent means "refresh all".
pub(crate) fn emit_items_changed(
    app: &AppHandle,
    project_id: Option<&str>,
    item_id: Option<&str>,
    status: Option<&str>,
) {
    let _ = app.emit(
        EVENT_ITEMS,
        json!({
            "projectId": project_id,
            "itemId": item_id,
            "status": status,
        }),
    );
}
