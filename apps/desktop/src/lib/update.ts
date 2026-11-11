import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { createExternalStore } from "./store";
import { formatDateTime } from "./format";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export type AvailableUpdate = {
  version: string;
  notes: string;
  date: string | null;
};

export type UpdateProgress = {
  received: number;
  total: number | null;
  percent: number | null;
};

export type UpdateState = {
  phase: UpdatePhase;
  currentVersion: string;
  checkedAt: string | null;
  available: AvailableUpdate | null;
  progress: UpdateProgress | null;
  error: string | null;
  manualUrl: string;
};

/**
 * Phases where the update owns the screen: the main window is hidden and the
 * island capsule shows the 4x progress/error panel.
 */
export const updateOwnsScreen = (phase: UpdatePhase | undefined): boolean =>
  phase === "downloading" ||
  phase === "installing" ||
  phase === "ready" ||
  phase === "error";

export const UPDATE_PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: "已是最新版本",
  checking: "正在检查更新",
  available: "有可用更新",
  downloading: "正在下载更新",
  installing: "正在解包安装",
  ready: "更新完成，正在重启",
  error: "更新失败",
};

const store = createExternalStore<UpdateState | null>(null);
let started = false;

const publish = (next: UpdateState): void => store.set(next);

/** Idempotently loads the current state and subscribes to pushed changes. */
export const startUpdateStore = (): void => {
  if (started) return;
  started = true;

  void invoke<UpdateState>("update_state")
    .then(publish)
    .catch(() => undefined);

  void listen<UpdateState>("update://state", (event) => {
    if (event.payload) publish(event.payload);
  }).then((unlisten: UnlistenFn) => {
    // The window lives for the whole app lifetime; nothing to clean up.
    void unlisten;
  });
};

export const getUpdateSnapshot = store.get;

export const subscribeUpdate = store.subscribe;

export const updateApi = {
  /** Manual check; resolves to the new state (throws with the error message). */
  check: async (): Promise<UpdateState> => {
    const next = await invoke<UpdateState>("update_check");
    publish(next);
    return next;
  },
  install: async (): Promise<UpdateState> => {
    const next = await invoke<UpdateState>("update_install");
    publish(next);
    return next;
  },
  cancel: async (): Promise<UpdateState> => {
    const next = await invoke<UpdateState>("update_cancel");
    publish(next);
    return next;
  },
  /** Opens the GitHub release page for a manual download. */
  openManual: () => invoke<void>("update_open_manual"),
};

/** "2026-11-10T16:00:00+08:00" -> "2026-11-10 16:00". */
export const formatCheckTime = (iso: string | null): string =>
  iso ? formatDateTime(iso) : "尚未检查";
