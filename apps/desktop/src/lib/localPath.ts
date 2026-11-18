/**
 * Shape checks for paths written in Markdown.
 *
 * The desktop renders agent replies through `components/Markdown`, where a
 * local path has to be told apart from a URL before the click handler can ask
 * the backend for a file target. These helpers stay pure: the renderer has no
 * IPC dependency of its own, and the backend still decides what the path
 * resolves to.
 */

/** Extensions that make a bare name worth treating as a file path. */
const FILE_EXTENSION =
  /\.(?:md|markdown|mdx|txt|log|json|jsonc|ya?ml|toml|ini|conf|csv|tsv|xml|html?|css|scss|less|js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|kts|swift|m|mm|h|hpp|c|cc|cpp|cs|php|sh|bash|zsh|fish|sql|proto|graphql|gql|lock|env|png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|mp4|mov|webm|m4v|mp3|wav|m4a|aac|flac|pdf|zip|tar|gz)$/i;

const EXTERNAL = /^(?:https?|mailto|tel|data|javascript):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A link destination that names something on this machine (relative paths,
 * absolute paths, `~/…` or `file://`). Anchors and real URLs are left to the
 * browser.
 */
export function localPathFromHref(href?: string | null): string | null {
  const raw = href?.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (EXTERNAL.test(raw)) return null;
  if (SCHEME.test(raw) && !/^file:/i.test(raw)) return null;
  return raw;
}

/**
 * Inline code that reads as a file path. A bare name needs a known extension;
 * a slashed path needs one in its last segment, and explicit `./` / `../` /
 * `~/` / `/` prefixes always pass. Prose, commands, fractions and URLs are
 * left alone (a directory or a missing file only costs a toast, but making
 * every `and/or` clickable would be noise).
 */
export function inlineCodePath(text: string): string | null {
  const raw = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!raw || raw.length > 240) return null;
  if (/\s/.test(raw) || raw.startsWith("#")) return null;
  // A `file:` URL is a path by definition; every other scheme is a URL.
  if (/^file:/i.test(raw)) return raw;
  if (SCHEME.test(raw)) return null;
  const last = raw.slice(raw.lastIndexOf("/") + 1);
  const explicit = /^\.{1,2}\//.test(raw) || raw.startsWith("~/") || raw.startsWith("/");
  if (!explicit && !FILE_EXTENSION.test(last)) return null;
  return raw;
}
