/**
 * Companion data layer: same-origin relative fetches against the desktop's
 * companion server, Bearer session token, `{ ok, data }` envelope.
 *
 * Data shapes are copied verbatim from `apps/desktop/src/lib/api.ts` (the
 * serde contract lives there; the companion renders exactly what the desktop
 * components render).
 */
import { useSyncExternalStore } from "react";

import { t } from "./i18n";
import { navigate } from "./router";
import { clearSession, getMediaToken, getSession } from "./session";

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

/* -------------------------------------------------------------------------
   Project files (read-only). Shapes mirror `apps/desktop/src/lib/fs.ts`;
   the Rust companion routes serialize the same serde structs.
   ------------------------------------------------------------------------- */

export type FsEntryKind = "dir" | "file" | "symlink";

export type FsEntry = {
  name: string;
  /** Relative to the project root, `/`-separated, no leading slash. */
  path: string;
  kind: FsEntryKind;
  /** Bytes; 0 for directories. */
  size: number;
  /** Unix seconds. */
  mtime: number;
  /** Dot-prefixed name. */
  hidden: boolean;
};

export type FsListing = {
  /** Absolute project root; display only, never sent back as a path. */
  root: string;
  /** Relative directory; "" is the project root. */
  path: string;
  entries: FsEntry[];
  /** The directory exceeded the entry cap and was cut off. */
  truncated: boolean;
};

/** What a preview can render. Anything else falls back to metadata only. */
export type FsContentKind =
  | "text"
  | "markdown"
  | "image"
  | "audio"
  | "video"
  | "binary"
  | "tooLarge";

export type FsContent = {
  kind: FsContentKind;
  path: string;
  size: number;
  mtime: number;
  /** Milliseconds since the epoch; the editor's conflict token. */
  mtimeMs: number;
  /** UTF-8 body for text/markdown; null for every other kind. */
  text: string | null;
  /** The read stopped at the desktop's text limit. */
  truncated: boolean;
};

/** Save acknowledgement: the new mtime feeds the next conflict check. */
export type FsWriteResult = {
  path: string;
  kind: FsEntryKind;
  size: number;
  mtime: number;
  mtimeMs: number;
};

/* -------------------------------------------------------------------------
   Local projects and work items. A local project is a folder on the desktop
   machine; work items belong to it and can be handed to an Agent without ever
   touching TAPD. Shapes mirror the desktop's local_* feature commands.
   ------------------------------------------------------------------------- */

