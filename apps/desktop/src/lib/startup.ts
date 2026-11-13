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
  return whenPainted(() => {
    const background = canvasRgba(resolvedTheme(getAppearance()));
    void invoke("ui_ready", { background }).catch(() => undefined);
  });
}

/**
 * Reveals the capsule window once its first transparent frame is painted.
 *
 * The island window is created hidden for the same reason as the main one: an
 * unpainted webview is white, and the capsule is the first thing on screen at
 * launch, so it must never be shown before its own frame exists.
 */
export function revealIslandWhenPainted(): () => void {
  return whenPainted(() => {
    void invoke("island_ready").catch(() => undefined);
  });
}

/** Runs `reveal` after two frames (the paint that follows the React commit). */
function whenPainted(reveal: () => void): () => void {
  let done = false;
  let frame = 0;

  const fire = () => {
    if (done) return;
    done = true;
    reveal();
  };

  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(fire);
  });
  const timer = window.setTimeout(fire, 600);

  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
