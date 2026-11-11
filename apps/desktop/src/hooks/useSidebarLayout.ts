import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useDragResize } from "./useDragResize";

// Project sidebar sizing. Dragging below the minimum collapses it.
export const MIN_SIDEBAR_WIDTH = 168;
export const MAX_SIDEBAR_WIDTH = 300;
/** Content area that must stay usable; the sidebar yields space below this. */
export const MIN_CONTENT_WIDTH = 460;
/** Codex-style right detail pane. */
export const DETAIL_PANEL_WIDTH = 520;
export const DETAIL_MIN_WIDTH = 360;
export const DETAIL_MAX_WIDTH = 760;
/** Minimum width the bug list keeps while the detail pane is open. */
export const DETAIL_CONTENT_MIN = 340;
/** Rail + sidebar gap + panel margins (with a small resize buffer). */
export const LAYOUT_GUTTER = 32;
/** Icon rail width. */
export const RAIL_WIDTH = 52;

/** Default sidebar width for the current window: compact, project names are short. */
export const defaultSidebarWidth = (viewport: number): number =>
  Math.round(Math.min(Math.max(viewport * 0.15, 176), 208));

/** Window width needed to keep the list usable beside an open detail pane. */
export const requiredWidth = (sidebarWidth: number, detailWidth: number): number =>
  RAIL_WIDTH + sidebarWidth + DETAIL_CONTENT_MIN + detailWidth + LAYOUT_GUTTER;

export type SidebarLayoutOptions = {
  projectListHidden: boolean;
  detailRendered: boolean;
  detailWidth: number;
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
  startResize: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

/**
 * Project-list column: collapse, temporary peek, preferred width and the
 * derived auto-collapse used on narrow windows.
 */
export function useSidebarLayout({
  projectListHidden,
  detailRendered,
  detailWidth,
}: SidebarLayoutOptions): SidebarLayout {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => defaultSidebarWidth(1280));
  const [sidebarSized, setSidebarSized] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** Temporarily reveals the project list even when the window is too narrow. */
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [resizingSidebar, setResizingSidebar] = useState(false);

  // The sidebar follows the window until the user drags it once. Coalesce
  // resize events into one update per frame; window expansion fires many.
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

  useEffect(() => {
    if (sidebarSized) return;
    setSidebarWidth(defaultSidebarWidth(viewportWidth));
  }, [viewportWidth, sidebarSized]);

  /** Sidebar width the user chose (or the default), before auto-collapse. */
  const expandedSidebarWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(sidebarWidth, MAX_SIDEBAR_WIDTH),
  );

  // On narrow windows the project list yields instead of squeezing the bug
  // list. This is derived state: the list comes back when there is room again.
  const autoCollapseSidebar =
    viewportWidth <
    RAIL_WIDTH +
      expandedSidebarWidth +
      (detailRendered ? DETAIL_CONTENT_MIN + detailWidth : MIN_CONTENT_WIDTH) +
      LAYOUT_GUTTER;
  const sidebarHidden =
    projectListHidden ||
    (sidebarPeek ? false : sidebarCollapsed || autoCollapseSidebar);

  // Drop the temporary reveal once the window is wide enough again.
  useEffect(() => {
    if (!autoCollapseSidebar) setSidebarPeek(false);
  }, [autoCollapseSidebar]);

  // Never let the sidebar eat the content area on a narrow window.
  const effectiveSidebarWidth = sidebarHidden
    ? 0
    : Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(sidebarWidth, viewportWidth - RAIL_WIDTH - MIN_CONTENT_WIDTH),
      );

  const autoCollapseRef = useRef(autoCollapseSidebar);
  autoCollapseRef.current = autoCollapseSidebar;
  const effectiveWidthRef = useRef(effectiveSidebarWidth);
  effectiveWidthRef.current = effectiveSidebarWidth;

  const toggle = useCallback(() => {
    if (autoCollapseRef.current) setSidebarPeek((current) => !current);
    else setSidebarCollapsed((current) => !current);
  }, []);

  const getEffectiveWidth = useCallback(
    () => effectiveWidthRef.current,
    [],
  );

  const startResize = useDragResize(() => {
    const startWidth = sidebarCollapsed ? 0 : effectiveSidebarWidth;
    setSidebarSized(true);
    if (sidebarCollapsed) {
      // Dragging out of the collapsed state starts from the minimum width.
      setSidebarCollapsed(false);
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    }
    setResizingSidebar(true);

    return {
      onMove: (deltaX, stop) => {
        const next = Math.max(
          0,
          Math.min(MAX_SIDEBAR_WIDTH, startWidth + deltaX),
        );
        // Below the minimum the sidebar gives up and collapses with a transition.
        if (next < MIN_SIDEBAR_WIDTH) {
          stop();
          setResizingSidebar(false);
          setSidebarCollapsed(true);
          setSidebarSized(false);
          setSidebarWidth(defaultSidebarWidth(viewportWidth));
          return;
        }
        setSidebarWidth(next);
      },
      onEnd: () => {
        setResizingSidebar(false);
        setSidebarWidth((width) => Math.max(MIN_SIDEBAR_WIDTH, width));
      },
    };
  });

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
    startResize,
  };
}
