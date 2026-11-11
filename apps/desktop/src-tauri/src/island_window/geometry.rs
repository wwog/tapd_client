//! Island geometry: the sizes the capsule cycles through and the pure
//! placement maths. No Tauri types here, so it is unit-testable on its own.

pub(super) const PILL_WIDTH: f64 = 210.0;
pub(super) const PILL_HEIGHT: f64 = 34.0;
const CARD_WIDTH: f64 = 384.0;
/// Room for a two-line title, the metadata row and the two action buttons.
const CARD_BASE_HEIGHT: f64 = 160.0;
const CARD_ROW_HEIGHT: f64 = 148.0;
pub(super) const ISLAND_TOP_MARGIN: f64 = 6.0;
/// Hover peek: the collapsed capsule widens a little and grows a summary card
/// underneath, without moving the pill (it stays centred on the anchor).
pub(super) const PEEK_WIDTH: f64 = 300.0;
const PEEK_GAP: f64 = 6.0;
/// Project row + a two-line title, sized for the largest UI font.
const PEEK_CARD_HEIGHT: f64 = 88.0;
pub(super) const PEEK_HEIGHT: f64 = PILL_HEIGHT + PEEK_GAP + PEEK_CARD_HEIGHT;
/// The update panel is the collapsed capsule at 3x.
pub(super) const UPDATE_WIDTH: f64 = PILL_WIDTH * 3.0;
pub(super) const UPDATE_HEIGHT: f64 = PILL_HEIGHT * 3.0;

pub(super) fn island_size(expanded: bool, count: usize) -> (f64, f64) {
    if !expanded {
        return (PILL_WIDTH, PILL_HEIGHT);
    }
    let rows = count.clamp(1, 5) as f64;
    (
        CARD_WIDTH,
        CARD_BASE_HEIGHT + (rows - 1.0) * CARD_ROW_HEIGHT,
    )
}

/// Position for an island of `width` pixels: centred on the saved anchor, or
/// top-centre of the work area when the user never dragged it.
pub(super) fn place_island(
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

pub(super) fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn hover_peek_grows_downwards_around_the_pill() {
        let collapsed = place_island(
            Some((1500, 120)),
            AREA.0,
            AREA.1,
            AREA.2,
            PILL_WIDTH as i32,
            MARGIN,
        );
        let peek = place_island(
            Some((1500, 120)),
            AREA.0,
            AREA.1,
            AREA.2,
            PEEK_WIDTH as i32,
            MARGIN,
        );
        // The pill keeps its centre and top edge; only the card below grows.
        assert_eq!(
            collapsed.0 + PILL_WIDTH as i32 / 2,
            peek.0 + PEEK_WIDTH as i32 / 2
        );
        assert_eq!(collapsed.1, peek.1);
        assert_eq!(PEEK_HEIGHT, PILL_HEIGHT + PEEK_GAP + PEEK_CARD_HEIGHT);
    }
}
