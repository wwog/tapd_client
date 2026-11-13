import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  api,
  type BugDetail,
  type BugSummary,
  type ExportResult,
  type WorkspaceContext,
  type WorkspaceMember,
} from "../lib/api";
import { cacheApi } from "../lib/cache";
import type { ToastFn } from "../lib/feature";
import { t } from "../lib/i18n";
import { ensureMembers, useMembers } from "../lib/members";
import {
  DETAIL_MAX_WIDTH,
  DETAIL_MIN_WIDTH,
  DETAIL_PANEL_WIDTH,
  requiredWidth,
} from "./useSidebarLayout";
import { useDragResize } from "./useDragResize";

/** Layout values read inside the stable open callback. */
export type DetailLayoutRef = {
  viewportWidth: number;
  sidebarWidth: number;
  detailWidth: number;
  projectListHidden: boolean;
};

/** Sidebar controls the detail pane needs when it opens / resizes. */
export type DetailPaneBridge = {
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarPeek: (peek: boolean) => void;
  getSidebarWidth: () => number;
};

export type UseDetailPaneOptions = {
  workspaceId: string;
  context: WorkspaceContext | null;
  /** Signed-in nickname (`context.user.nick ?? info.me`); null when unknown. */
  me: string | null;
  bumpList: () => void;
  showToast: ToastFn;
  layoutRef: RefObject<DetailLayoutRef>;
  bridge: RefObject<DetailPaneBridge>;
};

/**
 * Right detail pane: cache-first fetch with sequence guards, the open/close
 * width animation (including growing the window), resize, export and the write
 * actions that re-read the bug.
 */
