import { invoke } from "@tauri-apps/api/core";

import { exportDirFor, type AgentTask } from "./agent";
import type { ToastFn } from "./feature";

/**
 * Copies text with the async clipboard API and falls back to a hidden
 * textarea + `execCommand("copy")` when the webview denies/does not expose it.
 * Returns false instead of throwing so each caller keeps its own toast copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission denied or API unavailable: use the legacy path.
  }

  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Opens the folder that holds a task's exported bug.json, if it has one. */
export const openTaskExportDir = (task: AgentTask, toast: ToastFn): void => {
  const dir = exportDirFor(task.jsonPath);
  if (!dir) {
    toast("error", "该任务还没有导出目录");
    return;
  }
  void invoke("open_path", { path: dir }).catch((error) =>
    toast("error", String(error)),
  );
};
