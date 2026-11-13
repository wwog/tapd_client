/**
 * File-type knowledge for the explorer tree and the code viewer: which icon a
 * row gets, and which Monaco language highlights it.
 *
 * Only the languages the product lists are mapped; an unknown extension opens
 * as plain text instead of guessing.
 */
import { extension } from "../../lib/fs";

/** Extension -> Monaco language id. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
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
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  r: "r",
  pl: "perl",
  scala: "scala",
  dart: "dart",
  tf: "hcl",
  hcl: "hcl",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  dockerfile: "dockerfile",
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

/** Monaco language id for a path; always returns a valid id. */
export function monacoLanguageFor(path: string): string {
  const name = path.split("/").pop() ?? path;
  const ext = extension(path);
  if (!ext) {
    if (name === "Dockerfile" || name === "Containerfile") return "dockerfile";
    return "plaintext";
  }
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

/** Language for the "is this code?" icon decision; null = plain text. */
export function languageForPath(path: string): string | null {
  const language = monacoLanguageFor(path);
  return language === "plaintext" ? null : language;
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
