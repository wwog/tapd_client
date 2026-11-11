import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AppPaths = {
  dataDir: string;
  logsDir: string;
  capturesDir: string;
  exportsDir: string;
  runtimeFile: string;
  configFile: string;
};

export type AppInfo = {
  version: string;
  paths: AppPaths;
  loggedIn: boolean;
  me: string | null;
  meAvatar: string | null;
  lastWorkspaceId: string | null;
  runtimePort: number | null;
  /** Port and capability of the local media proxy (images/videos). */
  mediaPort: number | null;
  mediaToken: string | null;
  sessionUrl: string | null;
  hiddenWorkspaceIds: string[];
  onboarded: boolean;
};

export type CapturedRequest = {
  id: number;
  ts: string;
  method: string;
  url: string;
  status: number | null;
  contentType: string | null;
  requestBody: string | null;
  responseBody: string | null;
  size: number | null;
  durationMs: number | null;
  error: string | null;
  truncated: boolean;
};

/** Login-page state mirrored from the hidden TAPD webview. */
export type LoginQrState = {
  phase: "loading" | "qr" | "scanned" | "expired" | "error" | "logged_in";
  qrUrl: string | null;
  name: string | null;
  avatarUrl: string | null;
  corp: string | null;
  message: string | null;
};

export type UserProfile = {
  nick: string;
  userId: string;
  company: string;
};

export type Workspace = {
  id: string;
  name: string;
  prettyName: string;
  category: string;
  status: string;
  logoColor: string | null;
  lastVisitedTime: string | null;
  jumpUrl: string | null;
};

export type WorkspaceContext = {
  user: UserProfile;
  workspaces: Workspace[];
};

export type BugQuery = {
  workspaceId: string;
  owner: string | null;
  /** Creator (TAPD `reporter`) nickname. */
  creator: string | null;
  statuses: string[];
  priorities: string[];
  severities: string[];
  keyword: string | null;
  modifiedAfter: string | null;
  createdAfter: string | null;
  sortName: string;
  order: string;
  page: number;
  perpage: number;
  confId: string | null;
};

export type BugSummary = {
  id: string;
  shortId: string;
  workspaceId: string;
  title: string;
  status: string;
  statusLabel: string;
  priority: string;
  priorityLabel: string;
  severity: string;
  severityLabel: string;
  owner: string;
  creator: string;
  created: string;
  modified: string;
  due: string;
  iterationId: string;
  iterationName: string;
  module: string;
  versionReport: string;
  storyId: string;
  storyName: string;
  bugUrl: string;
};

export type BugListPage = {
  page: number;
  perpage: number;
  total: number;
  statusMap: Record<string, string>;
  /** Status keys in the workspace's configured workflow order. */
  statusOrder: string[];
  bugs: BugSummary[];
};

export type Comment = {
  id: string;
  author: string;
  created: string;
  descriptionHtml: string;
  plainText: string;
  isDeleted: boolean;
  replies: Comment[];
};

export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  filetype: string;
  owner: string;
  created: string;
  entryId: string;
  videoPoster: string;
  videoOriginFile: string;
  downloadUrl: string;
};

export type MediaKind = "image" | "video" | "file";

/** Image/video embedded in the rich-text description or a comment. */
export type MediaRef = {
  url: string;
  kind: MediaKind;
  filenameHint: string;
};

export type ChangeField = {
  field: string;
  before: string;
  after: string;
};

export type ChangeEntry = {
  seq: number;
  time: string;
  author: string;
  kind: string;
  fields: ChangeField[];
};

export type ChangeHistory = {
  total: number;
  changes: ChangeEntry[];
  error: string | null;
};

/** A person who can be picked as owner / developer in a workspace. */
export type WorkspaceMember = {
  nick: string;
  userId: string;
  name: string;
  avatar: string;
};

export type BugTransitionChoice = {
  key: string;
  label: string;
};

export type BugTransitionInfo = {
  currentStatus: string;
  currentLabel: string;
  transitions: BugTransitionChoice[];
};

export type BugTransitionResult = {
  from: string;
  status: string;
  label: string;
  changed: boolean;
};

