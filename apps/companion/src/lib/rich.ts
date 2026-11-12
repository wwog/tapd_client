import DOMPurify from "dompurify";

import { getSession } from "./session";

/**
 * Rich-text (description / comment) rendering: TAPD HTML is sanitized once
 * here, and every `<img>` goes through the same-origin media proxy because
 * TAPD hosts images behind the desktop session.
 */

/** Same-origin proxy URL for a TAPD media resource. `<img>` cannot set
 * headers, so the session token travels in a `t` query parameter. */
export const mediaUrl = (src: string): string =>
  `/companion/api/media?url=${encodeURIComponent(src)}&t=${encodeURIComponent(getSession() ?? "")}`;

// Registered once; runs for every sanitize call below.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "IMG") {
    const img = node as HTMLImageElement;
    const src = img.getAttribute("src");
    if (src && !src.startsWith("data:")) {
      img.setAttribute("src", mediaUrl(src));
    }
  }
  if (node.nodeName === "A") {
    // Keep taps inside the SPA; open the target in a new tab instead.
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Strips scripts/styles/events; media and links keep the treatment above. */
export function sanitizeRichHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["video", "audio", "source", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style"],
  });
}
