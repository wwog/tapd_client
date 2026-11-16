import { useCallback, useEffect, useRef, useState } from "react";

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

/** Preference key: panel visibility, restored on startup (`{ open }`). */
export const TERMINAL_PANEL_PREF = "terminal.panel.v1";
/** Backstop so repeated clicks cannot spawn an unbounded number of PTYs. */
export const TERMINAL_MAX_SESSIONS = 8;

type PanelPrefs = { open: boolean };

export type UseTerminalPanelOptions = {
  /** Project whose configured folder new terminals open in; empty when none. */
  workspaceId: string;
  showToast: ToastFn;
};

export type TerminalPanelState = {
  /** User intent: terminal panels are hidden from the workbench. */
  hidden: boolean;
  sessions: TerminalMeta[];
  /** Session the user touched last; used when focusing the bottom dock. */
  activeId: string | null;
  create: () => void;
  closeSession: (id: string) => void;
  restart: (session: TerminalMeta) => void;
  show: () => void;
  hide: () => void;
};

/**
 * Backend-owned terminal sessions plus the persisted visibility flag.
 *
 * Visibility lives here, not in the layout: hiding the terminal removes its
 * panels (App syncs layout ↔ sessions) while the PTYs stay alive, so reopening
 * restores every tab. The backend is authoritative for the session list — a
 * phone can create or close one and the tabs follow `terminal://sessions`.
 */
export function useTerminalPanel({
  workspaceId,
  showToast,
}: UseTerminalPanelOptions): TerminalPanelState {
  const [stored] = useState(() => readPref<Partial<PanelPrefs>>(TERMINAL_PANEL_PREF));
  const [hidden, setHidden] = useState(stored?.open !== true);
  const [sessions, setSessions] = useState<TerminalMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /** A `terminal://sessions` push already arrived, so it is newer than the
   *  initial list request and the list response must not overwrite it. */
  const synced = useRef(false);

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

  // Restored sessions are reused across hides; the initial list is what makes
  // a reopen show the previous tabs instead of an empty dock.
  useEffect(() => {
    void terminalApi
      .list()
      .then(({ sessions: list }) => {
        // A create/close event can land while this read is in flight; it is
        // newer than the response, so the stale snapshot must not drop a tab.
        if (!synced.current) setSessions(list);
      })
      .catch(() => showToast("error", t("terminal.loadFailed")));
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
    writePref(TERMINAL_PANEL_PREF, { open: !hidden });
  }, [hidden]);

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

  const show = useCallback(() => setHidden(false), []);
  const hide = useCallback(() => setHidden(true), []);

  const active =
    activeId !== null && sessions.some((session) => session.id === activeId)
      ? activeId
      : (sessions[0]?.id ?? null);

  return {
    hidden,
    sessions,
    activeId: active,
    create,
    closeSession: (id) => void closeSession(id),
    restart,
    show,
    hide,
  };
}
