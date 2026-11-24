/**
 * Read-only filesystem bridge for the Explorer and file viewer.
 *
 * The backend resolves every request inside the project's configured folder
 * (`agent.json` → `projects[workspaceId].repoPath`) and rejects anything that
 * escapes it. Paths crossing this boundary are always relative, `/`-separated.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Workspace id prefix that scopes a file panel to one agent session's working
 * directory (`__session__:<sessionId>`). Mirrors `fs.rs`, which resolves the
 * root and keeps the same containment checks.
 */
export const SESSION_WORKSPACE_PREFIX = "__session__:";

/** Workspace id for whole-disk reads (`fs.rs` keeps its credential deny list). */
export const ROOT_WORKSPACE_ID = "__root__";

/** Where a local path from an assistant reply should open. */
export type FileTabTarget = {
  workspaceId: string;
  /** Relative to the workspace root, `/`-separated. */
  path: string;
  /** Tab label; the panel falls back to the file name. */
  label?: string;
  /**
   * Opened from a task review: the tab shows the file against the task
   * baseline (Monaco's inline diff) instead of a plain, editable buffer.
   * `file` is the task-relative path the sides are read for.
   */
  review?: { sessionId: string; file: string };
};

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
  /** The read stopped at the server's text limit. */
  truncated: boolean;
};

export type FsStat = {
  path: string;
  kind: FsEntryKind;
  size: number;
  mtime: number;
  mtimeMs: number;
};

export type FsRequest = { workspaceId: string; path: string };

/** Result of a save; the editor stores `mtimeMs` for the next conflict check. */
export type FsWriteResult = {
  path: string;
  size: number;
  mtime: number;
  mtimeMs: number;
};

export type FsWriteRequest = FsRequest & {
  text: string;
  /** The millisecond mtime the editor loaded; omit to write unconditionally. */
  mtimeMs?: number;
  /** Skip the conflict check (explicit overwrite). */
  force?: boolean;
};

export const fsApi = {
  /** One directory level, dirs first. */
  list: (request: FsRequest) => invoke<FsListing>("fs_list", request),
  /** Text body or a content kind the viewer can pick a renderer for. */
  read: (request: FsRequest) => invoke<FsContent>("fs_read", request),
  stat: (request: FsRequest) => invoke<FsStat>("fs_stat", request),
  /** Overwrites an existing text file atomically (no new files). */
  write: (request: FsWriteRequest) => invoke<FsWriteResult>("fs_write", request),
};

/** Media tokens are shared with the loopback media proxy. */
let fileBase: string | null = null;

const buildFileBase = (port: number, token: string): string =>
  `http://127.0.0.1:${port}/file?token=${encodeURIComponent(token)}`;

/** Late fallback for the first paint: the loopback server may still be starting. */
export const ensureFileEndpoint = async (): Promise<void> => {
  if (fileBase) return;
  try {
    const endpoint = await invoke<{ port: number; token: string }>("media_endpoint");
    fileBase = buildFileBase(endpoint.port, endpoint.token);
  } catch {
    // Retried by the next viewer mount.
  }
};

/**
 * Streaming URL for `<img>` / `<video>` / `<audio>` / `<embed>`.
 * Undefined until the endpoint is known, mirroring `mediaSrc`.
 */
export const fileSrc = (
  workspaceId: string,
  path: string,
): string | undefined =>
  fileBase
    ? `${fileBase}&ws=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
    : undefined;

/** Directory part of a relative path ("" at the root). */
export const dirname = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

/** Last path segment. */
export const basename = (path: string): string => path.split("/").pop() || path;

/** Lowercase extension without the dot ("" when there is none). */
export const extension = (path: string): string => {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
};
