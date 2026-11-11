//! Remembers the main window's size and position (logical size, physical
//! position) so the next launch reopens where the user left it.
//!
//! Programmatic resizes — the detail drawer widening the window through
//! `ensure_window_width` — must not overwrite the user's own choice, so they
//! call [`suppress_for`] first and the resize/move events they cause are
//! ignored.
//!
//! The window also stays hidden until the UI reports its first frame
//! ([`ui_ready`]): a Tauri window is a webview, and an unpainted webview is
//! white, so showing it at boot flashes on a dark theme.

use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tapd_core::config::WindowGeometry;
use tauri::{
    window::Color, AppHandle, LogicalSize, Manager, PhysicalPosition, Theme, WebviewWindow,
    WindowEvent,
};

use crate::state::SharedState;

/// Shortest accepted saved size (mirrors `tauri.conf.json` minimums).
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 560.0;
/// Ignore the resize/move burst that follows a programmatic geometry change.
const SUPPRESS_MS: u64 = 1_200;
/// Wait for the user to stop dragging before writing `config.json`.
const DEBOUNCE_MS: u64 = 450;
/// Show the window regardless of the UI if the webview never reports a paint
/// (broken bundle, dead dev server) — it must not stay invisible forever.
const REVEAL_FALLBACK_MS: u64 = 2_000;

static SUPPRESS_UNTIL: AtomicU64 = AtomicU64::new(0);
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);
static REVEALED: AtomicBool = AtomicBool::new(false);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Marks the next [`SUPPRESS_MS`] of window events as programmatic.
pub fn suppress_for(millis: u64) {
    SUPPRESS_UNTIL.store(now_millis() + millis.max(SUPPRESS_MS), Ordering::SeqCst);
    // Invalidate a debounced save from just before the programmatic change.
    SAVE_SEQ.fetch_add(1, Ordering::SeqCst);
}

fn suppressed() -> bool {
    now_millis() < SUPPRESS_UNTIL.load(Ordering::SeqCst)
}

/// Restores the saved geometry and subscribes to resize/move events.
///
/// The window starts hidden (`tauri.conf.json`) and stays hidden: restoring
/// the geometry in place avoids a jump at the default size, and keeping it
/// hidden avoids flashing an unpainted (white) webview before [`ui_ready`].
pub fn install(app: &AppHandle, state: &SharedState) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    restore(&window, state);

    let window_for_events = window.clone();
    let state = state.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
            schedule_save(window_for_events.clone(), state.clone());
        }
    });

    arm_fallback(app);
}

/// Called by the UI once the first themed frame is on screen.
///
/// `background` is the resolved canvas colour (RGBA). It is applied *before*
/// the window becomes visible, so a slow paint still shows the theme colour
/// instead of the window's configured default.
#[tauri::command]
pub fn ui_ready(app: AppHandle, background: Option<Vec<u8>>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(color) = background.as_deref().and_then(rgba) {
        let _ = window.set_background_color(Some(color));
    }
    show_once(&window);
}

/// Whether the main window has been revealed (the UI reported a first paint).
pub fn is_revealed() -> bool {
    REVEALED.load(Ordering::SeqCst)
}

fn show_once(window: &WebviewWindow) {
    if REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn rgba(bytes: &[u8]) -> Option<Color> {
    match bytes {
        [r, g, b, a] => Some(Color(*r, *g, *b, *a)),
        [r, g, b] => Some(Color(*r, *g, *b, 255)),
        _ => None,
    }
}

/// Native window background matching `styles.css` `--color-canvas`.
fn canvas_color(dark: bool) -> Color {
    if dark {
        Color(14, 16, 20, 255)
    } else {
        Color(244, 244, 242, 255)
    }
}

fn arm_fallback(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Best guess while the UI is unavailable: the OS theme, which is what
    // `mode: "system"` (the default) would have resolved to anyway.
    let dark = window
        .theme()
        .map(|theme| theme == Theme::Dark)
        .unwrap_or(false);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(REVEAL_FALLBACK_MS)).await;
        if is_revealed() {
            return;
        }
        let _ = window.set_background_color(Some(canvas_color(dark)));
        show_once(&window);
    });
}

fn restore(window: &WebviewWindow, state: &SharedState) {
    let Some(geometry) = state.config_snapshot().main_window else {
        return;
    };
    if !geometry.width.is_finite() || !geometry.height.is_finite() {
        return;
    }

    let width = geometry.width.clamp(MIN_WIDTH, 10_000.0);
    let height = geometry.height.clamp(MIN_HEIGHT, 10_000.0);

    // A window that no longer lands on any monitor (laptop undocked, display
    // removed) would be unreachable: keep the size, drop the position.
    let on_screen = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                let (right, bottom) = (
                    origin.x as i64 + size.width as i64,
                    origin.y as i64 + size.height as i64,
                );
                // Require the title-bar area to be visible, not just one pixel.
                let probe = (geometry.x as i64 + 80, geometry.y as i64 + 24);
                probe.0 >= origin.x as i64
                    && probe.0 <= right
                    && probe.1 >= origin.y as i64
                    && probe.1 <= bottom
            })
        })
        .unwrap_or(false);

    suppress_for(SUPPRESS_MS);
    let _ = window.set_size(LogicalSize::new(width, height));
    if on_screen {
        let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
    }
}

fn schedule_save(window: WebviewWindow, state: SharedState) {
    // Bump first: a save already waiting out its debounce must not persist a
    // geometry that a programmatic resize is about to replace.
    let sequence = SAVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    if suppressed() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
        if SAVE_SEQ.load(Ordering::SeqCst) != sequence {
            return; // A newer event superseded this snapshot.
        }
        persist(&window, &state);
    });
}

/// Writes the current geometry (used by the debounce and on quit).
pub fn save_now(app: &AppHandle, state: &SharedState) {
    if let Some(window) = app.get_webview_window("main") {
        persist(&window, state);
    }
}

fn persist(window: &WebviewWindow, state: &SharedState) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    if width < MIN_WIDTH - 1.0 || height < MIN_HEIGHT - 1.0 {
        return;
    }
    // Hidden windows report a stale/zeroed position on some platforms; the
    // saved geometry is only meaningful while the window is visible.
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };

    let next = WindowGeometry {
        width: width.round(),
        height: height.round(),
        x: position.x,
        y: position.y,
    };
    if state.config_snapshot().main_window.as_ref() == Some(&next) {
        return;
    }
    let _ = state.update_config(|config| config.main_window = Some(next));
}
