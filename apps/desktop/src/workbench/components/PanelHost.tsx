/**
 * One stable React layer that renders every open panel exactly once. Each
 * panel gets its own detached surface element (created outside React) and a
 * portal into it; the surface is then appended to the owning group body.
 *
 * Because the portal container never changes when a tab moves between groups,
 * React keeps the panel component mounted: xterm scrollback, scroll positions
 * and detail state survive tab moves. Only the DOM element changes parents.
 */
import clsx from "clsx";
import { createPortal } from "react-dom";
import { useLayoutEffect, useState } from "react";

import type { GroupNode, PanelRef } from "../layout/types";
import { PANEL_DEFINITIONS } from "../panels/registry";

type PanelHostProps = {
  groups: GroupNode[];
  bodies: Record<string, HTMLElement | null | undefined>;
  /** The focused group; a tab only counts as visible inside it. */
  activeGroupId: string;
  /** While set, every other group is hidden behind the maximized one. */
  maximizedGroupId: string | null;
};

export function PanelHost({
  groups,
  bodies,
  activeGroupId,
  maximizedGroupId,
}: PanelHostProps) {
  return (
    <>
      {groups.flatMap((group) =>
        group.panels.map((panel) => (
          <PanelSurface
            key={panel.id}
            panel={panel}
            active={group.activePanelId === panel.id}
            visible={
              group.activePanelId === panel.id &&
              group.id === activeGroupId &&
              (maximizedGroupId === null || maximizedGroupId === group.id)
            }
            body={bodies[group.id] ?? null}
          />
        )),
      )}
    </>
  );
}

function PanelSurface({
  panel,
  active,
  visible,
  body,
}: {
  panel: PanelRef;
  active: boolean;
  visible: boolean;
  body: HTMLElement | null;
}) {
  const [surface] = useState(() => {
    const element = document.createElement("div");
    element.className = "absolute inset-0";
    element.dataset.panelSurface = panel.id;
    return element;
  });

  useLayoutEffect(() => {
    if (!body) return;
    body.appendChild(surface);
    return () => {
      surface.remove();
    };
  }, [body, surface]);

  /**
   * Every surface is a full-bleed box, and the group body stacks them in tab
   * order. Only the active surface may hit-test: otherwise the last tab's
   * empty box sits on top and swallows clicks/scroll for the active one.
   * The panel inside is already `pointer-events-none` when inactive, but that
   * does not cover the box itself.
   */
  useLayoutEffect(() => {
    surface.style.pointerEvents = active ? "" : "none";
  }, [active, surface]);

  return createPortal(
    <div
      data-component="PanelSurface"
      data-panel-id={panel.id}
      data-panel-active={active ? "true" : "false"}
      aria-hidden={!active}
      inert={!active}
      className={clsx(
        "workbench-panel absolute inset-0 flex min-h-0 flex-col",
        !active && "invisible pointer-events-none",
      )}
    >
      {PANEL_DEFINITIONS[panel.kind].render({ panel, active, visible })}
    </div>,
    surface,
  );
}
