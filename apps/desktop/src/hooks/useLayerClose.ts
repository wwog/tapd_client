import { useCallback, useEffect, useRef, useState } from "react";

/** Keep in sync with the `.context-menu-out` / `.modal-*-out` durations. */
export const LAYER_OUT_MS = 110;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Two-phase close for popovers, menus and dialogs: mark the layer `closing`
 * first so CSS can play the exit animation, then run the real close — which
 * unmounts the layer — after the animation. The layer renders
 * `closing && "…-out"` for itself.
 *
 * `requestClose` accepts an optional replacement action, for flows where the
 * confirming button does something else than plain cancel (e.g. pick a folder).
 * Repeated calls while closing are ignored, so Escape + click cannot double-run
 * the action.
 */
export function useLayerClose(
  close: () => void,
  duration = LAYER_OUT_MS,
): {
  closing: boolean;
  requestClose: (run?: () => void) => void;
  /** Call when the layer reopens without unmounting (e.g. an `open` prop). */
  reset: () => void;
} {
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const timerRef = useRef<number | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const requestClose = useCallback(
    (run?: () => void) => {
      if (timerRef.current !== null) return;
      if (prefersReducedMotion() || duration <= 0) {
        (run ?? closeRef.current)();
        return;
      }
      setClosing(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        (run ?? closeRef.current)();
      }, duration);
    },
    [duration],
  );

  const reset = useCallback(() => {
    cancelTimer();
    setClosing(false);
  }, [cancelTimer]);

  useEffect(
    () => () => {
      cancelTimer();
    },
    [cancelTimer],
  );

  return { closing, requestClose, reset };
}
