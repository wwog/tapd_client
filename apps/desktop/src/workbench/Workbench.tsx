/**
 * Workbench host: wires the layout API to the split view, the tab drag
 * protocol, the stable panel portals and the panel services context.
 *
 * App owns the layout hook and the domain hooks (`useDetailPane`,
 * `useTerminalPanel`); this component only translates them into the view layer.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { AlertTriangle } from "lucide-react";

import { t } from "../lib/i18n";
import { Button } from "../components/ui";
import { Dialog } from "../components/Dialog";
import {
  type PanelRef,
  type WorkbenchLayoutApi,
} from "./layout/types";
import { isPanelDirty, setPanelDirty } from "./panels/dirty";
import { PANEL_DEFINITIONS } from "./panels/registry";
import {
  PanelServicesProvider,
  type PanelServices,
} from "./panels/context";
import { PageHostProvider, type PageHostServices } from "./components/pageContext";
import { DragGhost, DropOverlay, type TabDrag, type TabDrop } from "./components/DragLayer";
import { GroupView } from "./components/GroupView";
import { PanelHost } from "./components/PanelHost";
import { SplitView, type GroupPlacement } from "./components/SplitView";

type WorkbenchProps = {
  layout: WorkbenchLayoutApi;
  /** Domain services; `open` / `closePanel` / `pinPanel` are filled in here. */
  services: Omit<PanelServices, "open" | "closePanel" | "pinPanel">;
  page: PageHostServices;
  /** Primary group strip actions: the side bar toggle, left of the tabs. */
  primaryLeading?: ReactNode;
  /**
   * Trailing slot of every group's tab strip (`ActiveTabExtra`). App decides
   * per focused tab; a handler that returns nothing leaves the slot empty.
   */
  activeTabExtra?: (panel: PanelRef) => ReactNode;
  /**
   * Welcome page's「打开终端」: App owns dock visibility, so the row cannot just
   * spawn a PTY (`services.terminal.create`) behind a folded dock.
   */
  onOpenTerminal: () => void;
  /** One app-level strip above the layout area (recovery report). */
  banner?: ReactNode;
};

type DragOrigin = {
  panel: PanelRef;
  groupId: string;
  startX: number;
  startY: number;
  pointerId: number;
  icon: ReactNode;
  label: string;
};

