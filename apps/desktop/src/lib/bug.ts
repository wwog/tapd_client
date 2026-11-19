/** Ownership helpers shared by the list and the detail panel. */

/**
 * The bug id as the UI shows and copies it.
 *
 * TAPD's short id (the long id's trailing digits) is what the list, the detail
 * header and the right-click menu all display. The detail endpoint omits it, so
 * fall back to the id tail — one helper keeps the label and the clipboard from
 * disagreeing (19-digit id copied under a `#1010792` label).
 */
export const bugRef = (bug: { id: string; shortId: string }): string =>
  bug.shortId || bug.id.slice(-7);

/** TAPD stores user fields as `nick;nick;` (older data may use `|` or `,`). */
export const ownerNames = (value: string | null | undefined): string[] => {
  if (!value) return [];
  return value
    .split(/[;|,，、]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
};

/**
 * Whether the signed-in user may operate on a bug.
 *
 * Unassigned bugs (and a missing identity) stay operable so the UI never locks
 * the user out when TAPD's profile call is unavailable; a bug owned by someone
 * else requires claiming first.
 */
export const isMyBug = (
  owner: string | null | undefined,
  me: string | null | undefined,
): boolean => {
  const myName = me?.trim();
  if (!myName) return true;

  const names = ownerNames(owner);
  if (names.length === 0) return false;
  return names.includes(myName);
};

