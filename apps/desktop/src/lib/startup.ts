import { invoke } from "@tauri-apps/api/core";

import { canvasRgba, getAppearance, resolvedTheme } from "./appearance";

/**
 * Reveals the main window once its first themed frame is painted.
 *
 * The window is created hidden, so the user never sees the white webview that
 * exists before CSS and React land. Rust shows it when this call arrives
 * (`window_state::ui_ready`) and paints the native background with the same
 * canvas colour first. Two frames separate the React commit from the paint;
 * macOS throttles `requestAnimationFrame` while a window is hidden, so a timer
 * releases it even when that signal never arrives.
 */
export function revealWhenPainted(): () => void {
  let done = false;
  let frame = 0;

  const reveal = () => {
    if (done) return;
    done = true;
    const background = canvasRgba(resolvedTheme(getAppearance()));
    void invoke("ui_ready", { background }).catch(() => undefined);
  };

  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(reveal);
  });
  const timer = window.setTimeout(reveal, 600);

  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
