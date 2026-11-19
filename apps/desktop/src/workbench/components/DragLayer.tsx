import type { ReactNode } from "react";

import { t } from "../../lib/i18n";

export type TabDrop = {
  groupId: string;
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
 * Highlights the whole target group: a drop moves the tab into that group's
 * tab strip. Positioned in viewport coordinates so it lines up with the group
 * cell even while the pointer moves.
 */
export function DropOverlay({ drop }: { drop: TabDrop }) {
  return (
    <div
      data-component="DropOverlay"
      aria-hidden
      className="pointer-events-none fixed z-50 rounded-lg border border-sky-400 bg-sky-400/10"
      style={{ left: drop.left, top: drop.top, width: drop.width, height: drop.height }}
    >
      <div className="flex h-full items-center justify-center p-1">
        <span className="rounded-md border border-sky-200 bg-surface px-2 py-1 text-ui-sm text-sky-700">
          {t("layout.dropCenter")}
        </span>
      </div>
    </div>
  );
}
