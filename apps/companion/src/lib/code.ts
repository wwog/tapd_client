/**
 * Read-only syntax highlighting for the phone's file preview.
 *
 * The phone does not load Monaco (multi-MB chunk and a desktop editing surface);
 * highlight.js' common bundle covers the languages the product lists at a
 * fraction of the weight. The source is escaped by highlight.js and sanitized
 * again by DOMPurify before it reaches `dangerouslySetInnerHTML`.
 */
import hljs from "highlight.js/lib/common";

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
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",
  h: "c",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  vb: "vbnet",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  lua: "lua",
  r: "r",
  pl: "perl",
  graphql: "graphql",
  gql: "graphql",
};

/** Beyond this many characters the phone skips highlighting. */
const MAX_HIGHLIGHT_CHARS = 200_000;

const extensionOf = (path: string): string => {
  const name = path.split("/").pop() ?? path;
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
};

/** highlight.js language id for a path, or null for plain text. */
export function languageForPath(path: string): string | null {
  const extension = extensionOf(path);
  if (!extension) return null;
  const language = LANGUAGE_BY_EXTENSION[extension] ?? null;
  return language && hljs.getLanguage(language) ? language : null;
}

/** Highlighted HTML, or null when the body should stay plain text. */
export function highlightCode(code: string, path: string): string | null {
  const language = languageForPath(path);
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
