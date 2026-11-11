//! The self-drawn notification capsule window: creation, positioning, drag
//! persistence and the size animation. Kept apart from the notification domain
//! so polling/classification never has to reason about window geometry.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde_json::json;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::state::SharedState;

/// Tauri label of the self-drawn notification window (see `main.tsx`).
pub const WINDOW_LABEL: &str = "island";

const PILL_WIDTH: f64 = 210.0;
const PILL_HEIGHT: f64 = 34.0;
const CARD_WIDTH: f64 = 384.0;
/// Room for a two-line title, the metadata row and the two action buttons.
const CARD_BASE_HEIGHT: f64 = 160.0;
const CARD_ROW_HEIGHT: f64 = 148.0;
const ISLAND_TOP_MARGIN: f64 = 6.0;

/// Bumped on every layout change so a superseded animation stops early.
static LAYOUT_SEQ: AtomicU64 = AtomicU64::new(0);
/// Last position we set ourselves, so user drags can be told apart.
static LAST_SET_POSITION: Mutex<(i32, i32)> = Mutex::new((0, 0));
/// Wall-clock (ms) until which window moves belong to our own animation.
static ANIMATING_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Debounce token for persisting a user drag.
static MOVE_SEQ: AtomicU64 = AtomicU64::new(0);
/// While an update owns the capsule, ordinary notification layouts must not
/// resize it back to pill/card size.
static UPDATE_MODE: AtomicBool = AtomicBool::new(false);
/// Whether the collapsed capsule should be on screen. The frontend hides it
/// while everything is idle so there is no standing "standby" pill; cards,
/// agent work, updates and errors keep it visible through their own layouts.
static COLLAPSED_VISIBLE: AtomicBool = AtomicBool::new(true);
/// Last layout applied, so hiding only ever affects the collapsed pill.
static EXPANDED: AtomicBool = AtomicBool::new(false);
/// The update panel is the collapsed capsule at 3x.
const UPDATE_WIDTH: f64 = PILL_WIDTH * 3.0;
const UPDATE_HEIGHT: f64 = PILL_HEIGHT * 3.0;

/// Records the frontend's wish to keep the idle capsule on screen.
pub fn set_collapsed_visible(visible: bool) {
    COLLAPSED_VISIBLE.store(visible, Ordering::SeqCst);
}

/// Hides the capsule if it is currently collapsed. Expanded cards and the
/// update panel are never hidden mid-interaction.
pub fn hide_collapsed(app: &AppHandle) {
    if UPDATE_MODE.load(Ordering::SeqCst) || EXPANDED.load(Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// Enters/leaves the update-owned capsule. Call `refresh_island_layout`
/// afterwards to apply the matching size.
pub fn set_update_mode(active: bool) {
    UPDATE_MODE.store(active, Ordering::SeqCst);
}

pub fn update_mode() -> bool {
    UPDATE_MODE.load(Ordering::SeqCst)
}

/// Applies the 3x update panel.
pub fn apply_update_panel(app: &AppHandle, state: &SharedState) {
    apply_island_sized(app, state, UPDATE_WIDTH, UPDATE_HEIGHT, true, 0, true);
}

pub(crate) fn ensure_window(app: &AppHandle, state: &SharedState) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("TAPD Client")
        .inner_size(PILL_WIDTH, PILL_HEIGHT)
        .resizable(false)
        // Transparent, chrome-less window: the capsule/card is drawn by CSS.
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;

    let window_for_events = window.clone();
    let app_for_events = app.clone();
    let state_for_events = state.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window_for_events.hide();
            }
            tauri::WindowEvent::Moved(position) => {
                // Ignore the moves produced by our own layout animation.
                let now = now_millis();
                if now < ANIMATING_UNTIL.load(Ordering::SeqCst) {
                    return;
                }
                let expected = *LAST_SET_POSITION.lock().expect("island position lock");
                if (position.x - expected.0).abs() <= 2 && (position.y - expected.1).abs() <= 2 {
                    return;
                }

                // The user is dragging: persist the final anchor once it settles.
                let sequence = MOVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
                let app = app_for_events.clone();
                let state = state_for_events.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    if MOVE_SEQ.load(Ordering::SeqCst) != sequence {
                        return;
                    }
                    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                        return;
                    };
                    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size())
                    else {
                        return;
                    };
                    let anchor = (position.x + size.width as i32 / 2, position.y);
                    if let Err(error) =
                        state.update_config(|config| config.island_anchor = Some(anchor))
                    {
                        tracing::warn!(%error, "failed to persist island position");
                    }
                });
            }
            _ => {}
        }
    });

    Ok(window)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn mark_animating() {
    ANIMATING_UNTIL.store(now_millis() + 320, Ordering::SeqCst);
}

