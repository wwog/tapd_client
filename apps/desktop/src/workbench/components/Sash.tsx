import clsx from "clsx";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useDragResize, useVerticalDragResize } from "../../hooks/useDragResize";
import { t } from "../../lib/i18n";
import { CORNER_SIZE } from "../layout/defaults";
import { intersectSashes } from "../layout/geometry";
import type { WorkbenchLayoutApi } from "../layout/types";

/** A drag reported by `Sash` / `CornerSash`; deltas are total px from the origin. */
export type SashDragSession = {
  move: (delta: number) => void;
  end: () => void;
};

type SashProps = {
  /** `x` = vertical line, column resize; `y` = horizontal line, row resize. */
  axis: "x" | "y";
  label: string;
  /** Split boundary this sash controls (used by `SashLayer`). */
  splitId?: string;
  sashIndex?: number;
  /** Main-axis size of the split container at measure time. */
  mainSize?: number;
  onDragStart?: () => SashDragSession | null;
  onReset?: () => void;
  className?: string;
  style?: CSSProperties;
};

/**
 * Unified split handle: 1.5px visible line, 8px hit area. The same component
 * serves split nodes and the project side bar; the caller supplies what a drag
 * does (layout fractions vs. sidebar width).
 */
export function Sash({
  axis,
  label,
  splitId,
  sashIndex,
  mainSize,
  onDragStart,
  onReset,
  className,
  style,
}: SashProps) {
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(onDragStart);
  dragStartRef.current = onDragStart;
  const resetRef = useRef(onReset);
  resetRef.current = onReset;

  const begin = useCallback(() => {
    const session = dragStartRef.current?.() ?? null;
    if (!session) {
      return { onMove: () => undefined, onEnd: () => undefined };
    }
    setDragging(true);
    return {
      onMove: (delta: number) => session.move(delta),
      onEnd: () => {
        setDragging(false);
        session.end();
      },
    };
  }, []);

  const startHorizontalDrag = useDragResize(begin);
  const startVerticalDrag = useVerticalDragResize(begin);
  const onMouseDown = axis === "x" ? startHorizontalDrag : startVerticalDrag;

  const handleDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resetRef.current?.();
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-workbench-region="sash"
      data-sash-axis={axis}
      {...(splitId ? { "data-split-id": splitId } : {})}
      {...(sashIndex !== undefined ? { "data-sash-index": String(sashIndex) } : {})}
      {...(mainSize !== undefined ? { "data-main-size": String(Math.round(mainSize)) } : {})}
      onMouseDown={onMouseDown}
      onDoubleClick={handleDoubleClick}
      style={style}
      className={clsx(
        "group/sash absolute touch-none p-0",
        axis === "x" ? "cursor-col-resize" : "cursor-row-resize",
        dragging ? "bg-sky-400/50" : "bg-transparent hover:bg-overlay",
        className,
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "pointer-events-none absolute bg-border transition-colors",
          axis === "x"
            ? "left-1/2 top-0 h-full w-[1.5px] -translate-x-1/2"
            : "left-0 top-1/2 h-[1.5px] w-full -translate-y-1/2",
          dragging ? "bg-sky-400/60" : "group-hover/sash:bg-sky-300/70",
        )}
      />
    </button>
  );
}

type SashMeta = {
  key: string;
  splitId: string;
  index: number;
  containerPx: number;
  direction: "row" | "column";
  rect: { left: number; top: number; width: number; height: number };
};

type Corner = {
  id: string;
  x: number;
  y: number;
  vertical: SashMeta;
  horizontal: SashMeta;
};

type SashLayerProps = {
  api: WorkbenchLayoutApi;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Any value that changes when the tree (or the container) does. */
  revision: unknown;
};

/**
 * Measures every rendered sash and paints a corner handle where a vertical and
 * a horizontal sash intersect (including T junctions). One drag adjusts both
 * split nodes through `beginCornerDrag`.
 */
export function SashLayer({ api, containerRef, revision }: SashLayerProps) {
  const [corners, setCorners] = useState<Corner[]>([]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();
    const measured: SashMeta[] = [];

    container
      .querySelectorAll<HTMLElement>('[data-workbench-region="sash"]')
      .forEach((element) => {
        const splitId = element.dataset.splitId;
        const index = Number(element.dataset.sashIndex);
        if (!splitId || !Number.isFinite(index)) return;
        const rect = element.getBoundingClientRect();
        measured.push({
          key: `${splitId}:${index}`,
          splitId,
          index,
          containerPx: Number(element.dataset.mainSize) || 0,
          direction: element.dataset.sashAxis === "x" ? "row" : "column",
          rect: {
            left: rect.left - base.left,
            top: rect.top - base.top,
            width: rect.width,
            height: rect.height,
          },
        });
      });

    const byKey = new Map(measured.map((sash) => [sash.key, sash]));
    const next: Corner[] = [];
    for (const intersection of intersectSashes(measured)) {
      const vertical = byKey.get(
        `${intersection.vertical.splitId}:${intersection.vertical.index}`,
      );
      const horizontal = byKey.get(
        `${intersection.horizontal.splitId}:${intersection.horizontal.index}`,
      );
      if (!vertical || !horizontal) continue;
      next.push({
        id: `${vertical.key}|${horizontal.key}`,
        x: intersection.x,
        y: intersection.y,
        vertical,
        horizontal,
      });
    }
    setCorners((current) => (sameCorners(current, next) ? current : next));
  }, [containerRef]);

  useLayoutEffect(() => {
    measure();
  }, [measure, revision]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [containerRef, measure]);

  if (corners.length === 0) return null;

  return (
    <>
      {corners.map((corner) => (
        <CornerSash key={corner.id} api={api} corner={corner} />
      ))}
    </>
  );
}

function CornerSash({ api, corner }: { api: WorkbenchLayoutApi; corner: Corner }) {
  const [dragging, setDragging] = useState(false);

  const onMouseDown = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const session = api.beginCornerDrag(
      {
        splitId: corner.vertical.splitId,
        index: corner.vertical.index,
        containerPx: corner.vertical.containerPx,
      },
      {
        splitId: corner.horizontal.splitId,
        index: corner.horizontal.index,
        containerPx: corner.horizontal.containerPx,
      },
    );
    const startX = event.clientX;
    const startY = event.clientY;
    setDragging(true);

    const onMove = (move: MouseEvent) => {
      session.move(move.clientX - startX, move.clientY - startY);
    };
    const detach = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onUp = () => {
      detach();
      setDragging(false);
      session.end();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <button
      type="button"
      aria-label={t("layout.cornerSash")}
      title={t("layout.cornerSash")}
      data-workbench-region="corner-sash"
      onMouseDown={onMouseDown}
      className={clsx(
        "absolute z-20 touch-none cursor-move rounded-sm p-0",
        dragging ? "bg-sky-400/50" : "bg-transparent hover:bg-overlay",
      )}
      style={{
        left: corner.x - CORNER_SIZE / 2,
        top: corner.y - CORNER_SIZE / 2,
        width: CORNER_SIZE,
        height: CORNER_SIZE,
      }}
    />
  );
}

function sameCorners(a: Corner[], b: Corner[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((corner, index) => {
    const other = b[index]!;
    return (
      corner.id === other.id &&
      Math.abs(corner.x - other.x) < 0.5 &&
      Math.abs(corner.y - other.y) < 0.5
    );
  });
}
