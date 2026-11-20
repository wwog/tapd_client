/**
 * Roving selection for the composer's two keyboard lists (`/` and ↑).
 *
 * Both lists clamp instead of wrapping: the end of the list is where the user
 * expects the selection to stop, and a wrap would send a held key back to the
 * top by accident.
 */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}
