import type { ReactNode } from "react";
import clsx from "clsx";

import { t, type MessageKey } from "../../lib/i18n";
import type { DropZone } from "../layout/types";

export type TabDrop = {
  groupId: string;
  zone: DropZone;
  /** Viewport rectangle of the target group cell. */
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TabDrag = {
  panelId: string;
  fromGroupId: string;
  x: number;
  y: number;
  icon: ReactNode;
  label: string;
  drop: TabDrop | null;
};

const DROP_LABELS: Record<DropZone, MessageKey> = {
  center: "layout.dropCenter",
  left: "layout.dropLeft",
  right: "layout.dropRight",
  top: "layout.dropTop",
  bottom: "layout.dropBottom",
};

/** Follows the pointer; never intercepts hit-testing. */
export function DragGhost({ drag }: { drag: TabDrag }) {
  return (
    <div
      data-component="DragGhost"
      className="pointer-events-none fixed z-50 flex max-w-64 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-ui-sm text-slate-700"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      <span className="shrink-0 text-slate-400">{drag.icon}</span>
      <span className="truncate">{drag.label}</span>
    </div>
  );
}

/**
 * Highlights the target: the whole group for a center drop, or the half the
 * new split would occupy. Positioned in viewport coordinates so it lines up
 * with the group cell even while the pointer moves.
 */
export function DropOverlay({ drop }: { drop: TabDrop }) {
  const { zone } = drop;
  let left = drop.left;
  let top = drop.top;
  let width = drop.width;
  let height = drop.height;

  if (zone === "left") width = width / 2;
  else if (zone === "right") {
    left += width / 2;
    width /= 2;
  } else if (zone === "top") height /= 2;
  else if (zone === "bottom") {
    top += height / 2;
    height /= 2;
  }

  return (
    <div
      data-component="DropOverlay"
      aria-hidden
      className={clsx(
        "pointer-events-none fixed z-50 rounded-lg border border-sky-300 bg-sky-400/10",
        zone === "center" && "border-sky-400",
      )}
      style={{ left, top, width, height }}
    >
      <div className="flex h-full items-center justify-center p-1">
        <span className="rounded-md border border-sky-200 bg-surface px-2 py-1 text-ui-sm text-sky-700">
          {t(DROP_LABELS[zone])}
        </span>
      </div>
    </div>
  );
}
