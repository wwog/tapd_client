import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { featureCommand } from "./feature";

export type NotificationKind = "new" | "transferred" | "reopened" | "ai";
export type NotificationItemState = "pending" | "handled" | "viewed" | "ignored";
export type NotificationScope = "mine" | "project";
export type NotificationSource = "tapd" | "ai";

export type AiTone = "info" | "success" | "warning" | "error" | "progress";
export type AiActionStyle = "primary" | "secondary" | "danger";

export type AiField = {
  label: string;
  value: string;
};

/** Extensible content blocks rendered by the island card. */
export type AiBlock =
  | { type: "text"; text: string }
  | { type: "code"; text: string; language?: string }
  | { type: "fields"; fields: AiField[] }
  | { type: "progress"; percent?: number; label?: string }
  | { type: "divider" };

export type AiAction = {
  id: string;
  label: string;
  style?: AiActionStyle;
};

export type AiResolution = {
  kind: "action" | "dismissed" | "replaced" | string;
  actionId?: string;
  actionLabel?: string;
  at: string;
};

/** Generic payload raised by an MCP client / external AI. */
export type AiPayload = {
  tone: AiTone;
  client: string;
  blocks: AiBlock[];
  actions: AiAction[];
  tag?: string | null;
  resolution?: AiResolution | null;
};

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export type NotificationSettings = {
  enabled: boolean;
  scope: NotificationScope;
  includeNew: boolean;
  includeTransferred: boolean;
  includeReopened: boolean;
  pollIntervalSecs: number;
  quietHours: QuietHours;
  maxVisible: number;
  /** Allows MCP clients / external AI to raise capsule notifications. */
  aiEnabled: boolean;
};

export type NotificationItem = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  bugId: string;
  title: string;
  kind: NotificationKind;
  owner: string;
  creator: string;
  severity: string;
  priority: string;
  created: string;
  detectedAt: string;
  state: NotificationItemState;
  source?: NotificationSource;
  /** Present only for AI / MCP notifications. */
  ai?: AiPayload | null;
};

export type NotificationStateSnapshot = {
  items: NotificationItem[];
  settings: NotificationSettings;
  running: boolean;
  lastPollAt: string | null;
  lastError: string | null;
};

export type IslandLayout = {
  expanded: boolean;
  width: number;
  height: number;
  count: number;
};

export type NotificationHandleResult = {
  ok: boolean;
  owner: string;
  status: string;
  assigned: boolean;
  transitioned: boolean;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  scope: "mine",
  includeNew: true,
  includeTransferred: true,
  includeReopened: true,
  pollIntervalSecs: 30,
  quietHours: { enabled: false, start: "22:00", end: "09:00" },
  maxVisible: 3,
  aiEnabled: true,
};

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  new: "新缺陷",
  transferred: "转派给我",
  reopened: "重新打开",
  ai: "AI 通知",
};

export const AI_TONE_LABELS: Record<AiTone, string> = {
  info: "提示",
  success: "成功",
  warning: "警告",
  error: "失败",
  progress: "进行中",
};

export const notificationApi = {
  settingsGet: () =>
    featureCommand<{ settings: NotificationSettings }>("notification_settings_get"),
  settingsSet: (settings: Partial<NotificationSettings>) =>
    featureCommand<{ settings: NotificationSettings }>("notification_settings_set", settings),
  state: () => featureCommand<NotificationStateSnapshot>("notification_state_get"),
  handle: (notificationId: string) =>
    featureCommand<NotificationHandleResult>("notification_handle", { notificationId }),
  view: (notificationId: string) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_view", {
      notificationId,
    }),
  ignore: (notificationId: string) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_ignore", {
      notificationId,
    }),
  simulate: (payload: { title?: string; bugId?: string; kind?: NotificationKind } = {}) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_simulate", payload),
  /** Reports the user's choice on an AI card back to the waiting MCP call. */
  aiAction: (notificationId: string, actionId: string) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_ai_action", {
      notificationId,
      actionId,
    }),
  /** Raises a card from the settings debug panel (works even when AI is off). */
  aiDebug: (payload: {
    title: string;
    tone?: AiTone;
    body?: string;
    fields?: AiField[];
    blocks?: AiBlock[];
    actions?: AiAction[];
    tag?: string;
  }) => featureCommand<{ ok: boolean; item: NotificationItem }>("notification_ai_debug", payload),
  /** Expands the island into cards (or collapses it back to the capsule).
   *  `extra` counts live cards fed by other stores (external AI claims). */
  expandIsland: (expanded: boolean, extra = 0) =>
    featureCommand<{ ok: boolean; expanded: boolean; count: number }>(
      "notification_island_expand",
      { expanded, extra },
    ),
  /** Shows/hides the collapsed capsule. The idle capsule is not a permanent
   *  indicator, so the frontend hides it once nothing needs attention. */
  setIslandVisible: (visible: boolean) =>
    featureCommand<{ ok: boolean; visible: boolean }>("notification_island_visible", {
      visible,
    }),
  /** Grows the collapsed capsule into the Agent summary card while hovered. */
  setPeek: (active: boolean) =>
    featureCommand<{ ok: boolean; active: boolean }>("notification_island_peek", { active }),
  openMain: () => featureCommand<{ ok: boolean }>("notification_open_main"),
  /** Focus the main window and open one bug's detail (查看缺陷). */
  openBug: (workspaceId: string, bugId: string) =>
    featureCommand<{ ok: boolean }>("notification_open_bug", { workspaceId, bugId }),
  /** Starts an OS window drag; the Rust side persists the final position. */
  startDrag: () => featureCommand<{ ok: boolean }>("notification_start_drag"),
};

/** Subscribes to the pending list pushed by the Rust window manager. */
export const onNotificationShow = (
  callback: (payload: { items: NotificationItem[]; quiet: boolean }) => void,
): Promise<UnlistenFn> =>
  listen<{ items: NotificationItem[]; quiet?: boolean }>(
    "notification://show",
    (event) => {
      callback({
        items: event.payload?.items ?? [],
        quiet: Boolean(event.payload?.quiet),
      });
    },
  );

/** The island reports its own window size so the content can match it. */
export const onIslandLayout = (
  callback: (layout: IslandLayout) => void,
): Promise<UnlistenFn> =>
  listen<IslandLayout>("island://layout", (event) => callback(event.payload));

/**
 * Pointer enter/exit of the capsule, tracked by AppKit: the window never
 * becomes the key window, and WebKit only reports hover to that one.
 */
export const onIslandHover = (
  callback: (active: boolean) => void,
): Promise<UnlistenFn> =>
  listen<{ active: boolean }>("island://hover", (event) =>
    callback(Boolean(event.payload?.active)),
  );

export const pendingItems = (items: NotificationItem[]): NotificationItem[] =>
  items.filter((item) => item.state === "pending");

/** "2026-11-10 09:30:00" -> "11-10 09:30". */
export const formatNotificationTime = (raw: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) return raw;
  const [, , month, day, hour, minute] = match;
  return `${month}-${day} ${hour}:${minute}`;
};

export const formatPollTime = (iso: string | null): string => {
  if (!iso) return "尚未轮询";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};
