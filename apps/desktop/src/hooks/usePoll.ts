import { useEffect, useRef } from "react";

export type PollOptions = {
  /**
   * Stop the timer while the document is hidden and resume it when visible.
   * Use for background refreshes that would otherwise hit Tauri/IPC while the
   * window is minimized or in another tab.
   */
  pauseWhenHidden?: boolean;
};

/**
 * Runs `fn` on an interval without firing immediately (callers keep their
 * initial load separate). The callback is read through a ref, so an inline
 * `load` does not reset the timer on every render.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  ms: number,
  options: PollOptions = {},
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const { pauseWhenHidden = false } = options;

  useEffect(() => {
    if (ms <= 0) return;

    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      if (pauseWhenHidden && document.hidden) return;
      timer = window.setInterval(() => void fnRef.current(), ms);
    };

    start();
    if (pauseWhenHidden) {
      document.addEventListener("visibilitychange", start);
    }

    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [ms, pauseWhenHidden]);
}
