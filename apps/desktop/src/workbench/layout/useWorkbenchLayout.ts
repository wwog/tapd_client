/**
 * React binding for the layout core: one persisted `LayoutPrefs` state, stable
 * callbacks over a `layoutRef`, and snapshot-based sash drags.
 *
 * Mutators return synchronously (notably `open`) while still committing
 * through a functional `setPrefs`, so two calls in the same tick compose in
 * order instead of losing one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  createGroup,
  groupMinSize,
} from "./defaults.ts";
import {
  activeChildren,
  dragPair,
  minSizesPx,
  renderFractions,
  storedFractions,
} from "./geometry.ts";
import {
  activateGroup as activateGroupOp,
  activatePanel as activatePanelOp,
  closePanel as closePanelOp,
  findSplit,
  maximizeGroup as maximizeGroupOp,
  movePanel as movePanelOp,
  openPage as openPageOp,
  openPanel as openPanelOp,
  retargetPage as retargetPageOp,
  pinPanel as pinPanelOp,
  resetSizes as resetSizesOp,
  setPanelLabel as setPanelLabelOp,
  setSizes as setSizesOp,
  syncTerminalPanels as syncTerminalPanelsOp,
} from "./ops.ts";
import { initialPrefs, loadPrefs, savePrefs } from "./persist.ts";
import {
  findGroup,
  findPanel,
  findRoleGroup,
  listGroups,
  makePanel,
} from "./types.ts";
import type {
  GroupNode,
  LayoutPrefs,
  LayoutState,
  PageView,
  PanelOpenSpec,
  WorkbenchLayoutApi,
} from "./types.ts";

/** Sidebar width is a plain px preference; the view layer owns collapse. */
function clampSidebarWidth(width: number): number {
  return Math.round(
    Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH),
  );
}

const noopDrag = () => undefined;
const NOOP_SASH = { move: noopDrag, end: noopDrag };

