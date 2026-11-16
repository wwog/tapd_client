import { featureCommand } from "./feature";
import type { AgentRuntimeStatus } from "./agent";

export type ChatStatus = "starting" | "running" | "stopped" | "failed";

/** 一条自由对话会话；transcript 由各 CLI 落盘，这里只有元数据。 */
export type ChatSession = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  repoPath: string;
  runtimeId: string;
  model: string;
  permissionMode: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: ChatStatus;
  /** hook 捕获的运行时 session id；续接旧会话时使用。 */
  agentSessionId?: string | null;
  error?: string | null;
  /** PTY 已产生输出；为 false 时输入框禁用，避免消息被 TUI 启动过程吞掉。 */
  ready: boolean;
};

/** 列表项：会话元数据 + 当前运行状态。 */
export type ChatSessionView = ChatSession & {
  runtime?: AgentRuntimeStatus;
};

export type ChatStartRequest = {
  workspaceId: string;
  workspaceName?: string;
  runtimeId: string;
  model?: string;
  permissionMode?: string;
};

/** 会话列表过滤（后续过滤 UI 使用）；空字段表示不限制。 */
export type ChatSessionQuery = {
  workspaceId?: string;
  runtimeId?: string;
  model?: string;
  status?: ChatStatus;
  /** 匹配标题 / 项目名。 */
  keyword?: string;
  limit?: number;
  offset?: number;
};

export type ChatSearchRequest = {
  keyword: string;
  workspaceId?: string;
  runtimeId?: string;
  model?: string;
  limit?: number;
};

/** 一条消息内容命中；用于展示关键字上下文。 */
export type ChatSearchHit = {
  sessionId: string;
  title: string;
  workspaceName: string;
  messageId: string;
  role: string;
  at: string;
  snippet: string;
};

export const chatApi = {
  sessions: (query: ChatSessionQuery = {}) =>
    featureCommand<{ sessions: ChatSessionView[] }>("chat_sessions", query),
  /** 在项目仓库目录开启一个长驻会话。 */
  start: (request: ChatStartRequest) =>
    featureCommand<{ session: ChatSession }>("chat_start", request),
  stop: (id: string) =>
    featureCommand<{ ok: boolean }>("chat_stop", { id }),
  /** 用 hook 捕获的 session id 续接已停止的会话。 */
  resume: (id: string) =>
    featureCommand<{ session: ChatSession }>("chat_resume", { id }),
  remove: (id: string) =>
    featureCommand<{ deleted: boolean }>("chat_delete", { id }),
  /** 搜索已落库的对话消息内容。 */
  search: (request: ChatSearchRequest) =>
    featureCommand<{ hits: ChatSearchHit[] }>("chat_search", request),
};