/// Remembers a position we are about to set, so the resulting `Moved` event is
/// not mistaken for a user drag.
fn remember_position(x: i32, y: i32) {
    if let Ok(mut expected) = LAST_SET_POSITION.lock() {
        *expected = (x, y);
    }
}

fn monitor_for(app: &AppHandle) -> Option<tauri::Monitor> {
    app.get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn island_size(expanded: bool, count: usize) -> (f64, f64) {
    if !expanded {
        return (PILL_WIDTH, PILL_HEIGHT);
    }
    let rows = count.clamp(1, 5) as f64;
    (
        CARD_WIDTH,
        CARD_BASE_HEIGHT + (rows - 1.0) * CARD_ROW_HEIGHT,
    )
}

/// Rectangle (physical pixels) for a logical island size.
///
/// Uses the anchor the user dragged the capsule to, otherwise top-centre.
fn island_rect(
    app: &AppHandle,
    state: &SharedState,
    width: f64,
    height: f64,
) -> Option<(i32, i32, u32, u32)> {
    let monitor = monitor_for(app)?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let w = (width * scale).round().max(1.0) as u32;
    let h = (height * scale).round().max(1.0) as u32;

    let anchor = state
        .config_snapshot()
        .island_anchor
        .filter(|anchor| anchor_is_on_screen(app, *anchor));

    let left = area.position.x;
    let top = area.position.y;
    let (x, y) = place_island(
        anchor,
        left,
        top,
        area.size.width as i32,
        w as i32,
        (ISLAND_TOP_MARGIN * scale).round() as i32,
    );

    Some((x, y, w, h))
}

/// Position for an island of `width` pixels: centred on the saved anchor, or
/// top-centre of the work area when the user never dragged it.
fn place_island(
    anchor: Option<(i32, i32)>,
    area_left: i32,
    area_top: i32,
    area_width: i32,
    width: i32,
    margin: i32,
) -> (i32, i32) {
    match anchor {
        Some((center_x, top)) => (center_x - width / 2, top),
        None => (
            area_left + (area_width - width).max(0) / 2,
            area_top + margin,
        ),
    }
}

/// Guards against a saved position from a monitor that is no longer attached.
fn anchor_is_on_screen(app: &AppHandle, anchor: (i32, i32)) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }

    monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let left = area.position.x;
        let top = area.position.y;
        let right = left + area.size.width as i32;
        let bottom = top + area.size.height as i32;
        anchor.0 >= left && anchor.0 <= right && anchor.1 >= top - 40 && anchor.1 <= bottom
    })
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

/// Places the island at the top centre of the screen. `animated` interpolates
/// the resize so the card grows out of the capsule (Dynamic Island style).
pub(crate) fn apply_island(
    app: &AppHandle,
    state: &SharedState,
    expanded: bool,
    count: usize,
    animated: bool,
) {
    // An update owns the capsule: polling, notification expansion and user
    // clicks must not shrink it back.
    if UPDATE_MODE.load(Ordering::SeqCst) {
        return;
    }
    let (width, height) = island_size(expanded, count);
    apply_island_sized(app, state, width, height, expanded, count, animated);
}

