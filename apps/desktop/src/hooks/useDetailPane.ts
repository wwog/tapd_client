import { useCallback, useMemo, useRef, useState } from "react";

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

export type UseDetailPaneOptions = {
  workspaceId: string;
  context: WorkspaceContext | null;
  /** Signed-in nickname (`context.user.nick ?? info.me`); null when unknown. */
  me: string | null;
  bumpList: () => void;
  showToast: ToastFn;
  /**
   * Opens (or focuses) the singleton bug panel. The workbench owns placement;
   * this hook only knows the bug resource. `label` is the tab title.
   */
  openPanel: (workspaceId: string, bugId: string, label?: string) => void;
  /** Removes the singleton bug panel from the layout. */
  closePanel: () => void;
};

/**
 * Bug detail data: cache-first fetch with sequence guards, reload after writes,
 * export and the write actions. Opening/closing the visible pane belongs to the
 * workbench layout; App watches the bug panel resource and calls `loadDetail`.
 */
export function useDetailPane({
  workspaceId,
  context,
  me,
  bumpList,
  showToast,
  openPanel,
  closePanel,
}: UseDetailPaneOptions) {
  /**
   * Bug the panel was last asked to show, set before the fetch resolves so the
   * list can highlight its row immediately (the detail itself arrives later).
   */
  const [target, setTarget] = useState<{ workspaceId: string; bugId: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  /** Read inside stable callbacks without re-creating them on every detail load. */
  const detailRef = useRef<BugDetail | null>(null);
  detailRef.current = detail;

  const openPanelRef = useRef(openPanel);
  openPanelRef.current = openPanel;
  const closePanelRef = useRef(closePanel);
  closePanelRef.current = closePanel;

  /** Monotonic id so a slow detail response cannot replace a newer bug. */
  const detailSeq = useRef(0);

  const clear = useCallback(() => {
    setTarget(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setLastExport(null);
  }, []);

  /**
   * Cache-first read for the bug the layout says is open. Called by App from an
   * effect that watches the active bug panel resource.
   */
  const loadDetail = useCallback(
    (workspaceId: string, bugId: string) => {
      const seq = ++detailSeq.current;
      setTarget({ workspaceId, bugId });
      // The owner / developer pickers need this workspace's people directory.
      void ensureMembers(workspaceId);
      setDetail(null);
      setDetailError(null);
      setLastExport(null);
      setDetailLoading(true);

      void (async () => {
        let hasCache = false;
        try {
          const cached = await cacheApi.bugDetail(workspaceId, bugId);
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
          const next = await api.bugDetail(workspaceId, bugId);
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
    [],
  );

  /**
   * Opens/focuses the bug panel and reads its data. The direct load also covers
   * re-clicking the same bug (no layout change, so App's panel effect would not
   * fire again); the App effect skips a resource whose target already matches.
   */
  const openDetail = useCallback(
    (workspaceId: string, bugId: string, label?: string) => {
      loadDetail(workspaceId, bugId);
      openPanelRef.current(workspaceId, bugId, label);
    },
    [loadDetail],
  );

  /** Drawer close / tab close: clears the fetch and removes the layout panel. */
  const closeDetail = useCallback(() => {
    detailSeq.current += 1;
    clear();
    closePanelRef.current();
  }, [clear]);

  /** The panel disappeared without going through `closeDetail` (e.g. logout). */
  const reset = useCallback(() => {
    detailSeq.current += 1;
    clear();
  }, [clear]);

  /**
   * Re-reads a bug after a write action. Unlike `loadDetail` it never paints
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
    /** Bug the panel is showing (or about to show); used by the list highlight. */
    target,
    detail,
    loading: detailLoading,
    error: detailError,
    exporting,
    lastExport,
    members: detailMembers,
    membersLoading: Boolean(membersLoading[detail?.workspaceId ?? workspaceId]),
    openDetail,
    loadDetail,
    closeDetail,
    reset,
    refreshMembers: refreshDetailMembers,
    exportDetail: handleExport,
    claimFromList: claimBugFromList,
    claimFromDetail: claimBugFromDetail,
    addComment: addBugComment,
    changeField: changeBugField,
    transition: transitionBug,
  };
}
