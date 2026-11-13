/**
 * Read-only filesystem bridge for the Explorer and file viewer.
 *
 * The backend resolves every request inside the project's configured folder
 * (`agent.json` → `projects[workspaceId].repoPath`) and rejects anything that
 * escapes it. Paths crossing this boundary are always relative, `/`-separated.
 */
import { invoke } from "@tauri-apps/api/core";

import type { AppInfo } from "./api";

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
};

export type FsRequest = { workspaceId: string; path: string };

export const fsApi = {
  /** One directory level, dirs first. */
  list: (request: FsRequest) => invoke<FsListing>("fs_list", request),
  /** Text body or a content kind the viewer can pick a renderer for. */
  read: (request: FsRequest) => invoke<FsContent>("fs_read", request),
  stat: (request: FsRequest) => invoke<FsStat>("fs_stat", request),
};

/** Media tokens are shared with the loopback media proxy. */
let fileBase: string | null = null;

const buildFileBase = (port: number, token: string): string =>
  `http://127.0.0.1:${port}/file?token=${encodeURIComponent(token)}`;

/** Remembered next to `setMediaEndpoint`; both come from `app_info`. */
export const setFileEndpoint = (
  info: Pick<AppInfo, "mediaPort" | "mediaToken">,
): void => {
  fileBase =
    info.mediaPort && info.mediaToken
      ? buildFileBase(info.mediaPort, info.mediaToken)
      : null;
};

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