export function useWorkbenchLayout(): WorkbenchLayoutApi {
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => {
    const stored = loadPrefs();
    if (stored) {
      return { ...stored, sidebarWidth: clampSidebarWidth(stored.sidebarWidth) };
    }
    const width = typeof window === "undefined" ? 1280 : window.innerWidth;
    const height = typeof window === "undefined" ? 900 : window.innerHeight;
    return initialPrefs(width, height);
  });

  /** Latest committed tree, readable from stable callbacks and drag sessions. */
  const layoutRef = useRef(prefs.layout);
  layoutRef.current = prefs.layout;

  /**
   * Applies a pure layout transform. The ref is updated immediately so a
   * second call in the same tick builds on the first; the functional update
   * only installs a result computed from the tree still in state.
   */
  const commit = useCallback(
    (transform: (layout: LayoutState) => LayoutState) => {
      const base = layoutRef.current;
      const next = transform(base);
      if (next === base) return;
      layoutRef.current = next;
      setPrefs((prev) =>
        prev.layout === base ? { ...prev, layout: next } : prev,
      );
    },
    [],
  );

  // Skip the initial render: `initialPrefs` already reflects the migrated
  // legacy prefs, and an unchanged tree should not trigger a config write.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    savePrefs({
      version: 1,
      layout: prefs.layout,
      sidebarWidth: prefs.sidebarWidth,
      sidebarCollapsed: prefs.sidebarCollapsed,
    });
  }, [prefs.layout, prefs.sidebarWidth, prefs.sidebarCollapsed]);

  const groups = useMemo(() => listGroups(prefs.layout.root), [prefs.layout]);

  const activeGroup = useMemo<GroupNode>(() => {
    return (
      findGroup(prefs.layout.root, prefs.layout.activeGroupId) ??
      findRoleGroup(prefs.layout.root, "primary") ??
      groups[0] ??
      // Unreachable after `normalize`; a safe fallback keeps the API total.
      createGroup("primary")
    );
  }, [prefs.layout, groups]);

  const activePanelId = activeGroup.activePanelId;

  const open = useCallback(
    (spec: PanelOpenSpec): string => {
      // The id is derived from the resource, so it is known before commit.
      const id = makePanel(spec.resource).id;
      commit((layout) => openPanelOp(layout, spec, layout.activeGroupId).layout);
      return id;
    },
    [commit],
  );

  const openPage = useCallback(
    (view: PageView, projectId?: string, label?: string) => {
      commit((layout) => openPageOp(layout, view, projectId, label));
    },
    [commit],
  );

  const retargetPage = useCallback(
    (view: PageView, projectId: string) => {
      commit((layout) => retargetPageOp(layout, view, projectId));
    },
    [commit],
  );

  const activatePanel = useCallback(
    (panelId: string) => {
      commit((layout) => activatePanelOp(layout, panelId));
    },
    [commit],
  );

  const activateGroup = useCallback(
    (groupId: string) => {
      commit((layout) => activateGroupOp(layout, groupId));
    },
    [commit],
  );

  const closePanel = useCallback(
    (panelId: string) => {
      commit((layout) => closePanelOp(layout, panelId));
    },
    [commit],
  );

  const pinPanel = useCallback(
    (panelId: string) => {
      commit((layout) => pinPanelOp(layout, panelId));
    },
    [commit],
  );

  const setPanelLabel = useCallback(
    (panelId: string, label: string) => {
      commit((layout) => setPanelLabelOp(layout, panelId, label));
    },
    [commit],
  );

  const movePanel = useCallback(
    (panelId: string, groupId: string, index: number) => {
      commit((layout) => movePanelOp(layout, panelId, groupId, index));
    },
    [commit],
  );

  const setSizes = useCallback(
    (splitId: string, sizes: number[]) => {
      commit((layout) => setSizesOp(layout, splitId, sizes));
    },
    [commit],
  );

  const resetSash = useCallback(
    (splitId: string) => {
      commit((layout) => resetSizesOp(layout, splitId));
    },
    [commit],
  );

  /**
   * Snapshot-based sash drag: the sizes and minimums are captured when the
   * pointer goes down, and every move applies the *total* delta from that
   * origin, so clamping cannot accumulate drift.
   */
  const beginSashDrag = useCallback(
    (splitId: string, index: number) => {
      const split = findSplit(layoutRef.current.root, splitId);
      if (
        !split ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= split.children.length - 1
      ) {
        return NOOP_SASH;
      }
      const snapshot = split.sizes.slice();
      const minPx = minSizesPx(split, groupMinSize);
      // Drag in the space the renderer uses: empty canonical docks collapse
      // and the filled children are renormalized over their own sum, so
      // dragging stored fractions would move the divider by the wrong amount.
      const active = activeChildren(split, groupMinSize);
      const rendered = renderFractions(snapshot, active);
      return {
        move: (deltaPx: number, containerPx: number) => {
          if (
            !Number.isFinite(deltaPx) ||
            !Number.isFinite(containerPx) ||
            containerPx <= 0
          ) {
            return;
          }
          const dragged =
            active.length > 1
              ? dragPair(rendered, index, deltaPx, containerPx, minPx)
              : rendered;
          const sizes = storedFractions(snapshot, dragged, active);
          commit((layout) => setSizesOp(layout, splitId, sizes));
        },
        end: noopDrag,
      };
    },
    [commit],
  );

  /**
   * Corner drag: a vertical sash (row split, dx) and a horizontal sash
   * (column split, dy) update together. The two splits are snapshotted
   * independently; mismatched directions or invalid ids are a no-op.
   */
  const beginCornerDrag = useCallback(
    (
      vertical: { splitId: string; index: number; containerPx: number },
      horizontal: { splitId: string; index: number; containerPx: number },
    ) => {
      const vSplit = findSplit(layoutRef.current.root, vertical.splitId);
      const hSplit = findSplit(layoutRef.current.root, horizontal.splitId);
      if (!vSplit || !hSplit) return NOOP_SASH;
      if (vSplit.direction !== "row" || hSplit.direction !== "column") {
        return NOOP_SASH;
      }
      if (
        !Number.isInteger(vertical.index) ||
        vertical.index < 0 ||
        vertical.index >= vSplit.children.length - 1 ||
        !Number.isInteger(horizontal.index) ||
        horizontal.index < 0 ||
        horizontal.index >= hSplit.children.length - 1
      ) {
        return NOOP_SASH;
      }

      const vSnapshot = vSplit.sizes.slice();
      const hSnapshot = hSplit.sizes.slice();
      const vMinPx = minSizesPx(vSplit, groupMinSize);
      const hMinPx = minSizesPx(hSplit, groupMinSize);
      // Same rendered-space conversion as a plain sash drag.
      const vActive = activeChildren(vSplit, groupMinSize);
      const hActive = activeChildren(hSplit, groupMinSize);
      const vRendered = renderFractions(vSnapshot, vActive);
      const hRendered = renderFractions(hSnapshot, hActive);

      return {
        move: (dx: number, dy: number) => {
          const vSizes =
            Number.isFinite(dx) &&
            Number.isFinite(vertical.containerPx) &&
            vertical.containerPx > 0
              ? storedFractions(
                  vSnapshot,
                  vActive.length > 1
                    ? dragPair(
                        vRendered,
                        vertical.index,
                        dx,
                        vertical.containerPx,
                        vMinPx,
                      )
                    : vRendered,
                  vActive,
                )
              : null;
          const hSizes =
            Number.isFinite(dy) &&
            Number.isFinite(horizontal.containerPx) &&
            horizontal.containerPx > 0
              ? storedFractions(
                  hSnapshot,
                  hActive.length > 1
                    ? dragPair(
                        hRendered,
                        horizontal.index,
                        dy,
                        horizontal.containerPx,
                        hMinPx,
                      )
                    : hRendered,
                  hActive,
                )
              : null;
          if (!vSizes && !hSizes) return;
          commit((layout) => {
            let next = layout;
            if (vSizes) next = setSizesOp(next, vertical.splitId, vSizes);
            if (hSizes) next = setSizesOp(next, horizontal.splitId, hSizes);
            return next;
          });
        },
        end: noopDrag,
      };
    },
    [commit],
  );

  const maximizeGroup = useCallback(
    (groupId: string | null) => {
      commit((layout) => maximizeGroupOp(layout, groupId));
    },
    [commit],
  );

  const syncTerminalPanels = useCallback(
    (sessions: { id: string; label: string }[]) => {
      commit((layout) => syncTerminalPanelsOp(layout, sessions));
    },
    [commit],
  );

  const hasPanel = useCallback(
    (panelId: string) => findPanel(layoutRef.current.root, panelId) !== null,
    [],
  );

  const setSidebarWidth = useCallback((width: number) => {
    if (!Number.isFinite(width)) return;
    const clamped = clampSidebarWidth(width);
    setPrefs((prev) =>
      prev.sidebarWidth === clamped ? prev : { ...prev, sidebarWidth: clamped },
    );
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setPrefs((prev) =>
      prev.sidebarCollapsed === collapsed
        ? prev
        : { ...prev, sidebarCollapsed: collapsed },
    );
  }, []);

  return useMemo<WorkbenchLayoutApi>(
    () => ({
      layout: prefs.layout,
      groups,
      activeGroup,
      activePanelId,
      open,
      openPage,
      retargetPage,
      activatePanel,
      activateGroup,
      closePanel,
      pinPanel,
      setPanelLabel,
      movePanel,
      setSizes,
      beginSashDrag,
      beginCornerDrag,
      resetSash,
      maximizeGroup,
      syncTerminalPanels,
      hasPanel,
      sidebarWidth: prefs.sidebarWidth,
      setSidebarWidth,
      sidebarCollapsed: prefs.sidebarCollapsed,
      setSidebarCollapsed,
    }),
    [
      prefs.layout,
      prefs.sidebarWidth,
      prefs.sidebarCollapsed,
      groups,
      activeGroup,
      activePanelId,
      open,
      openPage,
      retargetPage,
      activatePanel,
      activateGroup,
      closePanel,
      pinPanel,
      setPanelLabel,
      movePanel,
      setSizes,
      beginSashDrag,
      beginCornerDrag,
      resetSash,
      maximizeGroup,
      syncTerminalPanels,
      hasPanel,
      setSidebarWidth,
      setSidebarCollapsed,
    ],
  );
}
