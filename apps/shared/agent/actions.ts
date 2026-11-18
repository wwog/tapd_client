import type { AgentLocale } from "./types";
import { agentLabel } from "./labels";

/** What a tool call looks like as one timeline row. */
export type ToolAction = {
  kind: "bash" | "read" | "write" | "edit" | "search" | "web" | "image" | "other";
  /** Past-tense verb, localized: 已执行 / 已阅读 / … */
  verb: string;
  /** The one thing the row is about: description, file name, pattern, URL. */
  target: string;
  /** The model's own one-line summary of the call, when the tool carries one. */
  description?: string;
  /** Line additions/deletions, for write and edit. */
  added?: number;
  removed?: number;
};

/** Which folded group a call belongs to. */
export type ToolGroup = "reads" | "commands" | "files";

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
export function describeTool(name: string, argsJson: string, locale: AgentLocale): ToolAction {
  const args = parseArgs(argsJson);
  const file = baseName(args.file_path ?? args.path);
  // The model's one-line account of the call: bash requires it, subagent and
  // team_task_create carry it, file tools do not.
  const description = firstLine(args.description) || undefined;

  switch (name) {
    case "bash":
    case "pwsh": {
      // The command itself, not the model's summary: "what actually ran" is the
      // question this row answers. It stays one line and truncates.
      const command = firstLine(args.command);
      return {
        kind: "bash",
        verb: agentLabel("action.ran", locale),
        target: command || description || name,
        description,
      };
    }
    case "read":
      return { kind: "read", verb: agentLabel("action.read", locale), target: file || name };
    case "read_image":
      return { kind: "image", verb: agentLabel("action.viewed", locale), target: file || name };
    case "write":
      return {
        kind: "write",
        verb: agentLabel("action.wrote", locale),
        target: file || name,
        added: lineCount(args.content),
      };
    case "edit": {
      const delta = lineDelta(args.old_string, args.new_string);
      return {
        kind: "edit",
        verb: agentLabel("action.edited", locale),
        target: file || name,
        added: delta.added,
        removed: delta.removed,
      };
    }
    case "glob":
    case "grep":
      return {
        kind: "search",
        verb: agentLabel("action.searched", locale),
        target: firstLine(args.pattern) || name,
      };
    case "web_search": {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      return {
        kind: "web",
        verb: agentLabel("action.searchedWeb", locale),
        target: firstLine(queries[0]) || name,
      };
    }
    case "web_fetch":
      return {
        kind: "web",
        verb: agentLabel("action.fetched", locale),
        target: firstLine(args.url) || name,
      };
    case "job_output":
      // A job read is still execution work, but its target is the job, not a
      // shell command.
      return {
        kind: "bash",
        verb: agentLabel("action.fetched", locale),
        target: firstLine(args.job_id) || name,
      };
    case "subagent":
      return {
        kind: "other",
        verb: agentLabel("action.called", locale),
        target: firstLine(args.name) || name,
        description,
      };
    default:
      return {
        kind: "other",
        verb: agentLabel("action.called", locale),
        target: name,
        description,
      };
  }
}

/** The folded group a call belongs to; `subagent` never reaches this. */
export function toolGroup(name: string, argsJson: string): ToolGroup {
  const kind = describeTool(name, argsJson, "zh").kind;
  if (kind === "read" || kind === "image" || kind === "search" || kind === "web") {
    return "reads";
  }
  if (kind === "write" || kind === "edit") return "files";
  return "commands";
}

/**
 * The verb for a call that is still in flight. The past-tense verbs above are
 * for committed rows; using them for the live line made a running command read
 * as if it had already finished.
 */
export function runningVerb(kind: ToolAction["kind"], locale: AgentLocale): string {
  switch (kind) {
    case "bash":
      return agentLabel("action.runningBash", locale);
    case "read":
      return agentLabel("action.runningRead", locale);
    case "image":
      return agentLabel("action.runningViewed", locale);
    case "write":
      return agentLabel("action.runningWrote", locale);
    case "edit":
      return agentLabel("action.runningEdited", locale);
    case "search":
      return agentLabel("action.runningSearched", locale);
    case "web":
      return agentLabel("action.runningFetched", locale);
    case "other":
      return agentLabel("action.runningCalled", locale);
  }
}