export function Workbench({
  layout: api,
  services: baseServices,
  page,
  primaryLeading,
  activeTabExtra,
  onOpenTerminal,
  banner,
}: WorkbenchProps) {
  const [bodies, setBodies] = useState<Record<string, HTMLElement | null>>({});
  const [drag, setDrag] = useState<TabDrag | null>(null);
  /** A tab close that has to confirm unsaved edits first. */
  const [dirtyClose, setDirtyClose] = useState<PanelRef | null>(null);
  /** A `+` click should activate the session it spawned once the list syncs. */
  const pendingTerminalActivate = useRef<number | null>(null);

  const registerBody = useCallback(
    (groupId: string, element: HTMLElement | null) => {
      setBodies((current) =>
        current[groupId] === element
          ? current
          : { ...current, [groupId]: element },
      );
    },
    [],
  );

  /** Performs the close once no unsaved-edit confirmation is pending. */
  const doClose = useCallback(
    (panel: PanelRef) => {
      if (panel.resource.type === "terminal") {
        baseServices.terminal.close(panel.resource.sessionId);
      }
      if (panel.resource.type === "bug") {
        // App closes the layout panel and clears the detail fetch.
        baseServices.bug.onClose();
        return;
      }
      api.closePanel(panel.id);
    },
    [api.closePanel, baseServices.bug, baseServices.terminal],
  );

  /** Tab / drawer close: a dirty editor asks before discarding the buffer. */
  const closePanel = useCallback(
    (panel: PanelRef) => {
      if (isPanelDirty(panel.id)) {
        setDirtyClose(panel);
        return;
      }
      doClose(panel);
    },
    [doClose],
  );

  const closePanelById = useCallback(
    (panelId: string) => {
      for (const group of api.groups) {
        const panel = group.panels.find((item) => item.id === panelId);
        if (panel) {
          closePanel(panel);
          return;
        }
      }
    },
    [api.layout, closePanel],
  );

  /**
   * Window growth for a newly filled/expanded secondary dock lives in `App`:
   * it also owns the side bar, and the collapse decision has to know about the
   * resize before it lands (otherwise the column blinks out and back).
   */

  /** Programmatic open: restore a maximized layout so the new dock is visible. */
  const openService = useCallback(
    (spec: Parameters<WorkbenchLayoutApi["open"]>[0]) => {
      if (api.layout.maximizedGroupId) api.maximizeGroup(null);
      // A preview tab is replaced by the next preview of the same kind. If the
      // current one holds unsaved edits, pin it first so the buffer survives
      // (the new file simply opens as another tab).
      if (spec.preview === true) {
        for (const group of api.groups) {
          for (const panel of group.panels) {
            if (
              panel.preview &&
              panel.kind === spec.resource.type &&
              isPanelDirty(panel.id)
            ) {
              api.pinPanel(panel.id);
            }
          }
        }
      }
      return api.open(spec);
    },
    [api],
  );

  const services = useMemo<PanelServices>(
    () => ({
      ...baseServices,
      open: openService,
      closePanel: closePanelById,
      pinPanel: api.pinPanel,
    }),
    [baseServices, openService, closePanelById, api.pinPanel],
  );

  const spawnTerminal = useCallback(() => {
    pendingTerminalActivate.current = api.groups.reduce(
      (count, group) =>
        count + group.panels.filter((panel) => panel.kind === "terminal").length,
      0,
    );
    baseServices.terminal.create();
  }, [api.groups, baseServices.terminal.create]);

  // `syncTerminalPanels` appends sessions without moving focus; the `+` button
  // still expects the fresh tab to come to the front. Wait for the panel count
  // to grow so a slow spawn cannot activate an older tab.
  useEffect(() => {
    const expected = pendingTerminalActivate.current;
    if (expected === null) return;
    const terminals = api.groups.flatMap((group) =>
      group.panels
        .filter((panel) => panel.kind === "terminal")
        .map((panel) => ({ group, panel })),
    );
    if (terminals.length <= expected) return;
    const newest = terminals[terminals.length - 1]!;
    pendingTerminalActivate.current = null;
    api.activateGroup(newest.group.id);
    api.activatePanel(newest.panel.id);
  }, [api.layout, api.activateGroup, api.activatePanel]);

  const applyDrop = useCallback(
    (panel: PanelRef, fromGroupId: string, drop: TabDrop | null, x: number) => {
      if (!drop) return;
      // Moving a tab into a hidden group would be invisible; restore first.
      if (api.layout.maximizedGroupId && drop.groupId !== fromGroupId) {
        api.maximizeGroup(null);
      }
      if (drop.groupId === fromGroupId) {
        const group = api.groups.find((item) => item.id === fromGroupId);
        const currentIndex =
          group?.panels.findIndex((item) => item.id === panel.id) ?? 0;
        const finalIndex = tabInsertionIndex(drop.groupId, panel.id, x);
        // `movePanel` receives the index in the pre-removal list; it shifts
        // same-group drops down by one after removing the tab.
        const targetIndex =
          finalIndex > currentIndex ? finalIndex + 1 : finalIndex;
        api.movePanel(panel.id, drop.groupId, targetIndex);
        return;
      }
      const target = api.groups.find((group) => group.id === drop.groupId);
      api.movePanel(panel.id, drop.groupId, target?.panels.length ?? 0);
    },
    [api],
  );

  /**
   * Nav-created pages (the shared navigation tab and the queue singleton) are
   * fixed to their dock; every other tab can be dragged into another group.
   */
  const canDragTab = (panel: PanelRef): boolean =>
    !(
      panel.kind === "page" &&
      panel.resource.type === "page" &&
      !panel.resource.projectId
    );

  const startTabDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      panel: PanelRef,
      groupId: string,
    ) => {
      if (event.button !== 0 || !event.isPrimary) return;

      // Capture even for tabs that cannot drag: it keeps clicks and double
      // clicks targeting the tab itself (a stray second press that lands on
      // the strip must not toggle maximize).
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers (tests, older WebViews) may reject capture.
      }

      if (!canDragTab(panel)) return;

      const origin: DragOrigin = {
        panel,
        groupId,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        icon: PANEL_DEFINITIONS[panel.kind].icon(panel),
        label: PANEL_DEFINITIONS[panel.kind].title(panel),
      };
      let active = false;
      let cancelled = false;
      let current: TabDrop | null = null;

      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKeyDown, true);
        document.body.classList.remove("workbench-tab-dragging");
      };

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== origin.pointerId) return;
        if (!active) {
          if (
            Math.hypot(
              move.clientX - origin.startX,
              move.clientY - origin.startY,
            ) < 4
          ) {
            return;
          }
          active = true;
          document.body.classList.add("workbench-tab-dragging");
        }
        current = findDropTarget(move.clientX, move.clientY);
        setDrag({
          panelId: panel.id,
          fromGroupId: groupId,
          x: move.clientX,
          y: move.clientY,
          icon: origin.icon,
          label: origin.label,
          drop: current,
        });
      };

      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== origin.pointerId) return;
        detach();
        if (active && !cancelled) {
          current = findDropTarget(up.clientX, up.clientY);
          applyDrop(panel, groupId, current, up.clientX);
        }
        setDrag(null);
      };

      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId !== origin.pointerId) return;
        cancelled = true;
        detach();
        setDrag(null);
      };

      const onKeyDown = (key: KeyboardEvent) => {
        if (key.key !== "Escape") return;
        cancelled = true;
        detach();
        setDrag(null);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKeyDown, true);
    },
    [applyDrop],
  );

  const renderGroup = useCallback(
    (placement: GroupPlacement, state: { hidden: boolean; maximized: boolean }) => (
      <GroupView
        key={placement.group.id}
        api={api}
        group={placement.group}
        rect={placement.rect}
        empty={placement.empty}
        hidden={state.hidden}
        maximized={state.maximized}
        // Maximize hides the other groups; with nothing else filled it is a
        // no-op, so the control only exists when there is something to hide.
        canMaximize={
          state.maximized ||
          api.groups.some(
            (item) =>
              item.id !== placement.group.id && item.panels.length > 0,
          )
        }
        primaryLeading={primaryLeading}
        activeTabExtra={activeTabExtra}
        onRegisterBody={registerBody}
        onSpawnTerminal={spawnTerminal}
        onOpenTerminal={onOpenTerminal}
        onTabPointerDown={startTabDrag}
      />
    ),
    [
      api,
      activeTabExtra,
      primaryLeading,
      registerBody,
      spawnTerminal,
      onOpenTerminal,
      startTabDrag,
    ],
  );

  return (
    <PanelServicesProvider value={services}>
      <PageHostProvider value={page}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {banner}
          <SplitView layout={api} renderGroup={renderGroup} />
        </div>

        <PanelHost
          groups={api.groups}
          bodies={bodies}
          activeGroupId={api.activeGroup.id}
          maximizedGroupId={api.layout.maximizedGroupId}
        />

        {drag ? (
          <>
            {drag.drop ? <DropOverlay drop={drag.drop} /> : null}
            <DragGhost drag={drag} />
          </>
        ) : null}

        {dirtyClose ? (
          <Dialog
            title={t("layout.unsavedTitle")}
            icon={<AlertTriangle size={15} className="text-amber-500" />}
            onClose={() => setDirtyClose(null)}
          >
            <p className="text-ui-caption leading-6 text-slate-600">
              {t("layout.unsavedBody", {
                name: PANEL_DEFINITIONS[dirtyClose.kind].title(dirtyClose),
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDirtyClose(null)}
              >
                {t("layout.keepEditing")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  const panel = dirtyClose;
                  setPanelDirty(panel.id, false);
                  doClose(panel);
                  setDirtyClose(null);
                }}
              >
                {t("layout.discardClose")}
              </Button>
            </div>
          </Dialog>
        ) : null}
      </PageHostProvider>
    </PanelServicesProvider>
  );
}

