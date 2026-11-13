import type {
  AgentChatMessage,
  AgentChatTool,
  AgentRuntimeStatus,
} from "./agent";

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

const TOOL_META: Record<string, ToolMeta> = {
  read: { label: "读取文件", category: "read" },
  readfile: { label: "读取文件", category: "read" },
  fileread: { label: "读取文件", category: "read" },
  viewfile: { label: "读取文件", category: "read" },
  openfile: { label: "读取文件", category: "read" },
  cat: { label: "读取文件", category: "read" },
  head: { label: "读取文件", category: "read" },
  tail: { label: "读取文件", category: "read" },
  write: { label: "写入文件", category: "write" },
  writefile: { label: "写入文件", category: "write" },
  createfile: { label: "写入文件", category: "write" },
  addfile: { label: "写入文件", category: "write" },
  edit: { label: "修改文件", category: "edit" },
  editfile: { label: "修改文件", category: "edit" },
  multiedit: { label: "修改文件", category: "edit" },
  patch: { label: "修改文件", category: "edit" },
  applypatch: { label: "修改文件", category: "edit" },
  strreplace: { label: "修改文件", category: "edit" },
  astedit: { label: "修改文件", category: "edit" },
  bash: { label: "执行命令", category: "exec" },
  shell: { label: "执行命令", category: "exec" },
  execute: { label: "执行命令", category: "exec" },
  exec: { label: "执行命令", category: "exec" },
  command: { label: "执行命令", category: "exec" },
  runcommand: { label: "执行命令", category: "exec" },
  execcommand: { label: "执行命令", category: "exec" },
  terminal: { label: "执行命令", category: "exec" },
  powershell: { label: "执行命令", category: "exec" },
  grep: { label: "搜索", category: "search" },
  glob: { label: "搜索", category: "search" },
  search: { label: "搜索", category: "search" },
  find: { label: "搜索", category: "search" },
  ripgrep: { label: "搜索", category: "search" },
  webfetch: { label: "联网", category: "web" },
  websearch: { label: "联网", category: "web" },
  fetch: { label: "联网", category: "web" },
  browse: { label: "联网", category: "web" },
  task: { label: "子 Agent", category: "agent" },
  agent: { label: "子 Agent", category: "agent" },
  subagent: { label: "子 Agent", category: "agent" },
};

const normalizeToolName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 工具名 → 标题与图标分类。未知工具回退到「工具」。 */
export function describeTool(name: string): ToolMeta {
  const key = normalizeToolName(name);
  const known = TOOL_META[key];
  if (known) return known;
  if (key.startsWith("mcp")) return { label: "MCP 工具", category: "mcp" };
  if (key.includes("grep") || key.includes("search")) {
    return { label: "搜索", category: "search" };
  }
  if (key.includes("edit") || key.includes("patch")) {
    return { label: "修改文件", category: "edit" };
  }
  return { label: "工具", category: "other" };
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
        label: "思考",
        detail: oneLine(message.text, 90),
        tone: "thinking",
      });
      continue;
    }
    if (message.kind === "system") {
      rows.push({
        id: message.id,
        at: message.at,
        label: "系统",
        detail: oneLine(message.text, 90),
        tone: "system",
      });
      continue;
    }
    if (message.role === "user") {
      rows.push({
        id: message.id,
        at: message.at,
        label: "收到任务",
        detail: oneLine(message.text, 90),
        tone: "user",
      });
      continue;
    }
    if (message.role === "assistant") {
      rows.push({
        id: message.id,
        at: message.at,
        label: "回复",
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
