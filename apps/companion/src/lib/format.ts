/** Display formatting shared by list and detail. */

export const relativeTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))} 秒前`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};

/** Absolute timestamp for fields that must not drift (创建时间 etc.). */
export const absoluteTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
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
  if (secs < 60) return `${secs} 秒`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分 ${secs % 60} 秒`;
  return `${Math.floor(mins / 60)} 时 ${mins % 60} 分`;
};