export function useDetailPane({
  workspaceId,
  context,
  me,
  bumpList,
  showToast,
  layoutRef,
  bridge,
}: UseDetailPaneOptions) {
  const [detailOpen, setDetailOpen] = useState(false);
  /** Kept true during the close animation; false unmounts the pane entirely. */
  const [detailRendered, setDetailRendered] = useState(false);
  /**
   * Bug the pane was last asked to show, set before the fetch resolves so the
   * list can highlight its row immediately (the detail itself arrives later).
   */
  const [target, setTarget] = useState<{ workspaceId: string; bugId: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(DETAIL_PANEL_WIDTH);
  const [resizingDetail, setResizingDetail] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  /** Read inside stable callbacks without re-creating them on every detail load. */
  const detailRef = useRef<BugDetail | null>(null);
  detailRef.current = detail;

  const effectiveDetailWidth = Math.max(
    DETAIL_MIN_WIDTH,
    Math.min(detailWidth, DETAIL_MAX_WIDTH),
  );

  /** Whether the pane currently occupies layout (true during close animation). */
  const detailRenderedRef = useRef(false);
  detailRenderedRef.current = detailRendered;
  const detailCloseTimer = useRef<number | null>(null);

  /** Monotonic id so a slow detail response cannot replace a newer bug. */
  const detailSeq = useRef(0);

  /**
   * Opens the detail pane cache-first. Opening it does not refresh the list and
   * does not show the global "updating" indicator — only list refreshes do.
   */
  const loadBugDetail = useCallback(
    (targetWorkspaceId: string, bugId: string) => {
      const seq = ++detailSeq.current;
      setTarget({ workspaceId: targetWorkspaceId, bugId });
      // The owner / developer pickers need this workspace's people directory.
      void ensureMembers(targetWorkspaceId);
      // Codex-style pane: make room first (collapse the project list on narrow
      // windows, then grow the window leftwards if needed), then animate in.
      if (!detailRenderedRef.current) {
        const layout = layoutRef.current;
        const sidebarWidth = layout.projectListHidden ? 0 : layout.sidebarWidth;
        const requiredWithSidebar = requiredWidth(sidebarWidth, layout.detailWidth);
        const collapseSidebar =
          !layout.projectListHidden && layout.viewportWidth < requiredWithSidebar;
        if (collapseSidebar) {
          bridge.current.setSidebarCollapsed(true);
          bridge.current.setSidebarPeek(false);
        }
        const required = requiredWidth(
          collapseSidebar ? 0 : sidebarWidth,
          layout.detailWidth,
        );
        void api
          .ensureWindowWidth(required)
          .catch(() => 0)
          .finally(() => {
            if (seq !== detailSeq.current) return;
            // Mount the pane at zero width, then grow it on the next frame so the
            // width transition runs from a painted starting value.
            setDetailRendered(true);
            // Two frames: the first paints the zero-width pane, the second starts
            // the width transition so the list and pane move together.
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                if (seq === detailSeq.current) setDetailOpen(true);
              });
            });
          });
      } else {
        // Reopening during the close animation: grow back from the current width.
        if (detailCloseTimer.current !== null) {
          window.clearTimeout(detailCloseTimer.current);
          detailCloseTimer.current = null;
        }
        setDetailOpen(true);
      }
      setDetail(null);
      setDetailError(null);
      setLastExport(null);
      setDetailLoading(true);

      void (async () => {
        let hasCache = false;
        try {
          const cached = await cacheApi.bugDetail(targetWorkspaceId, bugId);
          if (seq === detailSeq.current && cached.data) {
            hasCache = true;
            setDetail(cached.data);
            setDetailLoading(false);
          }
        } catch {
          // Cache misses are not errors.
        }
        if (seq !== detailSeq.current) return;
        try {
          const next = await api.bugDetail(targetWorkspaceId, bugId);
          if (seq !== detailSeq.current) return;
          setDetail(next);
          setDetailError(null);
        } catch (error) {
          if (seq === detailSeq.current && !hasCache) {
            setDetailError(String(error));
          }
        } finally {
          if (seq === detailSeq.current) setDetailLoading(false);
        }
      })();
    },
    [bridge, layoutRef],
  );

  /**
   * Re-reads a bug after a write action. Unlike `loadBugDetail` it never paints
   * the (now stale) cache first, so the pane switches straight to fresh data.
   */
  const reloadBugDetail = useCallback(
    async (targetWorkspaceId: string, bugId: string) => {
      const seq = ++detailSeq.current;
      try {
        const next = await api.bugDetail(targetWorkspaceId, bugId);
        if (seq !== detailSeq.current) return;
        setDetail(next);
        setDetailError(null);
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [showToast],
  );

  /** Assigns an unowned / other-owned bug to the signed-in user. */
  const claimBug = useCallback(
    async (targetWorkspaceId: string, bugId: string) => {
      const currentUser = me;
      if (!currentUser) {
        showToast("error", t("app.claim.noUser"));
        throw new Error("current user is unknown");
      }
      try {
        await api.bugUpdateField(
          targetWorkspaceId,
          bugId,
          "current_owner",
          currentUser,
          true,
        );
        showToast("ok", t("app.claim.done"));
        bumpList();
        const open = detailRef.current;
        if (open?.id === bugId && open.workspaceId === targetWorkspaceId) {
          await reloadBugDetail(targetWorkspaceId, bugId);
        }
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [bumpList, me, reloadBugDetail, showToast],
  );

  const claimBugFromList = useCallback(
    (bug: BugSummary) => claimBug(bug.workspaceId, bug.id),
    [claimBug],
  );

  const claimBugFromDetail = useCallback(
    (target: BugDetail) => claimBug(target.workspaceId, target.id),
    [claimBug],
  );

  const addBugComment = useCallback(
    async (target: BugDetail, comment: string) => {
      try {
        await api.bugAddComment(target.workspaceId, target.id, comment);
        showToast("ok", t("app.comment.posted"));
        bumpList();
        await reloadBugDetail(target.workspaceId, target.id);
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [bumpList, reloadBugDetail, showToast],
  );

  const changeBugField = useCallback(
    async (target: BugDetail, field: string, value: string) => {
      try {
        await api.bugUpdateField(target.workspaceId, target.id, field, value);
        showToast(
          "ok",
          field === "de" ? t("app.detail.developerUpdated") : t("app.detail.ownerUpdated"),
        );
        bumpList();
        await reloadBugDetail(target.workspaceId, target.id);
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [bumpList, reloadBugDetail, showToast],
  );

  const transitionBug = useCallback(
    async (
      target: BugDetail,
      status: string,
      fields?: Record<string, string>,
    ) => {
      try {
        const result = await api.bugTransition(
          target.workspaceId,
          target.id,
          status,
          fields,
        );
        showToast("ok", t("app.detail.statusChanged", { label: result.label }));
        bumpList();
        await reloadBugDetail(target.workspaceId, target.id);
      } catch (error) {
        // The transition dialog shows the failure inline; no toast on top.
        throw error;
      }
    },
    [bumpList, reloadBugDetail, showToast],
  );

  const refreshDetailMembers = useCallback(() => {
    const id = detailRef.current?.workspaceId ?? workspaceId;
    if (id) void ensureMembers(id, true);
  }, [workspaceId]);

  /** Shrinks the pane away, then removes it from layout to free the content area. */
  const closeDetail = useCallback(() => {
    detailSeq.current += 1;
    setDetailOpen(false);
    if (detailCloseTimer.current !== null) {
      window.clearTimeout(detailCloseTimer.current);
    }
    detailCloseTimer.current = window.setTimeout(() => {
      detailCloseTimer.current = null;
      setDetailRendered(false);
    }, 320);
  }, []);

  useEffect(
    () => () => {
      if (detailCloseTimer.current !== null) {
        window.clearTimeout(detailCloseTimer.current);
      }
    },
    [],
  );

  const handleExport = useCallback(
    async (target: BugDetail) => {
      setExporting(true);
      try {
        const name =
          context?.workspaces.find((item) => item.id === target.workspaceId)?.name ??
          null;
        const result = await api.exportBug(target.workspaceId, target.id, name);
        // Success is reported by the inline export panel in the detail pane;
        // a toast on top of it is just noise.
        setLastExport(result);
      } catch (error) {
        showToast("error", String(error));
      } finally {
        setExporting(false);
      }
    },
    [context, showToast],
  );

  /** Drag the divider on the detail pane's left edge (like the sidebar). */
  const startDetailResize = useDragResize(() => {
    let nextWidth = effectiveDetailWidth;
    const sidebarWidth = bridge.current.getSidebarWidth();
    setResizingDetail(true);

    return {
      onMove: (deltaX) => {
        nextWidth = Math.max(
          DETAIL_MIN_WIDTH,
          Math.min(DETAIL_MAX_WIDTH, effectiveDetailWidth - deltaX),
        );
        setDetailWidth(nextWidth);
      },
      onEnd: () => {
        setResizingDetail(false);
        // A wider pane may need a wider window; grow leftwards if necessary.
        void api
          .ensureWindowWidth(requiredWidth(sidebarWidth, nextWidth))
          .catch(() => 0);
      },
    };
  });

  // The signed-in user must always be selectable, even if the member API omits
  // them (some projects only return the assignable subset).
  const { byWorkspace, loading: membersLoading } = useMembers();
  const detailMembers = useMemo(() => {
    const list = byWorkspace[detail?.workspaceId ?? workspaceId] ?? [];
    const myNick = me ?? "";
    if (!myNick || list.some((member) => member.nick === myNick)) return list;
    return [
      ...list,
      { nick: myNick, userId: "", name: myNick, avatar: "" } as WorkspaceMember,
    ];
  }, [byWorkspace, detail?.workspaceId, me, workspaceId]);

  return {
    open: detailOpen,
    rendered: detailRendered,
    /** Bug the pane is showing (or about to show); used by the list highlight. */
    target,
    detail,
    loading: detailLoading,
    error: detailError,
    width: effectiveDetailWidth,
    resizing: resizingDetail,
    exporting,
    lastExport,
    members: detailMembers,
    membersLoading: Boolean(membersLoading[detail?.workspaceId ?? workspaceId]),
    openDetail: loadBugDetail,
    reloadDetail: reloadBugDetail,
    closeDetail,
    refreshMembers: refreshDetailMembers,
    exportDetail: handleExport,
    startResize: startDetailResize,
    claimFromList: claimBugFromList,
    claimFromDetail: claimBugFromDetail,
    addComment: addBugComment,
    changeField: changeBugField,
    transition: transitionBug,
  };
}
