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

/** The first owner, for compact labels and the claim hint. */
export const primaryOwner = (owner: string | null | undefined): string =>
  ownerNames(owner)[0] ?? "";

/** TAPD titles come from testers and usually carry full-width punctuation. */
const TITLE_PUNCTUATION: Record<string, string> = {
  "【": "[",
  "】": "]",
  "「": '"',
  "」": '"',
  "『": "'",
  "』": "'",
  "（": "(",
  "）": ")",
  "《": "<",
  "》": ">",
  "，": ",",
  "。": ".",
  "：": ":",
  "；": ";",
  "、": ",",
  "？": "?",
  "！": "!",
  "—": "-",
  "～": "~",
  "％": "%",
  "　": " ",
};

/**
 * Render a bug title with ASCII punctuation so it matches the rest of the UI.
 *
 * Bracketed ranges are kept apart from the surrounding text (`[x]y` → `[x] y`,
 * `a[x]` → `a [x]`), while a bracket at the very start of the title stays flush.
 * Only the title is rewritten; descriptions, comments and exported bug.json
 * keep the original text.
 */
export const bugTitle = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/…+/g, "...")
    .replace(/[【】「」『』（）《》，。：；、？！—～％　]/g, (char) => TITLE_PUNCTUATION[char])
    .replace(/(?<=[^\s[({])(?=[[({])/gu, " ")
    .replace(/(?<=[\]})])(?=[^\s.,;:!?)\]}>])/gu, " ");