export type LocalProject = {
  id: string;
  name: string;
  /** Absolute desktop folder; chosen through the directory picker. */
  repoPath: string;
  /** Markdown rules appended to every Agent task of this project. */
  rule: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemStatus = "pending" | "in_progress" | "done";

export type WorkItem = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  /** Agent task currently (or last) attached to this item; null when never queued. */
  agentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One directory level of a browseable folder; `parent` is null at the root. */
export type DirListing = {
  path: string;
  parent: string | null;
  /** Directories only; files are not browsable here. */
  entries: Array<{ name: string; path: string }>;
};

export type BugQuery = {
  workspaceId: string;
  /** 处理人 nicknames; several match with OR. */
  owners: string[];
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

/** Resource embedded in the rich-text description or a comment. */
export type MediaRef = {
  url: string;
  kind: MediaKind;
  filenameHint: string;
  /** Size TAPD reported for an inline attachment card; 0 when unknown. */
  size: number;
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

/** A person who can be picked as owner / creator in a workspace. */
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

/** `GET /companion/api/state` — read-only desktop connection info. */
export type CompanionState = {
  loggedIn: boolean;
  version: string;
  me: string | null;
  workspaces: Workspace[];
};

/** One paired device, from the manager-only devices endpoint. */
export type CompanionDeviceInfo = {
  id: string;
  name: string;
  pairedAt: string;
  online: boolean;
  lastSeenAt: string | null;
  canManage: boolean;
  self: boolean;
};

export type CompanionDevices = {
  selfId: string;
  devices: CompanionDeviceInfo[];
};

/** Mirror of the desktop notification engine's entries (read-only). */
export type CompanionNotification = {
  id: string;
  workspaceId: string;
  bugId: string;
  title: string;
  kind: string;
  created: string;
  detectedAt: string;
};

/* -------------------------------------------------------------------------
   Agent settings, copied from the desktop `agent_settings` module. The phone
   may only read/write the worktree switch and the execution units; the prompt
   template and project rules stay on the desktop.
   ------------------------------------------------------------------------- */

export type ProjectAgentConfig = {
  repoPath: string;
  rule: string;
};

export type AgentSettings = {
  /** TAPD workspace id -> configured local repository folder. */
  projects: Record<string, ProjectAgentConfig>;
  /** How many workflow tasks may run at once; the rest queue. */
  executionUnits: number;
};

/* -------------------------------------------------------------------------
   Notification settings, copied from `apps/desktop/src/lib/notification.ts`.
   ------------------------------------------------------------------------- */

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export type NotificationSettings = {
  enabled: boolean;
  /** "mine" | "project"; rendered read-only on the phone. */
  scope?: string;
  includeNew: boolean;
  includeTransferred: boolean;
  includeReopened: boolean;
  pollIntervalSecs: number;
  quietHours: QuietHours;
  maxVisible: number;
  aiEnabled?: boolean;
};

/* -------------------------------------------------------------------------
   Coworker packages, copied from `apps/desktop/src/lib/coworker.ts`.
   ------------------------------------------------------------------------- */

export type CoworkerSkill = {
  name: string;
  description: string;
  /** Absolute path to SKILL.md, injected into the prompt. */
  path: string;
};

/** A bundled coworker package as shown on the 同事 page. */
export type Coworker = {
  /** Folder name; the only stable id. */
  id: string;
  name: string;
  role: string;
  title?: string;
  description?: string;
  /** `#rrggbb`, or empty when the package did not set one. */
  accent?: string;
  /** Data URL, or null when the avatar could not be read. */
  avatar?: string | null;
  skills: CoworkerSkill[];
};

export type CoworkerList = {
  coworkers: Coworker[];
  /** Enabled ids in selection order. */
  selectedIds: string[];
  /** Exact block appended to the task prompt; empty when nobody is enabled. */
  promptSection?: string;
  /** Packages/skills that failed validation; surfaced on the page. */
  warnings?: string[];
};

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError("error", t("mobile.api.requestFailed"));
}

/** Global desktop-side connection state, shared by every page. */
export type Connection = { kind: "ok" | "offline" | "not_logged_in"; attempt: number };

let connection: Connection = { kind: "ok", attempt: 0 };
const listeners = new Set<() => void>();

function setConnection(kind: Connection["kind"]): void {
  if (connection.kind === kind) return;
  // `attempt` bumps so screens can remount and refetch on recovery/retry.
  connection = { kind, attempt: connection.attempt + 1 };
  for (const listener of listeners) listener();
}

const subscribeConnection = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getConnection = (): Connection => connection;

export const retryConnection = (): void => setConnection("ok");

type RequestOptions = {
  /**
   * Local-project and filesystem endpoints succeed without a TAPD session.
   * Promoting those successes to the global connection would drop the
   * not_logged_in gate while the TAPD list still fails, remounting the page in
   * a loop. Only TAPD-backed calls (or the heartbeat) recover the connection.
   */
  trackConnection?: boolean;
};

async function request<T>(
  path: string,
  init?: RequestInit,
  options: RequestOptions = {},
): Promise<T> {
  const token = getSession();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    setConnection("offline");
    throw new ApiError("offline", t("mobile.desktop.offline"));
  }

  let envelope: { ok: true; data: T } | { ok: false; code: string; error: string } | null =
    null;
  try {
    envelope = await response.json();
  } catch {
    // Non-JSON body means the server is not our companion API.
  }
  if (!envelope) {
    setConnection("offline");
    throw new ApiError("offline", t("mobile.api.badResponse"));
  }

  if (!envelope.ok) {
    if (envelope.code === "unauthorized") {
      clearSession();
      // A scan URL carries its one-time code in the hash. Rewriting it to a
      // bare `#/pair` here would make PairPage ask for a code that is still
      // right there, so leave the URL alone while a code is present.
      const hash = window.location.hash;
      if (!(hash.includes("/pair") && hash.includes("t="))) {
        navigate("#/pair");
      }
      throw new ApiError("unauthorized", t("mobile.api.pairingExpired"));
    }
    if (envelope.code === "not_logged_in") {
      setConnection("not_logged_in");
      throw new ApiError("not_logged_in", t("mobile.desktop.notLoggedIn"));
    }
    throw new ApiError(envelope.code || "error", envelope.error || t("mobile.api.requestFailed"));
  }

  // TAPD-backed successes recover the app automatically (desktop logged back
  // in etc.); local-only calls opt out so they cannot fight the login gate.
  if (options.trackConnection !== false) setConnection("ok");
  return envelope.data;
}

/**
 * Generic feature command (desktop twin of Tauri `feature_command`): the
 * desktop executes it locally and returns the same serde shape its own UI
 * consumes. The typed helpers on `api` wrap it.
 */
export const feature = <T>(name: string, payload: Record<string, unknown> = {}): Promise<T> =>
  request<T>(
    "/companion/api/feature",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, payload }),
    },
    { trackConnection: false },
  );