/** The verb for a call whose call is still being generated (live overlay). */
export function pendingVerb(
  name: string,
  kind: ToolAction["kind"],
  locale: AgentLocale,
): string {
  if (name === "ask_user_question") return agentLabel("step.preparingAsk", locale);
  if (name === "job_output" || name === "wait_agent") {
    return agentLabel("step.preparingWait", locale);
  }
  switch (kind) {
    case "read":
    case "image":
      return agentLabel("step.preparingRead", locale);
    case "search":
    case "web":
      return agentLabel("step.preparingSearch", locale);
    case "write":
    case "edit":
      return agentLabel("step.preparingEdit", locale);
    case "other":
      return agentLabel("step.preparingCall", locale);
    case "bash":
      return agentLabel("step.preparing", locale);
  }
}

/** The verb for a failed call: execution, read, search and edit fail apart. */
export function failedVerb(kind: ToolAction["kind"], locale: AgentLocale): string {
  switch (kind) {
    case "read":
    case "image":
      return agentLabel("step.failedRead", locale);
    case "search":
    case "web":
      return agentLabel("step.failedSearch", locale);
    case "write":
    case "edit":
      return agentLabel("step.failedEdit", locale);
    case "other":
      return agentLabel("step.failedCall", locale);
    case "bash":
      return agentLabel("step.failed", locale);
  }
}

/**
 * Whether a running call is really blocked on an external event. These are the
 * steps whose state reads as "waiting", not "running".
 */
export function isWaitingTool(name: string, argsJson: string): boolean {
  if (name === "ask_user_question" || name === "wait_agent") return true;
  if (name === "job_output") return parseArgs(argsJson).wait === true;
  return false;
}

/** The waiting verb and the thing being waited on, for the latest-step line. */
export function waitingDetail(
  name: string,
  argsJson: string,
  locale: AgentLocale,
): { verb: string; target: string } | null {
  const args = parseArgs(argsJson);
  if (name === "ask_user_question") {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const first = questions[0] as Record<string, unknown> | undefined;
    return {
      verb: agentLabel("step.waitingAnswer", locale),
      target: firstLine(first?.header) || firstLine(first?.question),
    };
  }
  if (name === "job_output") {
    return {
      verb: agentLabel("step.waitingJob", locale),
      target: firstLine(args.job_id),
    };
  }
  if (name === "wait_agent") {
    return {
      verb: agentLabel("step.waitingAgent", locale),
      target:
        firstLine(args.name) || firstLine(args.agent_id) || firstLine(args.id),
    };
  }
  return null;
}

/** One expanded tool call's input block. `meta` is a secondary line. */
export type ToolInput = { text: string; meta?: string; diff?: boolean };

/**
 * What a call sent: the raw command for shell tools, the path/pattern for file
 * tools, a synthesized old/new block for `edit`, and pretty args otherwise.
 */
export function toolInput(name: string, argsJson: string): ToolInput {
  const args = parseArgs(argsJson);
  switch (name) {
    case "bash":
    case "pwsh": {
      const workdir = firstLine(args.workdir);
      return {
        text: typeof args.command === "string" ? args.command : argsJson,
        meta: workdir ? `cwd: ${workdir}` : undefined,
      };
    }
    case "read":
    case "read_image": {
      const extras: string[] = [];
      if (args.offset != null) extras.push(`offset: ${String(args.offset)}`);
      if (args.limit != null) extras.push(`limit: ${String(args.limit)}`);
      return {
        text: String(args.file_path ?? args.path ?? ""),
        meta: extras.length > 0 ? extras.join(" · ") : undefined,
      };
    }
    case "glob":
    case "grep": {
      const path = firstLine(args.path) || firstLine(args.file_path);
      return {
        text: firstLine(args.pattern) || argsJson,
        meta: path ? `path: ${path}` : undefined,
      };
    }
    case "web_fetch":
      return { text: firstLine(args.url) || argsJson };
    case "web_search": {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      return { text: queries.map((query) => String(query)).join("\n") || argsJson };
    }
    case "write": {
      const path = String(args.file_path ?? args.path ?? "");
      const content = typeof args.content === "string" ? args.content : "";
      return { text: path ? `${path}\n\n${content}` : content || argsJson };
    }
    case "edit": {
      const path = String(args.file_path ?? args.path ?? "");
      const before = typeof args.old_string === "string" ? args.old_string : "";
      const after = typeof args.new_string === "string" ? args.new_string : "";
      const lines = [
        ...(path ? [`--- ${path}`] : []),
        "--- old",
        ...before.split("\n").map((line) => `-${line}`),
        "+++ new",
        ...after.split("\n").map((line) => `+${line}`),
      ];
      return { text: lines.join("\n"), diff: true };
    }
    default:
      return { text: argsJson ? JSON.stringify(args, null, 2) : "" };
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
