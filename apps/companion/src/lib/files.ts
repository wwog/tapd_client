/**
 * Pure helpers for the read-only project file browser: relative-path
 * arithmetic, hash builders, display sizes and the icon category a listing
 * row uses before the server has classified the file body.
 */
import type { FsEntry } from "./api";

/** Relative paths cross the companion boundary `/`-separated, no leading slash. */
export const normalizePath = (path: string): string =>
  path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");

export const pathSegments = (path: string): string[] => {
  const normalized = normalizePath(path);
  return normalized ? normalized.split("/") : [];
};

/** Last path segment (the file name). */
export const basename = (path: string): string => path.split("/").pop() || path;

/** Directory part of a relative path ("" at the project root). */
export const dirname = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

const queryOf = (params: Record<string, string>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/** `#/files?ws=<id>&path=<relative>`; empty values are omitted. */
export const filesHash = (workspaceId: string | null, path: string): string =>
  `#/files${queryOf({ ws: workspaceId ?? "", path: normalizePath(path) })}`;

/** `#/file?ws=<id>&path=<relative>`; the path is required by the route. */
export const fileHash = (workspaceId: string | null, path: string): string =>
  `#/file${queryOf({ ws: workspaceId ?? "", path: normalizePath(path) })}`;

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human byte size; one decimal below 100, none at or above. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Rust prefixes the error when the project has no local folder configured. */
export const NO_FOLDER_PREFIX = "no_folder:";

export const isNoFolderError = (message: string): boolean =>
  message.trimStart().startsWith(NO_FOLDER_PREFIX);

export type FileVisualKind =
  | "dir"
  | "image"
  | "audio"
  | "video"
  | "markdown"
  | "text"
  | "file";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "weba",
]);

const VIDEO_EXTENSIONS = new Set([
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "ogv",
  "webm",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

const TEXT_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cts",
  "cxx",
  "diff",
  "env",
  "fish",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "lua",
  "mjs",
  "mts",
  "patch",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "srt",
  "text",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vtt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

/** Lowercase extension without the dot ("" when there is none). */
const extension = (name: string): string => {
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
};

const TEXT_BASENAMES = new Set([
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

/** Icon category for a listing row; symlinks follow their name's extension. */
export function visualKind(entry: FsEntry): FileVisualKind {
  if (entry.kind === "dir") return "dir";
  const ext = extension(entry.name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(entry.name.toLowerCase())) {
    return "text";
  }
  return "file";
}
