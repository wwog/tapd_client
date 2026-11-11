//! Window choreography while an update owns the screen.
//!
//! The state machine only decides *which* phase is active; this module keeps
//! the main window hidden and morphs the island into the update panel (and
//! back) so the two concerns stay separate.

use tauri::{AppHandle, Manager};

use crate::state::SharedState;

/// Main window out of the way, capsule expanded to the update panel.
pub(super) fn hide_main_and_show_island(app: &AppHandle, state: &SharedState) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    crate::island_window::set_update_mode(true);
    crate::notification::refresh_island_layout(app, state);
}

/// Capsule back to its notification layout, main window restored and focused.
pub(super) fn restore_main_and_island(app: &AppHandle, state: &SharedState) {
    crate::island_window::set_update_mode(false);
    crate::notification::refresh_island_layout(app, state);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}
