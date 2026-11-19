/**
 * Host capability for the shared chat view: Markdown rendering of assistant
 * answers. Pipeline: `marked` (GFM) → highlight.js over the fenced blocks →
 * `sanitizeRichHtml` (DOMPurify; `<img>` rides the same-origin media proxy,
 * links open in a new tab) → one HTML node for `host.renderMarkdown`.
 *
 * Compared with the desktop renderer this is the light path: no
 * `@uiw/react-md-editor` and no rehype stack — `marked` is a single small
 * parser, and the sanitizer the companion already trusts does the security
 * work. Single newlines stay soft breaks (strict GFM), matching the desktop
 * pipeline.
 */
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import type { ReactNode } from "react";

import type { AgentHost } from "../../../../shared/agent/host";
import { sanitizeRichHtml } from "../../lib/rich";

marked.use({ gfm: true, breaks: false });

/** Beyond this many characters one fence is left unhighlighted. */
const MAX_HIGHLIGHT_CHARS = 100_000;
/** highlightAuto is slow and guessy; only run it on small blocks. */
const MAX_AUTODETECT_CHARS = 5_000;

/**
 * Highlights `pre > code` blocks in place. The fence language (`language-x`)
 * wins when the common bundle knows it; small unknown-language blocks fall
 * back to auto-detection. highlight.js escapes the source, and DOMPurify
 * runs after this pass, so the injected spans stay inside the sanitizer.
 */
function highlightFences(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("pre > code").forEach((code) => {
    const source = code.textContent ?? "";
    if (source.length === 0 || source.length > MAX_HIGHLIGHT_CHARS) return;
    const language = [...code.classList]
      .find((cls) => cls.startsWith("language-"))
      ?.slice("language-".length);
    try {
      if (language && hljs.getLanguage(language)) {
        code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
      } else if (source.length <= MAX_AUTODETECT_CHARS) {
        code.innerHTML = hljs.highlightAuto(source).value;
      }
    } catch {
      // Leave the fence plain; highlight.js rejected the input.
    }
  });
  return doc.body.innerHTML;
}

/**
 * One bounded cache: transcript polls re-render every answer every few
 * seconds, and unchanged answers must not re-parse. Keyed by the exact
 * source; evicted wholesale when over the cap (answers are small, the cap
 * keeps the map from growing without bound across a long session).
 */
const CACHE_LIMIT = 200;
const cache = new Map<string, ReactNode>();

export function renderMarkdown(source: string): ReactNode {
  const cached = cache.get(source);
  if (cached) return cached;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const html = sanitizeRichHtml(highlightFences(marked.parse(source, { async: false })));
  const node = <div className="answer-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
  cache.set(source, node);
  return node;
}

/**
 * The capabilities object for `AgentHostProvider`; module-level so the
 * provider's value identity is stable across transcript polls. The phone
 * cannot read desktop-local image paths, so `loadImage` stays unimplemented
 * (the shared view degrades to no image previews).
 */
export const agentHostCapabilities: AgentHost = { renderMarkdown };
