mod acp;
mod agent;
mod bug_write;
mod cache;
mod commands;
mod diagnostics;
mod export;
mod feature_router;
mod island_window;
mod mcp;
mod mcp_audit;
mod mcp_import;
mod media;
mod notification;
mod notification_db;
mod open_with;
mod opencode;
mod reset;
mod server;
mod session;
mod shell_path;
mod state;
mod update;
mod window_state;

use std::sync::Arc;

use tapd_core::{
    config::ConfigStore,
    paths::AppPaths,
    runtime::RuntimeInfo,
};
use tauri::{Manager, RunEvent};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::state::AppState;

pub fn run() {
    let paths = match AppPaths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("failed to resolve application paths: {error}");
            std::process::exit(1);
        }
    };

    // A reset requested from settings must happen before logging or SQLite
    // opens anything in the data directory.
    let reset_applied = match reset::apply_pending(&paths) {
        Ok(applied) => applied,
        Err(error) => {
            eprintln!("failed to clear local data: {error}");
            false
        }
    };

    init_tracing(&paths);
    if reset_applied {
        tracing::info!("local data directory cleared on startup");
    }

    let config_store = ConfigStore::new(paths.config_file.clone());
    let config = config_store.load();
    let state = Arc::new(AppState::new(paths, config_store, config));
    let setup_state = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::session_show,
            commands::session_login_state,
            commands::session_reload_login,
            commands::session_cache_avatar,
            commands::session_logout,
            commands::workspace_context,
            commands::bug_list,
            commands::bug_detail,
            commands::workspace_members,
            commands::bug_add_comment,
            commands::bug_update_field,
            commands::bug_transitions,
            commands::bug_transition,
            export::export_bug_md,
            commands::set_current_user,
            commands::ensure_window_width,
            commands::mcp_config,
            commands::complete_onboarding,
            commands::reset_onboarding,
            commands::mcp_policy_get,
            commands::mcp_policy_set,
            commands::mcp_audit_list,
            commands::mcp_audit_clear,
            commands::mcp_audit_export,
            diagnostics::export_diagnostics,
            feature_router::feature_command,
            commands::set_last_workspace,
            commands::set_hidden_workspaces,
            commands::capture_snapshot,
            commands::capture_clear,
            commands::capture_export,
            commands::clear_app_data,
            commands::open_path,
            commands::open_directory,
            commands::open_media,
            commands::media_endpoint,
            commands::list_dirs,
            commands::open_targets,
            commands::set_open_target,
            update::update_state,
            update::update_check,
            update::update_install,
            update::update_cancel,
            update::update_open_manual,
            window_state::ui_ready,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = setup_state.clone();

            let server_state = state.clone();
            let server_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = server::run(server_handle, server_state).await {
                    tracing::error!(%error, "local API server stopped");
                }
            });

            // The TAPD webview is a background session holder only. The login
            // screen mirrors its QR code, so it must never be shown at boot.
            if let Err(error) = session::ensure_session_window(&handle, &state, false) {
                tracing::error!(%error, "failed to create TAPD session window");
            }

            // Closing the main window only hides it: the app stays in the
            // Dock and reopens on click. Quitting from the app menu or the
            // Dock menu still exits the process normally.
            if let Some(window) = handle.get_webview_window("main") {
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            // Reopen at the size/position the user left the window in.
            window_state::install(&handle, &state);

            notification::init(&handle, state.clone());
            agent::init(&handle, state.clone());
            // Check GitHub Releases shortly after launch, then every two hours.
            update::init(&handle, state.clone());
            session::spawn_session_watcher(handle, state);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Exit => {
                // The agent TUI/serve run in their own sessions, so they must be
                // stopped explicitly or they keep working after the app is gone.
                agent::shutdown(app);
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    // Persist the final geometry before the config file goes away.
                    window_state::save_now(app, &state);
                    RuntimeInfo::clear(&state.paths.runtime_file);
                }
            }
            // macOS: clicking the Dock icon brings the hidden main window back,
            // unless an update owns the screen (then it must stay hidden).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if update::is_updating() {
                    return;
                }
                // Still booting: the first paint reveals the window itself, and
                // showing it now would flash an unpainted webview.
                if !window_state::is_revealed() {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

fn init_tracing(paths: &AppPaths) {
    let appender = tracing_appender::rolling::daily(&paths.logs_dir, "tapd-client.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
    // Keep the writer alive for the whole process lifetime.
    std::mem::forget(guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,tapd_client_lib=debug,tapd_core=debug")
    });

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init();
}