export type BugDetail = BugSummary & {
  descriptionHtml: string;
  descriptionText: string;
  platform: string;
  os: string;
  testtype: string;
  testphase: string;
  source: string;
  resolution: string;
  resolved: string;
  closed: string;
  reopenTime: string;
  fixer: string;
  de: string;
  te: string;
  participants: string;
  cc: string;
  follower: string;
  releaseName: string;
  workspaceName: string;
  customFields: Record<string, string>;
  comments: Comment[];
  attachments: Attachment[];
  embeddedMedia: MediaRef[];
  changes: ChangeHistory;
};

export type McpClientId = "opencode" | "zcode" | "claude" | "cursor" | "codex";

/** Per-client one-click import status. */
export type McpClientStatus = {
  id: McpClientId;
  /** User-scope config file, when it can be located. */
  path: string | null;
  /** Whether the config already registers tapd-mcp. */
  imported: boolean;
};

export type McpToolInfo = {
  name: string;
  description: string;
  /** `inputSchema` JSON text, parsed by the API docs dialog. */
  schema: string;
};

export type McpConfigInfo = {
  commandPath: string;
  snippet: string;
  transport: string;
  readOnly: boolean;
  tools: McpToolInfo[];
  port: number | null;
  clients: McpClientStatus[];
};

/** User-configurable capability boundary for MCP tool calls. */
export type McpPolicy = {
  writesEnabled: boolean;
  auditEnabled: boolean;
  /** Empty = every project. */
  allowedWorkspaceIds: string[];
  /** Status keys/labels; empty = TAPD workflow decides. */
  allowedStatuses: string[];
};

export type McpAuditEntry = {
  id: string;
  ts: string;
  tool: string;
  client: string;
  decision: "allowed" | "denied" | "error";
  ok: boolean;
  durationMs: number;
  workspaceId: string | null;
  bugId: string | null;
  error: string | null;
  summary: Record<string, unknown>;
};

/** A redacted support bundle written to the local diagnostics directory. */
export type DiagnosticsResult = {
  /** The zip when compression succeeded, otherwise the folder. */
  path: string;
  /** Directory to reveal in Finder. */
  folder: string;
  files: number;
  bytes: number;
  zipped: boolean;
};

export type OpenMediaMode = "file" | "browser" | "reveal" | "path";

export type DirEntryInfo = { name: string; path: string };

/** One folder level for the folder picker. */
export type DirListing = {
  path: string;
  parent: string | null;
  entries: DirEntryInfo[];
};

/** One selectable "open with" app. `icon` is a data URL when available. */
export type OpenTarget = {
  id: string;
  label: string;
  icon: string | null;
};

export type OpenTargetSet = {
  selected: string;
  targets: OpenTarget[];
};

