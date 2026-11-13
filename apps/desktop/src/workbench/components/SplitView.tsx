/**
 * Renders the split tree with absolute positioning. The container is measured
 * with `ResizeObserver`; every group and sash gets a pixel rect computed from
 * the persisted fractions plus per-node minimum sizes.
 *
 * Pixel conversion comes from the layout core (`geometry.ts`). Children with
 * no content (empty canonical docks) contribute no minimum and collapse to
 * 0px; the remaining children share the container by their relative fractions.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { GROUP_GAP, SASH_HIT, groupMinSize } from "../layout/defaults";
import {
  hasContent,
  minSizesPx,
  resolvePx,
  sashPositions,
} from "../layout/geometry";
import type {
  GroupNode,
  LayoutNode,
  SplitNode,
  WorkbenchLayoutApi,
} from "../layout/types";
import { t } from "../../lib/i18n";
import { Sash, SashLayer } from "./Sash";

export type Rect = { x: number; y: number; width: number; height: number };

export type GroupPlacement = {
  group: GroupNode;
  rect: Rect;
  /** A canonical dock with no tabs: renders no card and takes 0px. */
  empty: boolean;
};

type SplitViewProps = {
  layout: WorkbenchLayoutApi;
  renderGroup: (
    placement: GroupPlacement,
    state: { hidden: boolean; maximized: boolean },
  ) => ReactNode;
};

type TreeLayout = {
  groups: GroupPlacement[];
  sashes: Array<{
    key: string;
    splitId: string;
    index: number;
    axis: "x" | "y";
    containerPx: number;
    rect: Rect;
  }>;
};

export function SplitView({ layout, renderGroup }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    /**
     * The main window is created hidden and revealed after the first paint, so
     * the first measurement can legitimately be 0×0 and ResizeObserver stays
     * quiet until something changes. Retry on animation frames until the layout
     * is real, and also re-measure on window resize / visibility changes so a
     * restored window never keeps a zero-sized tree.
     */
    let frame = 0;
    let attempts = 0;

    const apply = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) =>
        Math.abs(current.width - width) < 0.5 &&
        Math.abs(current.height - height) < 0.5
          ? current
          : { width, height },
      );
      if ((width === 0 || height === 0) && attempts < 240) {
        attempts += 1;
        frame = window.requestAnimationFrame(apply);
      }
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        attempts = 0;
        apply();
      }
    };
    window.addEventListener("resize", apply);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", apply);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const tree = buildTree(layout.layout.root, {
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
  });
  const maxId = layout.layout.maximizedGroupId;
  const maximized = tree.groups.some((item) => item.group.id === maxId) ? maxId : null;

  return (
    <div
      ref={containerRef}
      data-workbench-region="layout-area"
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {tree.groups.map((placement) => {
        const isMaximized = placement.group.id === maximized;
        const hidden = maximized !== null && !isMaximized;
        return renderGroup(
          isMaximized
            ? {
                ...placement,
                rect: { x: 0, y: 0, width: size.width, height: size.height },
              }
            : placement,
          { hidden, maximized: isMaximized },
        );
      })}

      {maximized === null
        ? tree.sashes.map((sash) => (
            <Sash
              key={sash.key}
              axis={sash.axis}
              label={t("layout.sashReset")}
              className="z-10"
              splitId={sash.splitId}
              sashIndex={sash.index}
              mainSize={sash.containerPx}
              style={{
                left: sash.rect.x,
                top: sash.rect.y,
                width: sash.rect.width,
                height: sash.rect.height,
              }}
              onDragStart={() => {
                const session = layout.beginSashDrag(sash.splitId, sash.index);
                return {
                  move: (delta) => session.move(delta, sash.containerPx),
                  end: session.end,
                };
              }}
              onReset={() => layout.resetSash(sash.splitId)}
            />
          ))
        : null}

      {maximized === null ? (
        <SashLayer
          api={layout}
          containerRef={containerRef}
          revision={layout.layout}
        />
      ) : null}
    </div>
  );
}

