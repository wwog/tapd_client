/**
 * Local paths in assistant replies become workbench file tabs.
 *
 * Resolution lives in the backend (`dsh_file_target`) because the base depends
 * on the session: free chats work in their own scratch dir, tasks in a worktree
 * or in the repository. Both helpers share that one call; an image then rides
 * the loopback `/file` route, so the WebView can stream and cache it.
 */
import { dshFileApi } from "../lib/dsh";
import {
  ensureFileEndpoint,
  fileSrc,
  SESSION_WORKSPACE_PREFIX,
  type FileTabTarget,
} from "../lib/fs";
import { t } from "../lib/i18n";

type Notify = (kind: "ok" | "error", text: string) => void;

export async function openAgentPath(
  sessionId: string,
  path: string,
  io: { toast: Notify; openFile: (target: FileTabTarget) => void },
): Promise<void> {
  try {
    const target = await dshFileApi.target(sessionId, path);
    if (target.kind === "dir") {
      io.toast("error", t("agent.file.isDir"));
      return;
    }
    if (target.kind !== "file") {
      io.toast("error", t("agent.file.missing", { path }));
      return;
    }
    io.openFile({
      workspaceId: target.workspaceId,
      path: target.path,
      label: target.label,
    });
  } catch (error) {
    io.toast("error", t("agent.file.openFailed", { error: String(error) }));
  }
}

/**
 * A changed file from the transcript's change card opens as a diff against the
 * task's baseline (Monaco's inline diff), which is the same view the review
 * pane's 「应用内查看」 gives.
 *
 * The sides command reads task-relative paths, so only files that resolve
 * inside the session's own directory can be diffed; a path that lands in the
 * surrounding project is opened as a plain file instead of showing a wrong diff.
 */
export async function openAgentDiff(
  sessionId: string,
  path: string,
  io: { toast: Notify; openFile: (target: FileTabTarget) => void },
): Promise<void> {
  try {
    const target = await dshFileApi.target(sessionId, path);
    if (target.kind === "dir") {
      io.toast("error", t("agent.file.isDir"));
      return;
    }
    if (target.kind !== "file") {
      io.toast("error", t("agent.file.missing", { path }));
      return;
    }
    const insideSession = target.workspaceId === `${SESSION_WORKSPACE_PREFIX}${sessionId}`;
    io.openFile({
      workspaceId: target.workspaceId,
      path: target.path,
      label: target.label,
      ...(insideSession ? { review: { sessionId, file: target.path } } : {}),
    });
  } catch (error) {
    io.toast("error", t("agent.file.openFailed", { error: String(error) }));
  }
}

/**
 * One resolution per session + path: the transcript re-renders on every stream
 * frame and must not ask the backend for the same picture again. Evicted
 * wholesale at the cap, like the other bounded caches.
 */
const imageCache = new Map<string, Promise<string | null>>();
const IMAGE_CACHE_LIMIT = 100;

export function resolveAgentImage(
  sessionId: string,
  path: string,
): Promise<string | null> {
  const key = `${sessionId}\u0000${path}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.clear();
  const resolved = (async () => {
    try {
      const target = await dshFileApi.target(sessionId, path);
      if (target.kind !== "file") return null;
      await ensureFileEndpoint();
      return fileSrc(target.workspaceId, target.path) ?? null;
    } catch {
      return null;
    }
  })();
  imageCache.set(key, resolved);
  return resolved;
}