export const api = {
  state: () => request<CompanionState>("/companion/api/state"),

  /** Project list from the desktop's workspace context (default = most recent). */
  workspaces: () => request<WorkspaceContext>("/companion/api/workspaces"),

  /** One-time pairing code -> long-lived session token. */
  pair: (token: string, name: string, deviceId: string) =>
    request<{ sessionToken: string }>("/companion/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, deviceId }),
    }),

  /** Presence handshake: tells the desktop this device is still connected. */
  heartbeat: () =>
    request<{
      version: string;
      deviceName: string;
      deviceId: string;
      canManage: boolean;
      mediaToken: string;
      now: string;
    }>("/companion/api/heartbeat", { method: "POST" }, { trackConnection: false }),

  /** Manager-only: paired devices and their management permissions. */
  devices: () => request<CompanionDevices>("/companion/api/devices"),

  devicePermission: (deviceId: string, canManage: boolean) =>
    request<void>("/companion/api/devices/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, canManage }),
    }),

  deviceUnpair: (deviceId: string) =>
    request<void>("/companion/api/devices/unpair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    }),

  bugs: (query: BugQuery) =>
    request<BugListPage>("/companion/api/bugs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    }),

  bug: (workspaceId: string, bugId: string) => {
    const params = new URLSearchParams({ workspaceId, bugId });
    return request<BugDetail>(`/companion/api/bug?${params.toString()}`);
  },

  /** Member directory for filter options (server caches 2h; client 30min). */
  members: (workspaceId: string) => {
    const params = new URLSearchParams({ workspaceId });
    return request<WorkspaceMember[]>(`/companion/api/members?${params.toString()}`);
  },

  /* -- Project files (read-only) ----------------------------------------- */

  /** One directory level of the project's configured folder, dirs first. */
  files: (workspaceId: string, path: string) => {
    const params = new URLSearchParams({ workspaceId, path });
    return request<FsListing>(
      `/companion/api/files?${params.toString()}`,
      undefined,
      { trackConnection: false },
    );
  },

  /** File body for text/markdown, or a kind the viewer picks a renderer for. */
  file: (workspaceId: string, path: string) => {
    const params = new URLSearchParams({ workspaceId, path });
    return request<FsContent>(
      `/companion/api/file?${params.toString()}`,
      undefined,
      { trackConnection: false },
    );
  },

  /** Whether the desktop allows phone-side editing (default false). */
  fileWriteEnabled: () =>
    request<{ enabled: boolean }>(
      "/companion/api/file/write",
      undefined,
      { trackConnection: false },
    ),

  /** Manager-only toggle; shared with the desktop companion dialog. */
  setFileWrite: (enabled: boolean) =>
    request<{ enabled: boolean }>("/companion/api/file/write-setting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),

  /** Overwrites one text file; `mtimeMs` enables the conflict check. */
  writeFile: (
    workspaceId: string,
    path: string,
    text: string,
    mtimeMs?: number,
    force?: boolean,
  ) =>
    request<FsWriteResult>("/companion/api/file/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, path, text, mtimeMs, force }),
    }),

  /* -- Local projects & work items --------------------------------------- */

  localProjects: () => feature<{ projects: LocalProject[] }>("local_projects_list", {}),

  /** `name` may be omitted: the desktop then derives it from the folder. */
  createLocalProject: (req: { name?: string | null; repoPath: string; rule?: string }) =>
    feature<{ project: LocalProject }>("local_project_create", { ...req }),

  updateLocalProject: (
    id: string,
    patch: { name?: string; repoPath?: string; rule?: string },
  ) => feature<{ project: LocalProject }>("local_project_update", { id, ...patch }),

  deleteLocalProject: (id: string) =>
    feature<{ deleted: boolean }>("local_project_delete", { id }),

  localItems: (projectId: string) =>
    feature<{ items: WorkItem[] }>("local_items_list", { projectId }),

  createLocalItem: (req: { projectId: string; title: string; description?: string | null }) =>
    feature<{ item: WorkItem }>("local_item_create", { ...req }),

  /** An empty `description` clears it; omitting the field leaves it alone. */
  updateLocalItem: (
    id: string,
    patch: { title?: string; description?: string; status?: WorkItemStatus },
  ) => feature<{ item: WorkItem }>("local_item_update", { id, ...patch }),

  deleteLocalItem: (id: string) =>
    feature<{ deleted: boolean }>("local_item_delete", { id }),

  /** One directory level under $HOME (or a configured local project). */
  browseDirs: (path?: string | null) =>
    feature<DirListing>("local_browse_dirs", { path: path ?? null }),

  /* -- Bug write actions (user-initiated only) ---------------------------- */

  bugAddComment: (workspaceId: string, bugId: string, comment: string) =>
    request<void>("/companion/api/bug/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId, comment }),
    }),

  bugUpdateField: (workspaceId: string, bugId: string, field: string, value: string, claim = false) =>
    request<void>("/companion/api/bug/update-field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId, field, value, claim }),
    }),

  bugTransitions: (workspaceId: string, bugId: string) => {
    const params = new URLSearchParams({ workspaceId, bugId });
    return request<BugTransitionInfo>(`/companion/api/bug/transitions?${params.toString()}`);
  },

  bugTransition: (workspaceId: string, bugId: string, status: string) =>
    request<BugTransitionResult>("/companion/api/bug/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId, status }),
    }),

  /** 认领：桌面侧取 me 改派处理人并接受。 */
  bugClaim: (workspaceId: string, bugId: string) =>
    request<void>("/companion/api/bug/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId }),
    }),

  notifications: () => request<CompanionNotification[]>("/companion/api/notifications"),

  feature,

  /* -- Agent / notification / coworker settings --------------------------- */

  agentSettings: async (): Promise<AgentSettings> => {
    const data = await feature<unknown>("settings_agent_get", {});
    const inner = (data as { config?: AgentSettings } | null)?.config;
    return inner ?? (data as AgentSettings);
  },

  agentSettingsSet: async (
    patch: Partial<AgentSettings>,
  ): Promise<AgentSettings> => {
    const data = await feature<unknown>("settings_agent_set", { ...patch });
    const inner = (data as { config?: AgentSettings } | null)?.config;
    return inner ?? (data as AgentSettings);
  },

  notificationSettings: () =>
    feature<{ settings: NotificationSettings }>("notification_settings_get", {}),

  notificationSettingsSet: (patch: Partial<NotificationSettings>) =>
    feature<{ settings: NotificationSettings }>("notification_settings_set", { ...patch }),

  coworkerList: () => feature<CoworkerList>("coworker_list", {}),

  coworkerSelect: (ids: string[]) =>
    feature<{ selectedIds: string[] }>("coworker_select", { ids }),
};

/**
 * Same-origin streaming URL for `<img>` / `<audio>` / `<video>` / raw links.
 * Those elements cannot set headers, so the session token rides in `t`, the
 * same scheme `mediaUrl` (lib/rich.ts) uses for rich-text media.
 */
export const fileRawUrl = (workspaceId: string, path: string): string => {
  const params = new URLSearchParams({
    t: getMediaToken() ?? "",
    workspaceId,
    path,
  });
  return `/companion/api/file/raw?${params.toString()}`;
};

/** Reactive connection state for full-screen gates. */
export function useConnection(): Connection {
  return useSyncExternalStore(subscribeConnection, getConnection, getConnection);
}
