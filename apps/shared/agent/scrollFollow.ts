/**
 * The transcript's "am I still following the tail?" rule, kept pure so the
 * thresholds are readable and testable without a DOM. Both hosts share it.
 *
 * `released` carries an explicit leave: any upward input (wheel-up, arrow keys,
 * a finger drag) detaches the tail before the scroll lands, and from then on
 * only coming back down to the end re-attaches it. Without that flag a
 * jitter-sized rise fell inside the "at the end" band and the next streamed
 * token pinned the reader back to the bottom.
 *
 * A browser clamp after the content shrank is not a reader move, so a fold
 * closing under the tail keeps following.
 */

export type ScrollStep = { top: number; height: number };

/** Whether the reader is still at the tail after one scroll event. */
export function sticksAfterScroll(
  previous: ScrollStep,
  current: ScrollStep,
  viewport: number,
  stickDistance: number,
  released = false,
): boolean {
  const distance = current.height - current.top - viewport;
  const rise = previous.top - current.top;
  const shrink = previous.height - current.height;
  // A released reader stays released on any upward motion; a clamp (offset
  // falling with the height) is not motion at all.
  if (released && rise > shrink) return false;
  // One pixel of jitter is not intent; more rise than the content lost is.
  const deliberate = rise > 1 && rise > shrink + 1;
  return !deliberate && distance < stickDistance;
}
