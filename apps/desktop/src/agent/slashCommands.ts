/**
 * The composer's `/` catalog.
 *
 * dsh desktop groups its slash menu into 添加 (things that shape the input) and
 * 指令 (things that act on the session). The engine registers six of them
 * (`goal`, `plan`, `feedback`, `compact`, `permission`, `export`); `file` and
 * `model` are client commands, and this app answers `plan`, `permission`,
 * `model`, `file` and `export` itself — its permission modes and export format
 * are its own, so those must not round-trip through the engine's presets.
 *
 * Everything here is pure: the palette renders the result, the composer routes
 * a submitted line with `slashIntent`.
 */
import {
  Cpu,
  Download,
  ListTodo,
  Minimize2,
  Paperclip,
  Send,
  ShieldCheck,
  Target,
  type LucideIcon,
} from "lucide-react";

import type { DshCommandDescriptor } from "../lib/dsh";
import type { MessageKey } from "../lib/i18n";

export type SlashGroup = "add" | "command";

/** What picking the row does. */
export type SlashAction =
  /** Answered by this app: opens its own picker / runs its own action. */
  | { kind: "native"; action: "file" | "plan" | "permission" | "model" | "export" }
  /** Needs typed input first: inserts the command and leaves the caret. */
  | { kind: "insert"; text: string }
  /** Executed by the runtime's own command registry. */
  | { kind: "runtime" };

export type SlashCommand = {
  /** Without the leading slash. */
  name: string;
  group: SlashGroup;
  icon: LucideIcon;
  label: MessageKey;
  hint: MessageKey;
  action: SlashAction;
  /** The engine's own description, when it advertises this command. */
  description?: string;
  /** The engine's own argument grammar (`[off|message]`). */
  inputHint?: string;
  /** Advertised by the engine but unknown to this build: no localized copy. */
  generic?: boolean;
};

/** `名称 英文` rows, in dsh desktop's order. */
const CATALOG: readonly SlashCommand[] = [
  {
    name: "file",
    group: "add",
    icon: Paperclip,
    label: "agent.cmd.file",
    hint: "agent.cmd.fileHint",
    action: { kind: "native", action: "file" },
  },
  {
    name: "goal",
    group: "add",
    icon: Target,
    label: "agent.cmd.goal",
    hint: "agent.cmd.goalHint",
    action: { kind: "insert", text: "/goal " },
  },
  {
    name: "plan",
    group: "add",
    icon: ListTodo,
    label: "agent.cmd.plan",
    hint: "agent.cmd.planHint",
    action: { kind: "native", action: "plan" },
  },
  {
    name: "feedback",
    group: "add",
    icon: Send,
    label: "agent.cmd.feedback",
    hint: "agent.cmd.feedbackHint",
    action: { kind: "insert", text: "/feedback " },
  },
  {
    name: "compact",
    group: "command",
    icon: Minimize2,
    label: "agent.cmd.compact",
    hint: "agent.cmd.compactHint",
    action: { kind: "runtime" },
  },
  {
    name: "permission",
    group: "command",
    icon: ShieldCheck,
    label: "agent.cmd.permission",
    hint: "agent.cmd.permissionHint",
    action: { kind: "native", action: "permission" },
  },
  {
    name: "model",
    group: "command",
    icon: Cpu,
    label: "agent.cmd.model",
    hint: "agent.cmd.modelHint",
    action: { kind: "native", action: "model" },
  },
  {
    name: "export",
    group: "command",
    icon: Download,
    label: "agent.cmd.export",
    hint: "agent.cmd.exportHint",
    action: { kind: "native", action: "export" },
  },
];

/** dsh's own command-line grammar: `/name` then a whitespace-separated input. */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u;

/**
 * Names this app executes itself when a line is submitted, so they work even
 * when the runtime is down. `goal` and `feedback` are not here: picking their
 * row only inserts the command, and the submitted line belongs to the engine.
 */
export const NATIVE_COMMANDS = new Set([
  "file",
  "plan",
  "permission",
  "model",
  "export",
]);

export type ParsedSlash = { name: string; args: string };

