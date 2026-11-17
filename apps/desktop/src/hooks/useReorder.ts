import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Pointer-driven list reordering.
 *
 * Native HTML5 drag (`draggable` + `dragstart`) does not start on a `<button>`
 * in this webview, which is why the settings lists never moved. A grip handle
 * that follows the pointer, hit-tests the row under it and commits on release
 * works the same for mouse, pen and touch without a library.
 *
 * Rows opt in with `data-reorder-list` and `data-reorder-id`; `list` keeps two
 * adjacent lists (providers and models) from answering for each other.
 */
export function useReorder(
  list: string,
  onMove: (from: string, to: string) => void,
): {
  dragId: string | null;
  overId: string | null;
  startDrag: (id: string) => (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const overRef = useRef<string | null>(null);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  useEffect(() => {
    if (!dragId) return;

    const rowAt = (x: number, y: number): string | null => {
      const element = document.elementFromPoint(x, y);
      const row = element?.closest<HTMLElement>("[data-reorder-id]");
      if (!row || row.dataset.reorderList !== list) return null;
      return row.dataset.reorderId ?? null;
    };

    const at = (event: PointerEvent) => {
      const id = rowAt(event.clientX, event.clientY);
      if (id === overRef.current) return;
      overRef.current = id;
      setOverId(id);
    };

    const finish = (commit: boolean) => {
      const from = dragRef.current;
      const to = overRef.current;
      dragRef.current = null;
      overRef.current = null;
      setDragId(null);
      setOverId(null);
      if (commit && from && to && from !== to) moveRef.current(from, to);
    };

    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", at);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", at);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [dragId, list]);

  const startDrag = (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Keeps the press from selecting text or firing the row's click.
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = id;
    overRef.current = id;
    setDragId(id);
    setOverId(id);
  };

  return { dragId, overId, startDrag };
}
