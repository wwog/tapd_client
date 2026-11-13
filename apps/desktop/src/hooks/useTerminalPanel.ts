import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { ToastFn } from "../lib/feature";
import { t } from "../lib/i18n";
import {
  terminalApi,
  type TerminalExitPayload,
  type TerminalMeta,
  type TerminalSessionsPayload,
} from "../lib/terminal";
import { useTauriEvent } from "../lib/tauriEvent";
import { readPref, writePref } from "../lib/uiPrefs";
import { useVerticalDragResize } from "./useDragResize";

/** Preference key: panel visibility and card height, restored on startup. */
export const TERMINAL_PANEL_PREF = "terminal.panel.v1";
export const TERMINAL_DEFAULT_HEIGHT = 280;
export const TERMINAL_MIN_HEIGHT = 140;
/** Backstop so repeated clicks cannot spawn an unbounded number of PTYs. */
export const TERMINAL_MAX_SESSIONS = 8;
/** Matches the 300ms height transition plus a frame before unmounting. */
const CLOSE_ANIMATION_MS = 320;

type PanelPrefs = { open: boolean; height: number };

/** Upper bound the user can drag to: most of the window, never the whole one. */
const maxPanelHeight = (): number =>
  Math.round((typeof window === "undefined" ? 900 : window.innerHeight) * 0.7);

const clampHeight = (value: number): number => {
  const next = Number.isFinite(value) ? value : TERMINAL_DEFAULT_HEIGHT;
  return Math.round(
    Math.min(Math.max(next, TERMINAL_MIN_HEIGHT), Math.max(TERMINAL_MIN_HEIGHT, maxPanelHeight())),
  );
};

export type UseTerminalPanelOptions = {
  /** Project whose configured folder new terminals open in; empty when none. */
  workspaceId: string;
  showToast: ToastFn;
};