/** The command a draft could be, or `undefined` for ordinary text. */
export function parseSlashLine(line: string): ParsedSlash | undefined {
  const match = COMMAND_LINE.exec(line.trimStart());
  if (!match) return undefined;
  const name = match[1];
  const args = line.trimStart().slice(match[0].length).trim();
  return { name, args };
}

/**
 * The menu's open condition: a lone `/` followed by a name — no whitespace, so
 * typing the arguments closes it instead of stealing Enter from the send path.
 */
export function slashQuery(draft: string): string | undefined {
  if (!draft.startsWith("/")) return undefined;
  const rest = draft.slice(1);
  if (rest.includes(" ") || rest.includes("\n") || rest.includes("\t")) return undefined;
  return rest;
}

function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * The visible rows for one draft: this app's eight, plus any engine command
 * this build does not know (a future dsh row shows up generically instead of
 * silently missing), filtered by name, localized label and description.
 */
export function buildSlashItems(
  draft: string,
  descriptors: readonly DshCommandDescriptor[] = [],
  label: (key: MessageKey) => string = () => "",
): SlashCommand[] {
  const query = slashQuery(draft);
  if (query === undefined) return [];
  const needle = lower(query);

  const known = new Set(CATALOG.map((command) => command.name));
  const engine: SlashCommand[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor?.name || known.has(descriptor.name)) continue;
    known.add(descriptor.name);
    engine.push({
      name: descriptor.name,
      group: "command",
      icon: Send,
      label: "agent.cmd.other",
      hint: "agent.cmd.otherHint",
      action: { kind: "runtime" },
      description: descriptor.description,
      generic: true,
      ...(descriptor.inputHint ? { inputHint: descriptor.inputHint } : {}),
    });
  }

  const all = [...CATALOG, ...engine].map((command) => {
    const descriptor = descriptors.find((item) => item.name === command.name);
    return descriptor
      ? {
          ...command,
          description: command.description ?? descriptor.description,
          ...(descriptor.inputHint && !command.inputHint
            ? { inputHint: descriptor.inputHint }
            : {}),
        }
      : command;
  });

  if (!needle) return all;
  const matched = all.filter((command) => {
    if (lower(command.name).includes(needle)) return true;
    if (lower(command.description ?? "").includes(needle)) return true;
    return lower(label(command.label)).includes(needle);
  });
  // Prefix matches first: `/co` should not put `compact` after an unrelated
  // command whose description happens to contain "co".
  return matched.sort((left, right) => {
    const leftPrefix = lower(left.name).startsWith(needle) ? 0 : 1;
    const rightPrefix = lower(right.name).startsWith(needle) ? 0 : 1;
    return leftPrefix - rightPrefix;
  });
}

export type SlashIntent =
  | { kind: "native"; name: string; args: string }
  | { kind: "runtime"; line: string }
  /** Not a command this build knows: send it as an ordinary message. */
  | { kind: "prompt" };

/**
 * How Enter should treat a submitted line. `runtimeNames` is the catalog the
 * engine advertised for this session; an unknown `/foo` stays a normal message
 * (dsh's own behavior: the model sees it).
 */
export function slashIntent(
  line: string,
  runtimeNames: ReadonlySet<string>,
): SlashIntent {
  const parsed = parseSlashLine(line);
  if (!parsed) return { kind: "prompt" };
  if (NATIVE_COMMANDS.has(parsed.name)) {
    return { kind: "native", name: parsed.name, args: parsed.args };
  }
  if (runtimeNames.has(parsed.name)) {
    return { kind: "runtime", line: line.trim() };
  }
  return { kind: "prompt" };
}

/** The permission mode a typed `/permission <arg>` means, if any. */
export function permissionArg(args: string): "plan" | "notify" | "auto" | "full" | undefined {
  switch (lower(args.trim())) {
    case "notify":
    case "read-only":
    case "readonly":
      return "notify";
    case "auto":
    case "workspace-write":
      return "auto";
    case "full":
    case "danger-full-access":
      return "full";
    default:
      return undefined;
  }
}

/** `@path` as the engine's file-reference grammar expects it. */
export function fileMention(path: string): string {
  return /[\s"]/u.test(path) ? `@"${path}"` : `@${path}`;
}
