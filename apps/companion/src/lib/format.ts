/** Display formatting shared by list and detail. */

import { localeTag, t } from "./i18n";

export const relativeTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const delta = Date.now() - timestamp;
  if (delta < 60_000)
    return t("mobile.time.secondsAgo", { n: Math.max(1, Math.round(delta / 1000)) });
  if (delta < 3_600_000) return t("mobile.time.minutesAgo", { n: Math.round(delta / 60_000) });
  if (delta < 86_400_000) return t("mobile.time.hoursAgo", { n: Math.round(delta / 3_600_000) });
  return new Date(timestamp).toLocaleString(localeTag(), { hour12: false });
};

/** Absolute timestamp for fields that must not drift (创建时间 etc.). */
export const absoluteTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return new Date(timestamp).toLocaleString(localeTag(), { hour12: false });
};

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
 * Bracketed ranges are kept apart from the surrounding text (`[x]y` → `[x] y`,
 * `a[x]` → `a [x]`), while a bracket at the very start stays flush.
 */
export const bugTitle = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/…+/g, "...")
    .replace(/[【】「」『』（）《》，。：；、？！—～％　]/g, (char) => TITLE_PUNCTUATION[char])
    .replace(/(?<=[^\s[({])(?=[[({])/gu, " ")
    .replace(/(?<=[\]})])(?=[^\s.,;:!?)\]}>])/gu, " ");

/** The bug id as the UI shows it: short id, or the long id's trailing digits. */
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

/** Task wall-clock duration from start (fallback: creation) to finish. */
export const taskDuration = (task: {
  startedAt?: string;
  createdAt: string;
  finishedAt?: string;
}): string => {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const secs = Math.max(1, Math.round((end - start) / 1000));
  if (secs < 60) return t("mobile.time.seconds", { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("mobile.time.minutesSeconds", { m: mins, s: secs % 60 });
  return t("mobile.time.hoursMinutes", { h: Math.floor(mins / 60), m: mins % 60 });
};
