/** Titles from TAPD (and the sessions derived from them) usually carry full-width punctuation. */
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
 * Render a title with ASCII punctuation so it matches the rest of the UI.
 *
 * Bracketed ranges are kept apart from the surrounding text (`[x]y` → `[x] y`,
 * `a[x]` → `a [x]`), while a bracket at the very start of the title stays flush.
 * Only the display copy is rewritten; descriptions, comments and exported
 * bug.json keep the original text.
 */
export const plainTitle = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/…+/g, "...")
    .replace(/[【】「」『』（）《》，。：；、？！—～％　]/g, (char) => TITLE_PUNCTUATION[char])
    .replace(/(?<=[^\s[({])(?=[[({])/gu, " ")
    .replace(/(?<=[\]})])(?=[^\s.,;:!?)\]}>])/gu, " ");
