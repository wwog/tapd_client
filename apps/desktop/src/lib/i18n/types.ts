/** Locales the app ships. Chinese is the default UI language. */
export type Locale = "zh" | "en";

/** What the user picked in settings: an explicit locale or the OS language. */
export type LocaleMode = "system" | Locale;

/** Interpolation values for `{name}` placeholders. */
export type MsgVars = Record<string, string | number>;

/**
 * One localized message. Plain strings keep `{name}` placeholders; functions
 * get the variables and return the final text, which is how a count that
 * changes the noun ("1 task" / "3 tasks") is expressed.
 */
export type Entry = string | ((vars: MsgVars) => string);

/** `[Chinese, English]` for one message key. */
export type Pair = readonly [Entry, Entry];

/**
 * A group catalogue: short semantic key -> both languages, side by side so a
 * translation can never go missing in one language.
 */
export type Catalog = Record<string, Pair>;
