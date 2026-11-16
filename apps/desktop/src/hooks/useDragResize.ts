import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type DragResizeSession = {
  /** Receives the drag delta (px) along the resize axis; call `stop` to abort. */
  onMove: (delta: number, stop: () => void) => void;
  /** Runs on mouseup after the listeners are detached. */
  onEnd: () => void;
};

type DragAxis = "x" | "y";

/**
 * Shared drag-to-resize plumbing: prevents the default mousedown, tracks the
 * pointer on `window` and detaches both listeners on mouseup or abort.
 *
 * `create` runs at mousedown, so it captures the values of the render that
 * started the drag (the original handlers' closure semantics).
 */
function useAxisDragResize(
  axis: DragAxis,
  create: () => DragResizeSession,
): (event: ReactMouseEvent<HTMLButtonElement>) => void {
  const createRef = useRef(create);
  createRef.current = create;

  return useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const start = axis === "x" ? event.clientX : event.clientY;
      const session = createRef.current();

      let active = true;
      const detach = () => {
        if (!active) return;
        active = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      const onMove = (move: MouseEvent) => {
        const current = axis === "x" ? move.clientX : move.clientY;
        session.onMove(current - start, detach);
      };

      const onUp = () => {
        detach();
        session.onEnd();
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [axis],
  );
}

/** Column resize (left/right edges). */
export function useDragResize(
  create: () => DragResizeSession,
): (event: ReactMouseEvent<HTMLButtonElement>) => void {
  return useAxisDragResize("x", create);
}

/** Row resize (top/bottom edges), e.g. the terminal panel's height. */
export function useVerticalDragResize(
  create: () => DragResizeSession,
): (event: ReactMouseEvent<HTMLButtonElement>) => void {
  return useAxisDragResize("y", create);
}
