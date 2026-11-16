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
  /**
   * Lit by the corner handle: `hover` while the pointer is on the intersection,
   * `drag` while it is being dragged, so both lines stay visible.
   */
  highlight?: "hover" | "drag";
  onDragStart?: () => SashDragSession | null;
  onReset?: () => void;
  className?: string;
  style?: CSSProperties;
};

/**
 * Unified split handle: no resting line over an 8px hit area; hovering reveals
 * a 1.5px highlight and dragging paints it sky blue — the hit area itself never
 * paints, so only the middle line shows. The same component serves split nodes
 * and the project side bar; the caller supplies what a drag does (layout
 * fractions vs. sidebar width).
 */
export function Sash({
  axis,
  label,
  splitId,
  sashIndex,
  mainSize,
  highlight,
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
        "group/sash absolute touch-none bg-transparent p-0",
        axis === "x" ? "cursor-col-resize" : "cursor-row-resize",
        className,
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "pointer-events-none absolute transition-colors",
          axis === "x"
            ? "left-1/2 top-0 h-full w-[1.5px] -translate-x-1/2"
            : "left-0 top-1/2 h-[1.5px] w-full -translate-y-1/2",
          dragging || highlight === "drag"
            ? "bg-sky-400/60"
            : highlight === "hover"
              ? "bg-sky-300/70"
              : "bg-transparent group-hover/sash:bg-sky-300/70",
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

/** What a corner handle reports: nothing, a hover, or an active drag. */
export type CornerHighlight = { keys: string[]; dragging: boolean } | null;

type SashLayerProps = {
  api: WorkbenchLayoutApi;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Any value that changes when the tree (or the container) does. */
  revision: unknown;
  /** Corner handle under the pointer; `null` once it is released. */
  onCornerHighlight: (highlight: CornerHighlight) => void;
};

/**
 * Measures every rendered sash and paints a corner handle where a vertical and
 * a horizontal sash intersect (including T junctions). One drag adjusts both
 * split nodes through `beginCornerDrag`; the corner keeps both lines lit while
 * it is hovered or dragged.
 */
export function SashLayer({
  api,
  containerRef,
  revision,
  onCornerHighlight,
}: SashLayerProps) {
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
        <CornerSash
          key={corner.id}
          api={api}
          corner={corner}
          onHighlight={onCornerHighlight}
        />
      ))}
    </>
  );
}

function CornerSash({
  api,
  corner,
  onHighlight,
}: {
  api: WorkbenchLayoutApi;
  corner: Corner;
  onHighlight: (highlight: CornerHighlight) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef(false);
  const keys = [corner.vertical.key, corner.horizontal.key];

  /** The lines survive a re-measure, so only an unmount drops the highlight. */
  useLayoutEffect(() => () => onHighlight(null), [onHighlight]);

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
    dragRef.current = true;
    setDragging(true);
    onHighlight({ keys, dragging: true });

    const onMove = (move: MouseEvent) => {
      session.move(move.clientX - startX, move.clientY - startY);
    };
    const detach = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onUp = (up: MouseEvent) => {
      detach();
      dragRef.current = false;
      setDragging(false);
      // The handle follows the pointer, so ask the current rect instead of
      // trusting a mouseleave that may never arrive after the drop.
      const rect = buttonRef.current?.getBoundingClientRect();
      const over =
        rect !== undefined &&
        up.clientX >= rect.left &&
        up.clientX <= rect.right &&
        up.clientY >= rect.top &&
        up.clientY <= rect.bottom;
      onHighlight(over ? { keys, dragging: false } : null);
      session.end();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={t("layout.cornerSash")}
      title={t("layout.cornerSash")}
      data-workbench-region="corner-sash"
      onMouseDown={onMouseDown}
      onMouseEnter={() => onHighlight({ keys, dragging: dragRef.current })}
      onMouseLeave={() => {
        // A drag keeps both lines lit even when the pointer runs ahead of it.
        if (!dragRef.current) onHighlight(null);
      }}
      className={clsx(
        "absolute z-20 touch-none rounded-sm p-0",
        dragging ? "cursor-move bg-sky-400/50" : "cursor-move bg-transparent",
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
