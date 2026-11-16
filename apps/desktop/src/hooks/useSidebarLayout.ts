import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  defaultSidebarWidth,
} from "../workbench/layout/defaults";

// Sizing lives with the layout contract; re-exported for the shell files that
// already imported these names from the hook.
export { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, defaultSidebarWidth };

/** Icon rail width. */
export const RAIL_WIDTH = 52;
/** Rail + panel margins (with a small resize buffer). */
export const LAYOUT_GUTTER = 32;

export type SidebarLayoutOptions = {
  projectListHidden: boolean;
  /** Persisted width owned by the workbench layout. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  /**
   * Width the layout area needs beside the side bar: primary group minimum
   * plus the secondary group's minimum when it has panels.
   */
  contentMinWidth: number;
  /**
   * Width the window is growing to (programmatic resize). Collapse decisions
   * use it until the real viewport catches up, so filling a dock does not hide
   * the column for the frame before the resize lands.
   */
  pendingViewportWidth?: number | null;
};

export type SidebarLayout = {
  viewportWidth: number;
  /** Sidebar width the user chose (or the default), before auto-collapse. */
  expandedWidth: number;
  /** Width the column actually occupies; zero while hidden. */
  effectiveWidth: number;
  /** The window is too narrow for the preferred width. */
  autoCollapse: boolean;
  /** The whole project column is currently out of layout. */
  hidden: boolean;
  /** Temporary reveal while auto-collapsed. */
  peek: boolean;
  resizing: boolean;
  /** Header button: peek while auto-collapsed, otherwise toggle collapse. */
  toggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setPeek: (peek: boolean) => void;
  /** Current rendered width, readable from stable callbacks. */
  getEffectiveWidth: () => number;
  /** Drag lifecycle used by the shared `Sash`. */
  beginResize: () => void;
  resize: (delta: number) => void;
  endResize: () => void;
  resetWidth: () => void;
};

/**
 * Project-list column: collapse, temporary peek, preferred width and the
 * derived auto-collapse used on narrow windows. The width itself is persisted
 * by the workbench layout; the drag is the shared `Sash` component.
 */
export function useSidebarLayout({
  projectListHidden,
  sidebarWidth,
  setSidebarWidth,
  contentMinWidth,
  pendingViewportWidth = null,
}: SidebarLayoutOptions): SidebarLayout {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** Temporarily reveals the project list even when the window is too narrow. */
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [resizingSidebar, setResizingSidebar] = useState(false);

  // The sidebar follows the window for auto-collapse decisions; coalesce
  // resize events into one update per frame.
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewportWidth(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const expandedSidebarWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(sidebarWidth, MAX_SIDEBAR_WIDTH),
  );

  // On narrow windows the project list yields instead of squeezing the layout.
  // The comparison uses the secondary group's minimum, so opening a detail
  // panel collapses the list before the bug list gets unusable. A window that
  // is being grown for that panel counts at its target width: the column must
  // not blink out while the resize is in flight.
  const decisionViewportWidth =
    pendingViewportWidth !== null && pendingViewportWidth > viewportWidth
      ? pendingViewportWidth
      : viewportWidth;
  const autoCollapseSidebar =
    decisionViewportWidth <
    RAIL_WIDTH +
      expandedSidebarWidth +
      contentMinWidth +
      LAYOUT_GUTTER;
  const sidebarHidden =
    projectListHidden ||
    (sidebarPeek ? false : sidebarCollapsed || autoCollapseSidebar);

  // Drop the temporary reveal once the window is wide enough again.
  useEffect(() => {
    if (!autoCollapseSidebar) setSidebarPeek(false);
  }, [autoCollapseSidebar]);

  // Never let the sidebar eat the layout area on a narrow window.
  const effectiveSidebarWidth = sidebarHidden
    ? 0
    : Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(
          sidebarWidth,
          decisionViewportWidth - RAIL_WIDTH - contentMinWidth,
        ),
      );

  const autoCollapseRef = useRef(autoCollapseSidebar);
  autoCollapseRef.current = autoCollapseSidebar;
  const effectiveWidthRef = useRef(effectiveSidebarWidth);
  effectiveWidthRef.current = effectiveSidebarWidth;
  const viewportRef = useRef(viewportWidth);
  viewportRef.current = viewportWidth;
  const collapsedRef = useRef(sidebarCollapsed);
  collapsedRef.current = sidebarCollapsed;
  const startWidthRef = useRef(MIN_SIDEBAR_WIDTH);
  const dragWidthRef = useRef(effectiveSidebarWidth);

  const toggle = useCallback(() => {
    if (autoCollapseRef.current) setSidebarPeek((current) => !current);
    else setSidebarCollapsed((current) => !current);
  }, []);

  const getEffectiveWidth = useCallback(() => effectiveWidthRef.current, []);

  const beginResize = useCallback(() => {
    setResizingSidebar(true);
    if (collapsedRef.current) setSidebarCollapsed(false);
    startWidthRef.current = collapsedRef.current
      ? MIN_SIDEBAR_WIDTH
      : effectiveWidthRef.current;
    dragWidthRef.current = startWidthRef.current;
  }, []);

  const resize = useCallback(
    (delta: number) => {
      const next = Math.max(
        0,
        Math.min(MAX_SIDEBAR_WIDTH, startWidthRef.current + delta),
      );
      // Below the minimum the sidebar gives up and collapses.
      if (next < MIN_SIDEBAR_WIDTH) {
        setSidebarCollapsed(true);
        setSidebarPeek(false);
        setSidebarWidth(defaultSidebarWidth(viewportRef.current));
        return;
      }
      dragWidthRef.current = next;
      setSidebarWidth(next);
    },
    [setSidebarWidth],
  );

  const endResize = useCallback(() => {
    setResizingSidebar(false);
    if (dragWidthRef.current < MIN_SIDEBAR_WIDTH) {
      setSidebarCollapsed(true);
      return;
    }
    setSidebarWidth(dragWidthRef.current);
  }, [setSidebarWidth]);

  const resetWidth = useCallback(() => {
    setSidebarCollapsed(false);
    setSidebarPeek(false);
    setSidebarWidth(defaultSidebarWidth(viewportRef.current));
  }, [setSidebarWidth]);

  return {
    viewportWidth,
    expandedWidth: expandedSidebarWidth,
    effectiveWidth: effectiveSidebarWidth,
    autoCollapse: autoCollapseSidebar,
    hidden: sidebarHidden,
    peek: sidebarPeek,
    resizing: resizingSidebar,
    toggle,
    setCollapsed: setSidebarCollapsed,
    setPeek: setSidebarPeek,
    getEffectiveWidth,
    beginResize,
    resize,
    endResize,
    resetWidth,
  };
}
