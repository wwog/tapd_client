/**
 * Companion data layer: same-origin relative fetches against the desktop's
 * companion server, Bearer session token, `{ ok, data }` envelope.
 *
 * Data shapes are copied verbatim from `apps/desktop/src/lib/api.ts` (the
 * serde contract lives there; the companion renders exactly what the desktop
 * components render).
 */
import { useSyncExternalStore } from "react";

import { navigate } from "./router";
import { clearSession, getSession } from "./session";

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

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError("error", "请求失败");
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new ApiError("offline", "无法连接桌面端");
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
    throw new ApiError("offline", "桌面端响应异常");
  }

  if (!envelope.ok) {
    if (envelope.code === "unauthorized") {
      clearSession();
      navigate("#/pair");
      throw new ApiError("unauthorized", "配对已失效，请重新扫码");
    }
    if (envelope.code === "not_logged_in") {
      setConnection("not_logged_in");
      throw new ApiError("not_logged_in", "桌面端未登录");
    }
    throw new ApiError(envelope.code || "error", envelope.error || "请求失败");
  }

  // Any success recovers the app automatically (desktop logged back in etc.).
  setConnection("ok");
  return envelope.data;
}

export const api = {
  state: () => request<CompanionState>("/companion/api/state"),

  /** Project list from the desktop's workspace context (default = most recent). */
  workspaces: () => request<WorkspaceContext>("/companion/api/workspaces"),

  /** One-time pairing code -> long-lived session token. */
  pair: (token: string, name: string) =>
    request<{ sessionToken: string }>("/companion/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name }),
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

  notifications: () => request<CompanionNotification[]>("/companion/api/notifications"),
};

/** Reactive connection state for full-screen gates. */
export function useConnection(): Connection {
  return useSyncExternalStore(subscribeConnection, getConnection, getConnection);
}
