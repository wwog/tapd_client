/**
 * Files one turn changed, for the transcript's change card.
 *
 * The projection reads the turn's own committed tool calls — `write`, `edit`,
 * `apply_patch` and `str_replace_editor` — so it needs no extra runtime service
 * and survives replay, restart and the phone. A change made through `bash` is
 * invisible here by design: guessing it from shell text would be a lie.
 */
import type { AgentTurnBlock } from "./types";

export type TurnChangeFile = {
  /** As the tool wrote it: usually workspace-relative, native separators. */
  path: string;
  added: number;
  removed: number;
};

export type TurnChanges = {
  files: TurnChangeFile[];
  added: number;
  removed: number;
};

/**
 * Added/removed lines between two literal blocks, as a multiset difference.
 * Kept local on purpose: the change card must not depend on the row-description
 * layer, and the projection has to run (and be tested) on its own.
 */
function lineDelta(
  before: unknown,
  after: unknown,
): { added: number; removed: number } {
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

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lines(value: unknown): number {
  const body = text(value);
  return body.length === 0 ? 0 : body.split("\n").length;
}

/** Paths and line counts of one `apply_patch` input. */
function patchChanges(input: string): TurnChangeFile[] {
  const files: TurnChangeFile[] = [];
  let current: TurnChangeFile | null = null;
  const flush = () => {
    if (current) files.push(current);
    current = null;
  };
  for (const line of input.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header) {
      flush();
      current = { path: header[2].trim(), added: 0, removed: 0 };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  flush();
  return files;
}

/** What one tool call changed, or nothing when it is not a file mutation. */
function toolChanges(name: string, argsJson: string): TurnChangeFile[] {
  const args = parseArgs(argsJson);
  const path = text(args.file_path) || text(args.path);
  switch (name) {
    case "write":
      return path
        ? [{ path, added: lines(args.content), removed: 0 }]
        : [];
    case "edit": {
      if (!path) return [];
      const delta = lineDelta(args.old_string, args.new_string);
      return [{ path, ...delta }];
    }
    case "str_replace_editor":
    case "str_replace_based_edit_tool": {
      if (!path) return [];
      const command = text(args.command);
      if (command === "create") {
        return [{ path, added: lines(args.file_text), removed: 0 }];
      }
      if (command === "insert") {
        return [{ path, added: lines(args.new_str), removed: 0 }];
      }
      return [{ path, ...lineDelta(args.old_str, args.new_str) }];
    }
    case "apply_patch":
      return patchChanges(text(args.input) || text(args.patch));
    default:
      return [];
  }
}

/** Aggregates one turn's file mutations by path, in first-seen order. */
export function turnChanges(block: AgentTurnBlock): TurnChanges {
  const byPath = new Map<string, TurnChangeFile>();
  for (const entry of block.entries) {
    if (entry.kind !== "tool") continue;
    // A failed call changed nothing (dsh applies patches atomically).
    if (entry.status !== "ok") continue;
    for (const change of toolChanges(entry.name, entry.args)) {
      const existing = byPath.get(change.path);
      if (existing) {
        existing.added += change.added;
        existing.removed += change.removed;
      } else {
        byPath.set(change.path, { ...change });
      }
    }
  }
  const files = [...byPath.values()];
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}
