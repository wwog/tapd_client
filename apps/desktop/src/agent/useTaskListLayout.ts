import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { readPref, writePref } from "../lib/uiPrefs";
import {
  TASKLIST_CHAT_MIN_WIDTH,
  TASKLIST_DEFAULT_WIDTH,
  TASKLIST_MAX_WIDTH,
  TASKLIST_MIN_WIDTH,
} from "./layout";

/** The session column's width and whether the reader folded it shut. */
const PREF = "agent.tasklist.v1";

type TaskListPref = { width?: number; collapsed?: boolean };

export type TaskListLayout = {
  /** Width the column actually occupies; zero while hidden. */
  width: number;
  /** The Agent pane is too narrow for the preferred width. */
  autoCollapse: boolean;
  /** The session column is currently out of layout. */
  hidden: boolean;
  /** Temporary reveal while auto-collapsed. */
  peek: boolean;
  resizing: boolean;
  /** Footer button: peek while auto-collapsed, otherwise toggle collapse. */
  toggle: () => void;
  /** Drag lifecycle used by the shared `Sash`. */
  beginResize: () => void;
  resize: (delta: number) => void;
  endResize: () => void;
  resetWidth: () => void;
  /** The Agent pane; the auto-collapse decision reads its width. */
  paneRef: RefObject<HTMLDivElement | null>;
};

/**
 * Session column beside the transcript: user width, drag, collapse, and the
 * derived auto-collapse that gives the conversation its space back on a narrow
 * pane. Same contract as `useSidebarLayout` for the project list, but the
 * decision is measured on the Agent pane instead of the window: the pane also
 * shrinks when the workbench opens a group beside it.
 */
export function useTaskListLayout(): TaskListLayout {
  const [stored] = useState<TaskListPref>(
    () => readPref<TaskListPref>(PREF) ?? {},
  );
  const [width, setWidth] = useState(() =>
    Math.max(
      TASKLIST_MIN_WIDTH,
      Math.min(stored.width ?? TASKLIST_DEFAULT_WIDTH, TASKLIST_MAX_WIDTH),
    ),
  );
  const [collapsed, setCollapsed] = useState(stored.collapsed === true);
  /** Temporarily reveals the list even when the pane is too narrow. */
  const [peek, setPeek] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [paneWidth, setPaneWidth] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);

  const persist = useCallback((next: TaskListPref) => {
    writePref(PREF, { ...(readPref<TaskListPref>(PREF) ?? {}), ...next });
  }, []);

  // The pane follows window resizes and workbench splits; coalesce into one
  // update per frame.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() =>
        setPaneWidth(pane.getBoundingClientRect().width),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Below this the column would squeeze the transcript; instead it gets out of
  // the way (a zero measurement is a hidden tab, not a narrow one).
  const autoCollapse =
    paneWidth > 0 && paneWidth < width + TASKLIST_CHAT_MIN_WIDTH;
  // A drag keeps the column on screen even on a narrow pane: the handle lives
  // on that edge, and a list that vanished under the pointer would abort it.
  const hidden = resizing ? false : peek ? false : collapsed || autoCollapse;

  // Drop the temporary reveal once the pane is wide enough again.
  useEffect(() => {
    if (!autoCollapse) setPeek(false);
  }, [autoCollapse]);

  const autoCollapseRef = useRef(autoCollapse);
  autoCollapseRef.current = autoCollapse;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const widthRef = useRef(width);
  widthRef.current = width;

  const toggle = useCallback(() => {
    if (autoCollapseRef.current) setPeek((current) => !current);
    else {
      const next = !collapsedRef.current;
      setCollapsed(next);
      persist({ collapsed: next });
    }
  }, [persist]);

  const startWidthRef = useRef(TASKLIST_MIN_WIDTH);
  const dragWidthRef = useRef(width);
  const paneWidthRef = useRef(paneWidth);
  paneWidthRef.current = paneWidth;

  const beginResize = useCallback(() => {
    setResizing(true);
    // The peek (a temporary reveal on a narrow pane) is left alone: the drag
    // starts on the visible edge and the column stays there afterwards.
    if (collapsedRef.current) {
      setCollapsed(false);
      persist({ collapsed: false });
      startWidthRef.current = TASKLIST_MIN_WIDTH;
    } else {
      startWidthRef.current = widthRef.current;
    }
    dragWidthRef.current = startWidthRef.current;
  }, [persist]);

  const resize = useCallback(
    (delta: number) => {
      // Never drag past the point where the pane would auto-collapse: the
      // column must not vanish under the pointer mid-drag.
      const cap = Math.max(
        TASKLIST_MIN_WIDTH,
        Math.min(
          TASKLIST_MAX_WIDTH,
          paneWidthRef.current - TASKLIST_CHAT_MIN_WIDTH,
        ),
      );
      const next = Math.max(
        0,
        Math.min(cap, startWidthRef.current + delta),
      );
      // Dragged past the minimum: the column gives up instead of staying a
      // sliver that can neither show a title nor be dragged back out.
      if (next < TASKLIST_MIN_WIDTH) {
        dragWidthRef.current = 0;
        return;
      }
      dragWidthRef.current = next;
      setWidth(next);
    },
    [],
  );

  const endResize = useCallback(() => {
    setResizing(false);
    if (dragWidthRef.current < TASKLIST_MIN_WIDTH) {
      setCollapsed(true);
      setWidth(TASKLIST_DEFAULT_WIDTH);
      persist({ collapsed: true, width: TASKLIST_DEFAULT_WIDTH });
      return;
    }
    persist({ width: dragWidthRef.current });
  }, [persist]);

  const resetWidth = useCallback(() => {
    setCollapsed(false);
    setPeek(false);
    setWidth(TASKLIST_DEFAULT_WIDTH);
    persist({ collapsed: false, width: TASKLIST_DEFAULT_WIDTH });
  }, [persist]);

  return {
    width: hidden ? 0 : width,
    autoCollapse,
    hidden,
    peek,
    resizing,
    toggle,
    beginResize,
    resize,
    endResize,
    resetWidth,
    paneRef,
  };
}
