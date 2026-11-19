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
import { t } from "../lib/i18n";
import { shellBootstrap, type ShellBootstrap } from "../lib/shellBootstrap";
import { useTauriEvent } from "../lib/tauriEvent";
import type { View } from "../components/ActivityBar";

/** Starting project, picked the same way the first `loadContext` does. */
function initialWorkspaceId({ info, context }: ShellBootstrap): string {
  if (!context) return "";
  const hidden = new Set(info?.hiddenWorkspaceIds ?? []);
  const visible = context.workspaces.filter((item) => !hidden.has(item.id));
  const lastId = info?.lastWorkspaceId;
  if (lastId && visible.some((item) => item.id === lastId)) return lastId;
  return visible[0]?.id ?? context.workspaces[0]?.id ?? "";
}

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
  /** Active page view; `null` while the welcome page is showing. */
  view: View | null;
  /** Opens a TAPD project's page tab (notification jumps carry their own id). */
  openWorkspacePage: (workspaceId: string) => void;
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
  openWorkspacePage,
  showToast,
  pane,
}: WorkspaceDataOptions) {
  // `main.tsx` reads the same snapshots before the first render, so the shell
  // already knows the session and the project list on its first frame.
  const bootstrap = shellBootstrap();
  const [info, setInfo] = useState<AppInfo | null>(bootstrap.info);
  const [context, setContext] = useState<WorkspaceContext | null>(bootstrap.context);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState(() =>
    initialWorkspaceId(bootstrap),
  );
  const [refreshToken, setRefreshToken] = useState(0);
  /** Locally hidden TAPD projects (persisted in config.json). */
  const [hiddenWorkspaceIds, setHiddenWorkspaceIds] = useState<string[]>(
    () => bootstrap.info?.hiddenWorkspaceIds ?? [],
  );
  const hiddenInitializedRef = useRef(false);
  /** A bootstrapped cache snapshot still needs one live refresh on this entry. */
  const contextRefreshPendingRef = useRef(bootstrap.context !== null);
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
      // The notification owns the target project: open its tab directly (a
      // `setView("bugs")` would still see the previous selection).
      openWorkspacePage(targetWorkspaceId);
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
    if (info?.loggedIn) {
      // The bootstrapped cache snapshot paints immediately; the live list still
      // loads once per entry so offline data never stays stale for the session.
      if (
        !contextLoading &&
        !contextError &&
        (!context || contextRefreshPendingRef.current)
      ) {
        contextRefreshPendingRef.current = false;
        void loadContext();
      }
      return;
    }
    // Wait for `app_info`: a bootstrapped snapshot must not be dropped while
    // the session check is still in flight.
    if (!info) return;
    setContext(null);
    setContextError(null);
    setWorkspaceId("");
  }, [info, context, contextLoading, contextError, loadContext]);

  const visibleWorkspaces = useMemo(
    () =>
      (context?.workspaces ?? []).filter(
        (workspace) => !hiddenWorkspaceIds.includes(workspace.id),
      ),
    [context, hiddenWorkspaceIds],
  );
  /** Whether the project list has resolved at least once (cold start). */
  const projectsKnown = context !== null || contextError !== null;

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
      showToast("error", t("app.projects.keepOne"));
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
        // The hidden project's tab must not stay in front: show the survivor.
        openWorkspacePage(replacement.id);
        void api.setLastWorkspace(replacement.id);
      }
    }
  };

  const hideWorkspace = (id: string) => {
    // The context menu closes itself (with its exit animation), so do not
    // unmount it here.
    setWorkspaceVisible(id, false);
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
        // `performLogout` already closed the session's project tabs; whatever
        // remains (global pages, or the welcome page) stays as the user left it.
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
    workspace,
    setWorkspaceVisible,
    hideWorkspace,
    handleLogout,
  };
}