fn apply_island_sized(
    app: &AppHandle,
    state: &SharedState,
    width: f64,
    height: f64,
    expanded: bool,
    count: usize,
    animated: bool,
) {
    let Some((x, y, w, h)) = island_rect(app, state, width, height) else {
        return;
    };
    let Ok(window) = ensure_window(app, state) else {
        return;
    };

    EXPANDED.store(expanded, Ordering::SeqCst);

    // The idle capsule is not a permanent indicator: stay hidden until
    // something needs attention. Expanded cards and the update panel always
    // win over this flag.
    if !expanded && !UPDATE_MODE.load(Ordering::SeqCst) && !COLLAPSED_VISIBLE.load(Ordering::SeqCst)
    {
        let _ = window.hide();
    } else {
        let _ = window.set_always_on_top(true);
        let _ = window.show();
    }

    if !animated {
        remember_position(x, y);
        let _ = window.set_size(PhysicalSize::new(w, h));
        let _ = window.set_position(PhysicalPosition::new(x, y));
    } else {
        mark_animating();
        let sequence = LAYOUT_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        let window_for_animation = window.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(start_size) = window_for_animation.outer_size() else {
                return;
            };
            let Ok(start_pos) = window_for_animation.outer_position() else {
                return;
            };

            const STEPS: u32 = 11;
            for step in 1..=STEPS {
                if LAYOUT_SEQ.load(Ordering::SeqCst) != sequence {
                    // A newer layout superseded this animation.
                    return;
                }
                let t = step as f64 / STEPS as f64;
                let eased = 1.0 - (1.0 - t).powi(3);
                let next_w = lerp(start_size.width as f64, w as f64, eased).round() as u32;
                let next_h = lerp(start_size.height as f64, h as f64, eased).round() as u32;
                let next_x = lerp(start_pos.x as f64, x as f64, eased).round() as i32;
                let next_y = lerp(start_pos.y as f64, y as f64, eased).round() as i32;
                remember_position(next_x, next_y);
                mark_animating();
                let _ = window_for_animation.set_size(PhysicalSize::new(next_w, next_h));
                let _ = window_for_animation.set_position(PhysicalPosition::new(next_x, next_y));
                tokio::time::sleep(Duration::from_millis(14)).await;
            }
        });
    }

    let _ = app.emit(
        "island://layout",
        json!({
            "expanded": expanded,
            "width": width,
            "height": height,
            "count": count,
            "mode": if UPDATE_MODE.load(Ordering::SeqCst) { "update" } else { "notifications" },
        }),
    );
}


#[cfg(test)]
mod island_tests {
    use super::*;

    const AREA: (i32, i32, i32) = (0, 30, 1920);
    const MARGIN: i32 = 6;

    #[test]
    fn island_position_defaults_to_top_centre() {
        let (x, y) = place_island(None, AREA.0, AREA.1, AREA.2, 210, MARGIN);
        assert_eq!(x, (1920 - 210) / 2);
        assert_eq!(y, 36);
    }

    #[test]
    fn island_position_prefers_saved_anchor() {
        // Dragged to the right edge at y=120 while collapsed.
        let (x, y) = place_island(Some((1500, 120)), AREA.0, AREA.1, AREA.2, 210, MARGIN);
        assert_eq!((x, y), (1395, 120));
    }

    #[test]
    fn expanding_keeps_the_anchor_centre() {
        let collapsed = place_island(Some((1500, 120)), AREA.0, AREA.1, AREA.2, 210, MARGIN);
        let expanded = place_island(Some((1500, 120)), AREA.0, AREA.1, AREA.2, 384, MARGIN);
        assert_eq!(collapsed.0 + 105, expanded.0 + 192);
        assert_eq!(collapsed.1, expanded.1);
    }
}

