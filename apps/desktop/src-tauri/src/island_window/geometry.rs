//! Island geometry: the sizes the capsule cycles through and the pure
//! placement maths. No Tauri types here, so it is unit-testable on its own.

pub(super) const PILL_WIDTH: f64 = 210.0;
pub(super) const PILL_HEIGHT: f64 = 34.0;
const CARD_WIDTH: f64 = 384.0;
/// Room for a two-line title, the metadata row and the action row at the
/// default 14px UI scale. Only the first frame uses it: the cards then report
/// their measured height, because the real height follows the font setting.
const CARD_BASE_HEIGHT: f64 = 168.0;
const CARD_ROW_HEIGHT: f64 = 148.0;
/// Agent question options are listed one per row (label over its description),
/// with the answer field as the last row. One row replaces the shared action
/// row counted in `CARD_BASE_HEIGHT`.
const CARD_STACKED_ROW_HEIGHT: f64 = 48.0;
const CARD_ACTION_ROW_HEIGHT: f64 = 30.0;
/// Floor for a UI-measured card, so a measurement taken mid-layout cannot
/// collapse the window to a sliver.
const CARD_MIN_HEIGHT: f64 = 120.0;
pub(super) const ISLAND_TOP_MARGIN: f64 = 6.0;
/// Hover peek: the collapsed capsule widens a little and grows a summary card
/// underneath, without moving the pill (it stays centred on the anchor).
pub(super) const PEEK_WIDTH: f64 = 300.0;
const PEEK_GAP: f64 = 6.0;
/// Project row + a two-line title + the severity/priority row with 打开详情.
const PEEK_CARD_HEIGHT: f64 = 112.0;
pub(super) const PEEK_HEIGHT: f64 = PILL_HEIGHT + PEEK_GAP + PEEK_CARD_HEIGHT;
/// The update panel is the collapsed capsule at 3x.
pub(super) const UPDATE_WIDTH: f64 = PILL_WIDTH * 3.0;
pub(super) const UPDATE_HEIGHT: f64 = PILL_HEIGHT * 3.0;

/// `stacked_rows` is the tallest stacked block (options + answer field) across
/// the cards; zero keeps the plain card size. `measured` is the height the UI
/// measured for the very same card set (CSS px): the estimates above are only a
/// starting frame, because the card's real height follows the user's font size.
pub(super) fn island_size(
    expanded: bool,
    count: usize,
    stacked_rows: usize,
    measured: Option<f64>,
) -> (f64, f64) {
    if !expanded {
        return (PILL_WIDTH, PILL_HEIGHT);
    }
    if let Some(height) = measured {
        return (CARD_WIDTH, height.max(CARD_MIN_HEIGHT));
    }
    let rows = count.clamp(1, 5) as f64;
    let options = stacked_rows.min(5) as f64;
    let stacked_extra = (options * CARD_STACKED_ROW_HEIGHT - CARD_ACTION_ROW_HEIGHT).max(0.0);
    (
        CARD_WIDTH,
        CARD_BASE_HEIGHT + (rows - 1.0) * CARD_ROW_HEIGHT + stacked_extra,
    )
}

/// Where an island window of `size` goes for a capsule anchored at `anchor`
/// (centre x, top y). The capsule itself is a `pill_height` strip at the top of
/// the window when collapsed; cards replace it, so the window only has to stay
/// inside the work area.
///
/// - Horizontal: centred on the capsule, then pulled inside the work area when
///   the centre would push an edge off the screen.
/// - Vertical: a card opens away from the nearest screen edge — the pill sits at
///   the top of its monitor, so there is room below it (and the other way round
///   for a pill dragged down). It flips to the other side when that side cannot
///   fit the card, and finally clamps into the area so nothing is unreachable.
pub(super) fn place_island(
    anchor: Option<(i32, i32)>,
    area_left: i32,
    area_top: i32,
    area_width: i32,
    area_height: i32,
    size: (i32, i32),
    pill_height: i32,
    margin: i32,
) -> (i32, i32) {
    let (width, height) = size;
    let right = area_left + area_width;
    let bottom = area_top + area_height;
    let x_min = area_left + margin;
    let x_max = (right - margin - width).max(x_min);

    let (center_x, top) = match anchor {
        Some(anchor) => anchor,
        None => (area_left + area_width / 2, area_top + margin),
    };
    let x = (center_x - width / 2).clamp(x_min, x_max);

    let y_min = area_top + margin;
    let y_max = (bottom - margin - height).max(y_min);
    let pill_bottom = top + pill_height;
    let below = bottom - margin - pill_bottom;
    let above = top - margin - area_top;

    let y = if height <= below {
        // Opens under the capsule; the usual case.
        top
    } else if height <= above {
        // Not enough room below but enough above: grow upward, bottom edge on
        // the capsule's bottom so the card grows out of it.
        pill_bottom - height
    } else if below >= above {
        top
    } else {
        pill_bottom - height
    };

    (x, y.clamp(y_min, y_max))
}