export type ExportResult = {
  dir: string;
  markdownPath: string;
  assetCount: number;
  downloadedBytes: number;
  warnings: string[];
};

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  sessionShow: () => invoke<void>("session_show"),
  loginState: () => invoke<LoginQrState>("session_login_state"),
  reloadLogin: () => invoke<void>("session_reload_login"),
  cacheAvatar: (avatarUrl: string) =>
    invoke<void>("session_cache_avatar", { avatarUrl }),
  logout: () => invoke<void>("session_logout"),
  captures: () => invoke<CapturedRequest[]>("capture_snapshot"),
  clearCaptures: () => invoke<void>("capture_clear"),
  exportCaptures: () => invoke<string>("capture_export"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /** Opens a bound project folder in the saved editor (or `target`). */
  openDirectory: (path: string, target?: string) =>
    invoke<void>("open_directory", { path, target: target ?? null }),
  listDirs: (path?: string) => invoke<DirListing>("list_dirs", { path: path ?? null }),
  openMedia: (url: string, mode: OpenMediaMode, kind?: string, target?: string) =>
    invoke<string>("open_media", {
      url,
      mode,
      kind: kind ?? null,
      target: target ?? null,
    }),
  openTargets: (kind: string) => invoke<OpenTargetSet>("open_targets", { kind }),
  setOpenTarget: (kind: string, id: string) =>
    invoke<void>("set_open_target", { kind, id }),
  workspaceContext: () => invoke<WorkspaceContext>("workspace_context"),
  bugList: (query: BugQuery) => invoke<BugListPage>("bug_list", { query }),
  bugDetail: (workspaceId: string, bugId: string) =>
    invoke<BugDetail>("bug_detail", { workspaceId, bugId }),
  workspaceMembers: (workspaceId: string) =>
    invoke<WorkspaceMember[]>("workspace_members", { workspaceId }),
  bugAddComment: (workspaceId: string, bugId: string, comment: string) =>
    invoke<void>("bug_add_comment", { workspaceId, bugId, comment }),
  bugUpdateField: (
    workspaceId: string,
    bugId: string,
    field: string,
    value: string,
  ) => invoke<void>("bug_update_field", { workspaceId, bugId, field, value }),
  bugTransitions: (workspaceId: string, bugId: string) =>
    invoke<BugTransitionInfo>("bug_transitions", { workspaceId, bugId }),
  bugTransition: (workspaceId: string, bugId: string, status: string) =>
    invoke<BugTransitionResult>("bug_transition", { workspaceId, bugId, status }),
  exportBugMd: (workspaceId: string, bugId: string, workspaceName: string | null) =>
    invoke<ExportResult>("export_bug_md", { workspaceId, bugId, workspaceName }),
  setCurrentUser: (nick: string) =>
    invoke<void>("set_current_user", { nick }),
  /** Grows the window to `minWidth` (leftwards) if the detail panel needs room. */
  ensureWindowWidth: (minWidth: number) =>
    invoke<number>("ensure_window_width", { minWidth }),
  setLastWorkspace: (workspaceId: string) =>
    invoke<void>("set_last_workspace", { workspaceId }),
  setHiddenWorkspaces: (ids: string[]) =>
    invoke<void>("set_hidden_workspaces", { ids }),
  mcpConfig: () => invoke<McpConfigInfo>("mcp_config"),
  completeOnboarding: () => invoke<void>("complete_onboarding"),
  resetOnboarding: () => invoke<void>("reset_onboarding"),
  mcpPolicyGet: () => invoke<McpPolicy>("mcp_policy_get"),
  mcpPolicySet: (policy: McpPolicy) =>
    invoke<McpPolicy>("mcp_policy_set", { policy }),
  mcpAuditList: (limit?: number) =>
    invoke<McpAuditEntry[]>("mcp_audit_list", { limit: limit ?? null }),
  mcpAuditClear: () => invoke<void>("mcp_audit_clear"),
  mcpAuditExport: () => invoke<string>("mcp_audit_export"),
  exportDiagnostics: () => invoke<DiagnosticsResult>("export_diagnostics"),
  /** Wipes the app data directory and restarts the app. */
  clearAppData: () => invoke<void>("clear_app_data"),
};

export const onSessionChanged = (callback: () => void): Promise<UnlistenFn> =>
  listen("session://changed", () => callback());

let mediaBase: string | null = null;

const buildMediaBase = (port: number, token: string): string =>
  `http://127.0.0.1:${port}/media?token=${encodeURIComponent(token)}&url=`;

/** Remembers the media proxy base URL once `app_info` has been loaded. */
export const setMediaEndpoint = (
  info: Pick<AppInfo, "mediaPort" | "mediaToken">,
): void => {
  mediaBase =
    info.mediaPort && info.mediaToken
      ? buildMediaBase(info.mediaPort, info.mediaToken)
      : null;
};

/**
 * Fetches the media proxy endpoint on demand. `app_info` can be read before the
 * loopback server has written its runtime info, which would leave every
 * thumbnail/preview without a URL.
 */
export const ensureMediaEndpoint = async (): Promise<void> => {
  if (mediaBase) return;
  try {
    const endpoint = await invoke<{ port: number; token: string }>("media_endpoint");
    mediaBase = buildMediaBase(endpoint.port, endpoint.token);
  } catch {
    // The server is still starting; the next open will retry.
  }
};

/**
 * Local proxy URL for a TAPD resource. The main window has no tapd.cn cookies,
 * so images/videos are served by the app's loopback media proxy.
 */
export const mediaSrc = (url: string): string | undefined =>
  mediaBase ? `${mediaBase}${encodeURIComponent(url)}` : undefined;

/**
 * Avatar URL for `<img>`: TAPD-hosted avatars need the session cookie, so they
 * go through the media proxy. WeCom/CDN avatars are public and load directly.
 */
export const avatarSrc = (url: string | null | undefined): string | undefined => {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\/(?:[^/]*\.)?tapd\.cn(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return mediaSrc(trimmed) ?? trimmed;
  }
  return trimmed;
};

export const formatBytes = (bytes: number | null | undefined): string => {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const relativeTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))} 秒前`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};
