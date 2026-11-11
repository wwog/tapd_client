import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  api,
  onSessionChanged,
  setMediaEndpoint,
  type AppInfo,
  type WorkspaceContext,
} from "../lib/api";
import { cacheApi } from "../lib/cache";
import type { ToastFn } from "../lib/feature";
import { useTauriEvent } from "../lib/tauriEvent";
import type { View } from "../components/NavRail";

export type ProjectMenu = {
  id: string;
  name: string;
  x: number;
  y: number;
};

/** Detail-pane actions the workspace layer calls at event time. */
export type WorkspacePaneBridge = {
  loadBugDetail: (workspaceId: string, bugId: string) => void;
  closeDetail: () => void;
};

export type WorkspaceDataOptions = {
  view: View;
  setView: (view: View) => void;
  showToast: ToastFn;
  pane: RefObject<WorkspacePaneBridge>;
};

/**
 * Workspace/session data: app info, the TAPD workspace context, the selected
 * project, locally hidden projects, the list refresh token and the Tauri events
 * that keep them in sync. Also owns the project context-menu state.
 */
export function useWorkspaceData({
  view,
  setView,
  showToast,
  pane,
}: WorkspaceDataOptions) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  /** Locally hidden TAPD projects (persisted in config.json). */
  const [hiddenWorkspaceIds, setHiddenWorkspaceIds] = useState<string[]>([]);
  const hiddenInitializedRef = useRef(false);
  /** Right-click context menu for a project row. */
  const [projectMenu, setProjectMenu] = useState<ProjectMenu | null>(null);

  const infoRef = useRef<AppInfo | null>(null);
  infoRef.current = info;
  /** Hidden ids readable from the stable `loadContext` callback. */
  const hiddenWorkspaceIdsRef = useRef<string[]>([]);
  hiddenWorkspaceIdsRef.current = hiddenWorkspaceIds;

  const bumpList = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  const refreshBase = useCallback(async () => {
    try {
      const nextInfo = await api.appInfo();
      setInfo(nextInfo);
      setMediaEndpoint(nextInfo);
    } catch (error) {
      showToast("error", String(error));
    }
  }, [showToast]);

  const loadContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);

    // Offline-first: render the last snapshot immediately (unless the user
    // already has newer data in memory), then refresh in the background.
    let hasCache = false;
    try {
      const cached = await cacheApi.workspaceContext();
      if (cached.data) {
        hasCache = true;
        const next = cached.data;
        setContext((current) => current ?? next);
        if (next.user.nick) {
          void api.setCurrentUser(next.user.nick);
        }
        const lastId = infoRef.current?.lastWorkspaceId;
        const hidden = new Set([
          ...(infoRef.current?.hiddenWorkspaceIds ?? []),
          ...hiddenWorkspaceIdsRef.current,
        ]);
        const visible = next.workspaces.filter((item) => !hidden.has(item.id));
        setWorkspaceId((current) => {
          if (current) return current;
          if (lastId && visible.some((item) => item.id === lastId)) return lastId;
          return visible[0]?.id ?? next.workspaces[0]?.id ?? "";
        });
      }
    } catch {
      // A missing cache is not an error; the live request below decides.
    }

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const next = await api.workspaceContext();
          setContext(next);
          // The identity payload also refreshes the cached avatar, so re-read
          // app_info now that the backend has written it.
          void refreshBase();
          if (next.user.nick) {
            void api.setCurrentUser(next.user.nick);
          }
          const lastId = infoRef.current?.lastWorkspaceId;
          const hidden = new Set([
            ...(infoRef.current?.hiddenWorkspaceIds ?? []),
            ...hiddenWorkspaceIdsRef.current,
          ]);
          const visible = next.workspaces.filter((item) => !hidden.has(item.id));
          setWorkspaceId((current) => {
            if (current) return current;
            if (lastId && visible.some((item) => item.id === lastId)) return lastId;
            return visible[0]?.id ?? next.workspaces[0]?.id ?? "";
          });
          return;
        } catch (error) {
          if (attempt === 2) {
            // Keep offline data on screen instead of replacing it with an error.
            if (!hasCache) setContextError(String(error));
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      }
    } finally {
      setContextLoading(false);
    }
  }, [refreshBase]);

  // Load hidden projects once from config.json. The UI is the source of truth
  // afterwards, so a background `app_info` refresh cannot revert a fresh toggle.
  useEffect(() => {
    if (hiddenInitializedRef.current || !info) return;
    hiddenInitializedRef.current = true;
    setHiddenWorkspaceIds(info.hiddenWorkspaceIds ?? []);
  }, [info]);

  // Dismiss the project context menu on any outside click / Escape.
  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenu]);

  // Entering the account view refreshes the identity/session snapshot, so a
  // changed company/name (or a newly cached avatar) shows up immediately.
  useEffect(() => {
    if (view !== "account") return;
    void refreshBase();
    void loadContext();
  }, [view, refreshBase, loadContext]);

  useEffect(() => {
    void refreshBase();
    const unlisteners: Array<() => void> = [];
    void onSessionChanged(() => {
      void refreshBase();
      setRefreshToken((token) => token + 1);
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [refreshBase]);

  useTauriEvent<{ workspaceId: string; bugId: string }>(
    "notification://open-bug",
    (payload) => {
      const { workspaceId: targetWorkspaceId, bugId } = payload;
      setView("bugs");
      setWorkspaceId(targetWorkspaceId);
      void api.setLastWorkspace(targetWorkspaceId);
      pane.current.loadBugDetail(targetWorkspaceId, bugId);
    },
  );

  useTauriEvent(
    "data://refresh",
    () => {
      setRefreshToken((token) => token + 1);
      void refreshBase();
    },
    [refreshBase],
  );

  useEffect(() => {
    if (info?.loggedIn && !context && !contextLoading && !contextError) {
      void loadContext();
    }
    if (!info?.loggedIn) {
      setContext(null);
      setContextError(null);
      setWorkspaceId("");
    }
  }, [info?.loggedIn, context, contextLoading, contextError, loadContext]);

  const visibleWorkspaces = useMemo(
    () =>
      (context?.workspaces ?? []).filter(
        (workspace) => !hiddenWorkspaceIds.includes(workspace.id),
      ),
    [context, hiddenWorkspaceIds],
  );
  /** Whether the project list has resolved enough to decide its layout. */
  const projectsKnown = context !== null || contextError !== null;
  /**
   * With a single visible project the list column is pointless. Unknown counts
   * stay hidden too: deciding after the context request would flash the column
   * and then collapse it on every single-project start.
   */
  const projectListHidden = !projectsKnown || visibleWorkspaces.length === 1;

  const workspace =
    context?.workspaces.find((item) => item.id === workspaceId) ?? null;

  const updateHiddenWorkspaces = async (next: string[], previous: string[]) => {
    setHiddenWorkspaceIds(next);
    try {
      await api.setHiddenWorkspaces(next);
    } catch (error) {
      setHiddenWorkspaceIds(previous);
      showToast("error", String(error));
    }
  };

  const setWorkspaceVisible = (id: string, visible: boolean) => {
    if (visible) {
      if (!hiddenWorkspaceIds.includes(id)) return;
      void updateHiddenWorkspaces(
        hiddenWorkspaceIds.filter((candidate) => candidate !== id),
        hiddenWorkspaceIds,
      );
      return;
    }

    if (visibleWorkspaces.length <= 1) {
      showToast("error", "至少保留一个项目");
      return;
    }
    if (hiddenWorkspaceIds.includes(id)) return;

    const next = [...hiddenWorkspaceIds, id];
    void updateHiddenWorkspaces(next, hiddenWorkspaceIds);
    if (workspaceId === id) {
      const replacement = visibleWorkspaces.find((item) => item.id !== id);
      if (replacement) {
        pane.current.closeDetail();
        setWorkspaceId(replacement.id);
        void api.setLastWorkspace(replacement.id);
      }
    }
  };

  const hideWorkspace = (id: string) => {
    setWorkspaceVisible(id, false);
    setProjectMenu(null);
  };

  const handleLogout = () => {
    // No `window.confirm` here: WKWebView has no confirm panel delegate in the
    // Tauri window, so the callback always resolved to `false` and the button
    // appeared dead. Logging out is reversible (scan the QR again).
    void (async () => {
      try {
        await api.logout();
        setContext(null);
        setWorkspaceId("");
        pane.current.closeDetail();
        setView("bugs");
        await refreshBase();
      } catch (error) {
        showToast("error", String(error));
      }
    })();
  };

  return {
    info,
    context,
    contextLoading,
    contextError,
    workspaceId,
    setWorkspaceId,
    loadContext,
    refreshBase,
    refreshToken,
    bumpList,
    hiddenWorkspaceIds,
    projectMenu,
    setProjectMenu,
    visibleWorkspaces,
    projectsKnown,
    projectListHidden,
    workspace,
    setWorkspaceVisible,
    hideWorkspace,
    handleLogout,
  };
}
