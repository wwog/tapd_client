/**
 * The composer's `@` panel: which text is a mention token, what a row looks
 * like, and how a pick rewrites the draft.
 *
 * A token is dsh's own file-reference grammar (`@path`, `@"path with spaces"`),
 * so what the panel inserts is exactly what the model's prompt section already
 * understands. Kinds are open: files today, `plugin` / `conversation` rows when
 * a provider supplies them (ZCode's panel lists all three).
 */
import type { DshMentionItem } from "../lib/dsh";

export type MentionKind = DshMentionItem["kind"];

export type MentionRow = DshMentionItem;

/** The `@token` the caret currently sits in, or undefined. */
export type ActiveMention = {
  /** Index of the `@` itself. */
  start: number;
  /** Index just past the token's last character. */
  end: number;
  /** The text after `@` (quotes stripped for a quoted token). */
  query: string;
};

/**
 * Finds the mention token under the caret.
 *
 * Typing `@` at a token boundary opens the panel; anything before it (a word
 * character, `@`, or nothing matched) keeps it closed, so emails and `@@` never
 * trigger a search. A quoted token stays open until its closing quote.
 */
export function activeMention(text: string, caret: number): ActiveMention | undefined {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = upto.lastIndexOf("@");
  if (at < 0) return undefined;
  const before = at === 0 ? "" : upto[at - 1];
  if (before !== "" && !/[\s([{"'，。]/u.test(before)) return undefined;
  const body = upto.slice(at + 1);
  if (body.startsWith('"')) {
    const query = body.slice(1);
    if (query.includes('"') || query.includes("\n")) return undefined;
    return { start: at, end: caret, query };
  }
  if (/[\s@]/u.test(body)) return undefined;
  return { start: at, end: caret, query: body };
}

/** `@path` with quoting for spaces, the shape dsh's grammar accepts. */
export function mentionText(path: string): string {
  return /[\s"]/u.test(path) ? `@"${path}"` : `@${path}`;
}

/** Replaces the active token with the picked path and one trailing space. */
export function applyMention(
  text: string,
  mention: ActiveMention,
  path: string,
): { text: string; caret: number } {
  const inserted = `${mentionText(path)} `;
  const next = `${text.slice(0, mention.start)}${inserted}${text.slice(mention.end)}`;
  return { text: next, caret: mention.start + inserted.length };
}

/** Last path segment, for the row's main label. */
export function mentionName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The directory with a trailing slash, as the row's dim secondary text. */
export function mentionDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

/** Which glyph color a file row gets; `plugin` / `conversation` keep their own. */
export function mentionTone(path: string): "code" | "data" | "doc" | "image" | "other" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "rs", "go", "py", "rb", "java", "kt", "c", "h", "cpp", "swift"].includes(ext)) {
    return "code";
  }
  if (["json", "yml", "yaml", "toml", "lock", "sql"].includes(ext)) return "data";
  if (["md", "mdx", "txt", "rst"].includes(ext)) return "doc";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "ico"].includes(ext)) return "image";
  return "other";
}