/** Finds the group cell under the pointer; a drop moves the tab into it. */
function findDropTarget(x: number, y: number): TabDrop | null {
  // Empty canonical docks collapse to 0px; check their boundary strip first so
  // they can still receive a drop (otherwise the filled sibling covers them).
  const empties = document.querySelectorAll<HTMLElement>(
    '[data-workbench-group-empty="true"]',
  );
  for (const cell of empties) {
    const groupId = cell.dataset.workbenchGroup;
    if (!groupId) continue;
    const rect = cell.getBoundingClientRect();
    const pad = 12;
    if (
      x >= rect.left - pad &&
      x <= rect.right + pad &&
      y >= rect.top - pad &&
      y <= rect.bottom + pad
    ) {
      return {
        groupId,
        left: rect.left - pad,
        top: rect.top - pad,
        width: Math.max(rect.width, 0) + pad * 2,
        height: Math.max(rect.height, 0) + pad * 2,
      };
    }
  }

  const stack = document.elementsFromPoint(x, y);
  for (const element of stack) {
    const cell = element.closest<HTMLElement>("[data-workbench-group-cell]");
    if (!cell) continue;
    const groupId = cell.dataset.workbenchGroup;
    if (!groupId) continue;
    const rect = cell.getBoundingClientRect();
    return {
      groupId,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  return null;
}

/** Final tab index after removing the dragged tab from its group. */
function tabInsertionIndex(groupId: string, draggedId: string, x: number): number {
  const cell = Array.from(
    document.querySelectorAll<HTMLElement>("[data-workbench-group-cell]"),
  ).find((element) => element.dataset.workbenchGroup === groupId);
  if (!cell) return 0;
  const tabs = Array.from(
    cell.querySelectorAll<HTMLElement>("[data-tab-id]"),
  ).filter((element) => element.dataset.tabId !== draggedId);
  let index = 0;
  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    if (x > rect.left + rect.width / 2) index += 1;
    else break;
  }
  return index;
}
