import { t } from "../lib/i18n";

/** What a tool call looks like as one timeline row. */
export type ToolAction = {
  kind: "bash" | "read" | "write" | "edit" | "search" | "web" | "image" | "other";
  /** Past-tense verb, localized: 已执行 / 已阅读 / … */
  verb: string;
  /** The one thing the row is about: description, file name, pattern, URL. */
  target: string;
  /** Line additions/deletions, for write and edit. */
  added?: number;
  removed?: number;
};

/** Line count of a text block; empty text contributes nothing. */
function lineCount(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return text.split("\n").length;
}

/**
 * Real added/removed lines between the old and new blocks, as a multiset
 * difference. A literal replacement string says nothing about how much of the
 * file actually changed; this at least never counts moved lines twice.
 */
function lineDelta(before: unknown, after: unknown): { added: number; removed: number } {
  const split = (value: unknown): string[] =>
    typeof value === "string" && value.length > 0 ? value.split("\n") : [];
  const remaining = new Map<string, number>();
  for (const line of split(before)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of split(after)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { added, removed };
}

/** Last path segment, so rows stay one line on deep repository paths. */
function baseName(path: unknown): string {
  if (typeof path !== "string" || !path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.split("\n")[0]?.trim() ?? "";
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Maps one tool call onto the transcript's action vocabulary. dsh names the
 * built-in tools `read` / `write` / `edit` / `bash` / `glob` / `grep`, and
 * `bash` carries a human `description` meant exactly for this line.
 */
export function describeTool(name: string, argsJson: string): ToolAction {
  const args = parseArgs(argsJson);
  const file = baseName(args.file_path ?? args.path);

  switch (name) {
    case "bash":
    case "pwsh": {
      const description = firstLine(args.description);
      const command = firstLine(args.command);
      return {
        kind: "bash",
        verb: t("agent.action.ran"),
        target: description || command || name,
      };
    }
    case "read":
      return { kind: "read", verb: t("agent.action.read"), target: file || name };
    case "read_image":
      return { kind: "image", verb: t("agent.action.viewed"), target: file || name };
    case "write":
      return {
        kind: "write",
        verb: t("agent.action.wrote"),
        target: file || name,
        added: lineCount(args.content),
      };
    case "edit": {
      const delta = lineDelta(args.old_string, args.new_string);
      return {
        kind: "edit",
        verb: t("agent.action.edited"),
        target: file || name,
        added: delta.added,
        removed: delta.removed,
      };
    }
    case "glob":
    case "grep":
      return {
        kind: "search",
        verb: t("agent.action.searched"),
        target: firstLine(args.pattern) || name,
      };
    case "web_search": {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      return {
        kind: "web",
        verb: t("agent.action.searchedWeb"),
        target: firstLine(queries[0]) || name,
      };
    }
    case "web_fetch":
      return {
        kind: "web",
        verb: t("agent.action.fetched"),
        target: firstLine(args.url) || name,
      };
    default:
      return { kind: "other", verb: t("agent.action.called"), target: name };
  }
}

/**
 * The verb for a call that is still in flight. The past-tense verbs above are
 * for committed rows; using them for the live line made a running command read
 * as if it had already finished.
 */
export function runningVerb(kind: ToolAction["kind"]): string {
  switch (kind) {
    case "bash":
      return t("agent.action.runningBash");
    case "read":
      return t("agent.action.runningRead");
    case "image":
      return t("agent.action.runningViewed");
    case "write":
      return t("agent.action.runningWrote");
    case "edit":
      return t("agent.action.runningEdited");
    case "search":
      return t("agent.action.runningSearched");
    case "web":
      return t("agent.action.runningFetched");
    case "other":
      return t("agent.action.runningCalled");
  }
}

/**
 * The live "thinking…" line: the newest non-empty line of the accumulated
 * reasoning, flattened to a single row. The text is truncated by CSS.
 */
export function reasoningPreview(reasoning: string): string {
  const lines = reasoning.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].replace(/\s+/g, " ").trim();
    if (line) return line.replace(/^[*#>\-\s]+/, "");
  }
  return "";
}
