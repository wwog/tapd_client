/**
 * File-type knowledge for the explorer tree and the code viewer: which icon a
 * row gets, and which refractor (Prism) grammar highlights it.
 *
 * Only the grammars the product lists in the file panel are registered; an
 * unknown extension renders plain monospace instead of guessing.
 */
import { refractor } from "refractor";
import jsx from "refractor/jsx";
import toml from "refractor/toml";
import tsx from "refractor/tsx";

import { extension } from "../../lib/fs";

/** Extension -> refractor language name. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  dockerfile: "docker",
};

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "ini",
  "cfg",
  "conf",
  "env",
  "gitignore",
  "lock",
]);

/** Prism grammars that are not part of refractor's common bundle. */
let registered = false;
function registerExtraLanguages(): void {
  if (registered) return;
  registered = true;
  // Order matters: tsx builds on jsx + typescript.
  refractor.register(jsx);
  refractor.register(tsx);
  refractor.register(toml);
}

/** Refractor language for a path, or null when the file stays plain text. */
export function languageForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  // Dotfiles like `.gitignore` have no extension but benefit from plain text.
  const ext = extension(path);
  if (!ext) return name === "Dockerfile" ? "docker" : null;
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

export type FileVisualKind =
  | "code"
  | "markdown"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "file";

/** Icon category for a tree row / file header. */
export function visualKindForPath(path: string): FileVisualKind {
  const ext = extension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (TEXT_EXTENSIONS.has(ext) || ext === "") return "text";
  return languageForPath(path) ? "code" : "file";
}

export type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * Highlights one body with Prism. Big bodies skip highlighting: a 2 MB file
 * would otherwise block the renderer for seconds. `null` means plain text.
 */
export function highlightCode(code: string, path: string): HastNode | null {
  const language = languageForPath(path);
  if (!language || code.length > 300_000) return null;
  try {
    registerExtraLanguages();
    return refractor.highlight(code, language) as unknown as HastNode;
  } catch {
    return null;
  }
}