export type TerminalPanelState = {
  /** User intent: the panel is open (or animating open). */
  open: boolean;
  /** Kept true through the close animation; false unmounts the panel. */
  rendered: boolean;
  /** Card height in px, already clamped. */
  height: number;
  resizing: boolean;
  sessions: TerminalMeta[];
  activeId: string | null;
  /** Header button and ⌘J: opens (spawning when empty) or hides. */
  toggle: () => void;
  close: () => void;
  setActive: (id: string) => void;
  create: () => void;
  closeSession: (id: string) => void;
  restart: (session: TerminalMeta) => void;
  startResize: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

/**
 * Bottom terminal panel: visibility, height and the backend sessions it shows.
 *
 * The drawer half only animates; the sessions are owned by the backend so a
 * phone can create or close one and the tab list follows `terminal://sessions`.
 * A restored (startup) panel does not spawn a shell — the user sees the empty
 * state instead, so an app start never leaves stray PTYs behind.
 */
export function useTerminalPanel({
  workspaceId,
  showToast,
}: UseTerminalPanelOptions): TerminalPanelState {
  const [stored] = useState(() => readPref<Partial<PanelPrefs>>(TERMINAL_PANEL_PREF));
  const [open, setOpen] = useState(stored?.open === true);
  const [rendered, setRendered] = useState(stored?.open === true);
  const [height, setHeight] = useState(() =>
    clampHeight(typeof stored?.height === "number" ? stored.height : TERMINAL_DEFAULT_HEIGHT),
  );
  const [resizing, setResizing] = useState(false);
  const [sessions, setSessions] = useState<TerminalMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  const openRef = useRef(open);
  openRef.current = open;
  const heightRef = useRef(height);
  heightRef.current = height;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const closeTimer = useRef<number | null>(null);
  /** Bumped on every show/hide so a late animation frame cannot reopen. */
  const toggleToken = useRef(0);
  /** The first list read finished (successfully or not); before that we cannot
   *  tell an empty panel from one whose sessions are still loading. */
  const listed = useRef(false);
  /** A `terminal://sessions` push already arrived, so it is newer than the
   *  initial list request and the list response must not overwrite it. */
  const synced = useRef(false);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  /**
   * Opens the panel. A first open mounts at zero height and grows on the next
   * frame, so the height transition starts from a painted value (the same
   * two-frame trick the detail pane uses for its width).
   */
  const show = useCallback(() => {
    const token = ++toggleToken.current;
    clearCloseTimer();
    if (renderedRef.current) {
      setOpen(true);
      return;
    }
    setRendered(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (token === toggleToken.current) setOpen(true);
      });
    });
  }, [clearCloseTimer]);

  const hide = useCallback(() => {
    ++toggleToken.current;
    setOpen(false);
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setRendered(false);
    }, CLOSE_ANIMATION_MS);
  }, [clearCloseTimer]);

  /** Creates a session, or reports why it could not (cap and backend errors). */
  const spawn = useCallback(
    async (
      request: { cwd?: string },
      replacingId?: string,
    ): Promise<TerminalMeta | null> => {
      const kept = sessionsRef.current.filter((session) => session.id !== replacingId);
      if (kept.length >= TERMINAL_MAX_SESSIONS) {
        showToast("error", t("terminal.limit"));
        return null;
      }
      try {
        const { session } = await terminalApi.create({
          ...(workspaceId ? { workspaceId } : {}),
          ...(request.cwd ? { cwd: request.cwd } : {}),
        });
        // `terminal://sessions` carries the same session; adding it here makes
        // the new tab appear the moment the spawn resolves.
        setSessions((current) =>
          current.some((item) => item.id === session.id) ? current : [...current, session],
        );
        setActiveId(session.id);
        return session;
      } catch (error) {
        // The backend message is already user-facing ("无法启动终端：…"), so it
        // is shown verbatim instead of being wrapped a second time.
        showToast("error", String(error));
        return null;
      }
    },
    [showToast, workspaceId],
  );

  // Restored sessions are reused across panel closes; the initial list is what
  // makes a reopen show the previous tabs instead of an empty panel.
  useEffect(() => {
    void terminalApi
      .list()
      .then(({ sessions: list }) => {
        // A create/close event can land while this read is in flight; it is
        // newer than the response, so the stale snapshot must not drop a tab.
        if (!synced.current) setSessions(list);
      })
      .catch(() => showToast("error", t("terminal.loadFailed")))
      .finally(() => {
        listed.current = true;
      });
  }, [showToast]);

  useTauriEvent<TerminalSessionsPayload>("terminal://sessions", ({ sessions: list }) => {
    synced.current = true;
    setSessions(list);
  });

  useTauriEvent<TerminalExitPayload>("terminal://exit", ({ id, code }) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === id
          ? // A process that ended without a code is still exited; -1 means unknown.
            { ...session, exited: code ?? -1 }
          : session,
      ),
    );
  });

  useEffect(() => {
    writePref(TERMINAL_PANEL_PREF, { open, height });
  }, [open, height]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  // The height cap is relative to the window; a shrunken window must not leave
  // the panel covering most of the terminal area until the app restarts.
  useEffect(() => {
    const onResize = () => setHeight((current) => clampHeight(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const create = useCallback(() => {
    void spawn({});
  }, [spawn]);

  const closeSession = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await terminalApi.close(id);
      } catch (error) {
        showToast("error", String(error));
        return false;
      }
      const list = sessionsRef.current;
      const index = list.findIndex((session) => session.id === id);
      // Fall to the next tab, then the previous one; the derived id below picks
      // the first session when a change arrives from another window.
      const neighbor = list[index + 1] ?? list[index - 1] ?? null;
      setSessions((current) => current.filter((session) => session.id !== id));
      setActiveId((current) => (current === id ? (neighbor?.id ?? null) : current));
      return true;
    },
    [showToast],
  );

  /**
   * Replaces a dead session with a fresh shell in the same directory. The old
   * session is closed first: the backend caps *live* sessions, so creating
   * before closing would answer "limit reached" when every tab is used.
   */
  const restart = useCallback(
    (session: TerminalMeta) => {
      void (async () => {
        if (!(await closeSession(session.id))) return;
        await spawn({ cwd: session.cwd }, session.id);
      })();
    },
    [closeSession, spawn],
  );

  const toggle = useCallback(() => {
    if (openRef.current) {
      hide();
      return;
    }
    show();
    // This is a user action, so an empty panel starts a shell right away. The
    // startup restore takes the other path: it leaves the empty state in place.
    if (listed.current && sessionsRef.current.length === 0) void spawn({});
  }, [hide, show, spawn]);

  const startResize = useVerticalDragResize(() => {
    const startHeight = heightRef.current;
    setResizing(true);
    return {
      // Dragging the top edge upward (negative delta) grows the panel.
      onMove: (delta) => setHeight(clampHeight(startHeight - delta)),
      onEnd: () => setResizing(false),
    };
  });

  const active =
    activeId !== null && sessions.some((session) => session.id === activeId)
      ? activeId
      : (sessions[0]?.id ?? null);

  return {
    open,
    rendered,
    height,
    resizing,
    sessions,
    activeId: active,
    toggle,
    close: hide,
    setActive: setActiveId,
    create,
    closeSession: (id) => void closeSession(id),
    restart,
    startResize,
  };
}
