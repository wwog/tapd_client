/**
 * Copies text with the async clipboard API and falls back to a hidden
 * textarea + `execCommand("copy")` when the webview denies or does not expose
 * it. Returns false instead of throwing so callers keep their own UX. Pure
 * DOM, no host bridge — the same approach works in both apps' WebViews.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission denied or API unavailable: use the legacy path.
  }

  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