/** Recursively turns fractions into group cards and sash hit rects. */
function buildTree(node: LayoutNode, rect: Rect): TreeLayout {
  const out: TreeLayout = { groups: [], sashes: [] };
  walk(node, rect, out);
  return out;
}

function walk(node: LayoutNode, rect: Rect, out: TreeLayout): void {
  if (node.kind === "group") {
    out.groups.push({
      group: node,
      rect,
      empty: node.panels.length === 0,
    });
    return;
  }

  const horizontal = node.direction === "row";
  const total = horizontal ? rect.width : rect.height;
  const sizes = resolveChildPx(node, total);

  let offset = 0;
  node.children.forEach((child, index) => {
    const main = sizes[index] ?? 0;
    const childRect: Rect = horizontal
      ? { x: rect.x + offset, y: rect.y, width: main, height: rect.height }
      : { x: rect.x, y: rect.y + offset, width: rect.width, height: main };
    walk(child, childRect, out);
    offset += main;
  });

  for (const sash of total > 0 ? sashPositions(node, sizes, hasContent) : []) {
    const axis = horizontal ? "x" : "y";
    out.sashes.push({
      key: `${node.id}:${sash.index}`,
      splitId: node.id,
      index: sash.index,
      axis,
      containerPx: total,
      rect:
        axis === "x"
          ? {
              x: rect.x + sash.offsetPx - SASH_HIT / 2,
              y: rect.y,
              width: SASH_HIT,
              height: rect.height,
            }
          : {
              x: rect.x,
              y: rect.y + sash.offsetPx - SASH_HIT / 2,
              width: rect.width,
              height: SASH_HIT,
            },
    });
  }
}

/**
 * Fractions -> px for one split. Empty canonical docks collapse to 0px and do
 * not take a share; the children with content share the container by their
 * stored fractions (normalized over the non-empty set) and keep their minimum
 * size when there is room. `minSizesPx` is the same minima the sash clamp uses.
 */
function resolveChildPx(node: SplitNode, total: number): number[] {
  const sizes = new Array<number>(node.children.length).fill(0);
  if (total <= 0 || node.children.length === 0) return sizes;

  const mins = minSizesPx(node, groupMinSize);
  const active = node.children
    .map((_, index) => index)
    .filter((index) => (mins[index] ?? 0) > 0 && hasContent(node.children[index]!));
  if (active.length === 0) return sizes;
  if (active.length === 1) {
    sizes[active[0]!] = total;
    return sizes;
  }

  const fractions = active.map((index) => Math.max(0, node.sizes[index] ?? 0));
  const sum = fractions.reduce((totalFraction, value) => totalFraction + value, 0);
  const normalized =
    sum > 0 ? fractions.map((value) => value / sum) : fractions.map(() => 1 / fractions.length);
  let px = resolvePx(normalized, total);

  // Raise every child to its minimum, then take the excess back from the
  // children that still have slack. When even the minima do not fit, shrink
  // them proportionally so the tree never overflows the container.
  const activeMins = active.map((index) => mins[index] ?? 0);
  px = px.map((value, position) => Math.max(value, activeMins[position] ?? 0));
  const allocated = px.reduce((value, item) => value + item, 0);
  const excess = allocated - total;
  if (excess > 0) {
    const slack = px.map((value, position) =>
      Math.max(0, value - (activeMins[position] ?? 0)),
    );
    const slackSum = slack.reduce((value, item) => value + item, 0);
    const minSum = activeMins.reduce((value, item) => value + item, 0);
    if (slackSum >= excess) {
      px = px.map((value, position) => value - (excess * slack[position]!) / slackSum);
    } else if (minSum > 0) {
      px = activeMins.map((minimum) => (total * minimum) / minSum);
    }
  }

  active.forEach((index, position) => {
    sizes[index] = px[position] ?? 0;
  });
  return sizes;
}

/** Half the visual gutter on each side of a group card. */
export const GROUP_INSET = GROUP_GAP / 2;
