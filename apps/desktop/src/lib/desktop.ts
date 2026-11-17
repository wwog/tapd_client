import { invoke } from "@tauri-apps/api/core";

/**
 * Opens http(s) links in the default browser. Rendered Markdown uses this so a
 * click cannot navigate the app's own WebView (which carries Tauri IPC) away
 * from the UI. Best effort: a rejected open is reported nowhere.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await invoke("open_url", { url });
  } catch {
    // A link the host refuses (non-http scheme) needs no UI of its own.
  }
}

/**
 * Copies text with the async clipboard API and falls back to a hidden
 * textarea + `execCommand("copy")` when the webview denies/does not expose it.
 * Returns false instead of throwing so each caller keeps its own toast copy.
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
