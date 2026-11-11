import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type DragResizeSession = {
  /** Receives the horizontal delta from mousedown; call `stop` to abort. */
  onMove: (deltaX: number, stop: () => void) => void;
  /** Runs on mouseup after the listeners are detached. */
  onEnd: () => void;
};

/**
 * Shared column-resize drag: prevents the default mousedown, tracks horizontal
 * deltas on `window`, and detaches both listeners on mouseup or abort.
 *
 * `create` runs at mousedown, so it captures the values of the render that
 * started the drag (the original handlers' closure semantics).
 */
export function useDragResize(
  create: () => DragResizeSession,
): (event: ReactMouseEvent<HTMLButtonElement>) => void {
  const createRef = useRef(create);
  createRef.current = create;

  return useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const session = createRef.current();

    let active = true;
    const detach = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    const onMove = (move: MouseEvent) => {
      session.onMove(move.clientX - startX, detach);
    };

    const onUp = () => {
      detach();
      session.onEnd();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
}