pub(super) fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Work area with the menu bar cut off, like a real monitor.
    const AREA: (i32, i32, i32, i32) = (0, 30, 1920, 1050);
    const MARGIN: i32 = 6;
    const PILL: i32 = PILL_HEIGHT as i32;
    const CARD: (i32, i32) = (CARD_WIDTH as i32, CARD_BASE_HEIGHT as i32);

    fn place(anchor: Option<(i32, i32)>, size: (i32, i32)) -> (i32, i32) {
        place_island(anchor, AREA.0, AREA.1, AREA.2, AREA.3, size, PILL, MARGIN)
    }

    #[test]
    fn island_position_defaults_to_top_centre() {
        let (x, y) = place(None, (210, PILL));
        assert_eq!(x, (1920 - 210) / 2);
        assert_eq!(y, 36);
    }

    #[test]
    fn island_position_prefers_saved_anchor() {
        // Dragged to the right edge at y=120 while collapsed.
        assert_eq!(place(Some((1500, 120)), (210, PILL)), (1395, 120));
    }

    #[test]
    fn stacked_rows_grow_a_single_card() {
        assert_eq!(island_size(false, 3, 3, None).0, PILL_WIDTH);
        let plain = island_size(true, 1, 0, None);
        let one = island_size(true, 1, 1, None);
        let two = island_size(true, 1, 2, None);
        let three = island_size(true, 1, 3, None);
        assert!(one.1 > plain.1);
        assert!(two.1 > one.1);
        assert!(three.1 > two.1);
        // Extra cards still stack on top of the option height.
        assert_eq!(island_size(true, 2, 3, None).1, three.1 + CARD_ROW_HEIGHT);
    }

    #[test]
    fn a_measured_height_replaces_the_estimate() {
        // The UI measured the cards; whatever the estimates said, use it.
        assert_eq!(island_size(true, 2, 0, Some(212.0)), (CARD_WIDTH, 212.0));
        // Never collapse below the floor, and never in the collapsed layout.
        assert_eq!(island_size(true, 1, 0, Some(10.0)).1, CARD_MIN_HEIGHT);
        assert_eq!(island_size(false, 1, 0, Some(212.0)).1, PILL_HEIGHT);
    }

    #[test]
    fn expanding_keeps_the_anchor_centre() {
        let collapsed = place(Some((1500, 120)), (210, PILL));
        let expanded = place(Some((1500, 120)), CARD);
        // 384 wide centred on the same capsule: 105 either side of its centre.
        assert_eq!(expanded.0 + 192, collapsed.0 + 105);
        assert_eq!(collapsed.1, expanded.1);
    }

    #[test]
    fn a_card_near_the_right_edge_stays_on_screen() {
        // Pill dragged to the very right: the card must slide back inside.
        let (x, _) = place(Some((1900, 100)), CARD);
        assert_eq!(x, 1920 - MARGIN - CARD.0);
    }

    #[test]
    fn a_card_near_the_bottom_opens_upwards() {
        // Pill at the bottom of the work area: no room below, plenty above.
        let top = AREA.1 + AREA.3 - PILL - 20;
        let (_, y) = place(Some((900, top)), CARD);
        assert_eq!(y, top + PILL - CARD.1);
        assert!(y >= AREA.1 + MARGIN);
    }

    #[test]
    fn a_card_that_fits_neither_way_stays_inside() {
        // Taller than the work area: the bottom edge is kept inside, so the top
        // row (the header with the close button) never ends up off screen.
        let tall = (CARD.0, AREA.3 - 20);
        let bottom = AREA.1 + AREA.3 - MARGIN - tall.1;
        let (_, y) = place(Some((900, AREA.1 + 200)), tall);
        assert_eq!(y, bottom);
        let (_, y) = place(Some((900, AREA.1 + 800)), tall);
        assert_eq!(y, AREA.1 + MARGIN);
    }

    #[test]
    fn hover_peek_grows_downwards_around_the_pill() {
        let collapsed = place(Some((1500, 120)), (PILL_WIDTH as i32, PILL));
        let peek = place(Some((1500, 120)), (PEEK_WIDTH as i32, PEEK_HEIGHT as i32));
        // The pill keeps its centre and top edge; only the card below grows.
        assert_eq!(
            collapsed.0 + PILL_WIDTH as i32 / 2,
            peek.0 + PEEK_WIDTH as i32 / 2
        );
        assert_eq!(collapsed.1, peek.1);
        assert_eq!(PEEK_HEIGHT, PILL_HEIGHT + PEEK_GAP + PEEK_CARD_HEIGHT);
    }
}
