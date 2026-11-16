import type {
  AgentChatMessage,
  AgentChatTool,
  AgentRuntimeStatus,
} from "./agent";
import { t, type MessageKey } from "./i18n";

/** 工具卡片的归类；只影响图标和标题，不改变后端数据。 */
export type ToolCategory =
  | "read"
  | "write"
  | "edit"
  | "exec"
  | "search"
  | "web"
  | "agent"
  | "mcp"
  | "other";

type ToolMeta = {
  label: string;
  category: ToolCategory;
};

/** Tool name → category. The label follows from the category, so it is
 *  translated at call time instead of being frozen in this table. */
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  read: "read",
  readfile: "read",
  fileread: "read",
  viewfile: "read",
  openfile: "read",
  cat: "read",
  head: "read",
  tail: "read",
  write: "write",
  writefile: "write",
  createfile: "write",
  addfile: "write",
  edit: "edit",
  editfile: "edit",
  multiedit: "edit",
  patch: "edit",
  applypatch: "edit",
  strreplace: "edit",
  astedit: "edit",
  bash: "exec",
  shell: "exec",
  execute: "exec",
  exec: "exec",
  command: "exec",
  runcommand: "exec",
  execcommand: "exec",
  terminal: "exec",
  powershell: "exec",
  grep: "search",
  glob: "search",
  search: "search",
  find: "search",
  ripgrep: "search",
  webfetch: "web",
  websearch: "web",
  fetch: "web",
  browse: "web",
  task: "agent",
  agent: "agent",
  subagent: "agent",
};

/** Category label keys, resolved per render so the language can switch. */
const CATEGORY_LABELS: Record<ToolCategory, MessageKey> = {
  read: "chat.toolRead",
  write: "chat.toolWrite",
  edit: "chat.toolEdit",
  exec: "chat.toolExec",
  search: "common.search",
  web: "chat.toolWeb",
  agent: "chat.toolAgent",
  mcp: "chat.toolMcp",
  other: "chat.toolOther",
};

const normalizeToolName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 工具名 → 标题与图标分类。未知工具回退到「工具」。 */
export function describeTool(name: string): ToolMeta {
  const key = normalizeToolName(name);
  const known = TOOL_CATEGORIES[key];
  if (known) return { label: t(CATEGORY_LABELS[known]), category: known };
  if (key.startsWith("mcp")) {
    return { label: t(CATEGORY_LABELS.mcp), category: "mcp" };
  }
  if (key.includes("grep") || key.includes("search")) {
    return { label: t(CATEGORY_LABELS.search), category: "search" };
  }
  if (key.includes("edit") || key.includes("patch")) {
    return { label: t(CATEGORY_LABELS.edit), category: "edit" };
  }
  return { label: t(CATEGORY_LABELS.other), category: "other" };
}

/** 工具参数的第一行，作为卡片副标题。 */
export function toolTarget(tool: AgentChatTool): string {
  const input = (tool.input ?? "").trim();
  if (!input) return "";
  const first = input.split("\n").find((line) => line.trim()) ?? "";
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

/** 毫秒 → `820ms` / `2.4s` / `1m 12s`。 */
export function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** 从 startedAt 算到 `now` 的已用时长；时间无效时返回空串。 */
export function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return "";
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "";
  return formatDuration(Math.max(0, now - start));
}

/** 单行预览：压缩空白并限长。 */
export function oneLine(text: string | undefined, limit = 140): string {
  if (!text) return "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export type TimelineRow = {
  id: string;
  at: string;
  label: string;
  detail: string;
  tone: "user" | "assistant" | "tool" | "thinking" | "system";
  status?: string;
  durationMs?: number;
};

/** 把 transcript 投影成左栏的紧凑步骤；只保留最近 500 条。 */
export function projectTimeline(messages: AgentChatMessage[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const message of messages) {
    if (message.kind === "tool" && message.tool) {
      const meta = describeTool(message.tool.name);
      rows.push({
        id: message.id,
        at: message.at,
        label: meta.label,
        detail: toolTarget(message.tool),
        tone: "tool",
        status: message.tool.status,
        durationMs: message.tool.durationMs,
      });
      continue;
    }
    if (message.kind === "thinking") {
      rows.push({
        id: message.id,
        at: message.at,
        label: t("chat.thinking"),
        detail: oneLine(message.text, 90),
        tone: "thinking",
      });
      continue;
    }
    if (message.kind === "system") {
      rows.push({
        id: message.id,
        at: message.at,
        label: t("chat.system"),
        detail: oneLine(message.text, 90),
        tone: "system",
      });
      continue;
    }
    if (message.role === "user") {
      rows.push({
        id: message.id,
        at: message.at,
        label: t("chat.taskReceived"),
        detail: oneLine(message.text, 90),
        tone: "user",
      });
      continue;
    }
    if (message.role === "assistant") {
      rows.push({
        id: message.id,
        at: message.at,
        label: t("chat.reply"),
        detail: oneLine(message.text, 90),
        tone: "assistant",
      });
    }
  }
  return rows.length > 500 ? rows.slice(rows.length - 500) : rows;
}

/** 左栏末行：hook 的当前动作，transcript 追上之前作为「进行中」占位。 */
export function statusTimelineRow(
  status: AgentRuntimeStatus | undefined,
): TimelineRow | null {
  if (!status) return null;
  if (status.phase !== "working" && status.phase !== "waiting_permission" && status.phase !== "waiting_question") {
    return null;
  }
  return {
    id: `status:${status.updatedAt}`,
    at: status.updatedAt,
    label: status.label,
    detail: oneLine(status.detail ?? status.tool ?? status.message, 90),
    tone: "tool",
    status: status.phase === "working" ? "running" : "waiting",
  };
}
