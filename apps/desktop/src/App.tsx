import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ListPlus,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, type BugSummary, type OpenMediaMode } from "./lib/api";
import { t } from "./lib/i18n";
import {
  ROOT_WORKSPACE_ID,
  SESSION_WORKSPACE_PREFIX,
  type FileTabTarget,
} from "./lib/fs";
import {
  LOCAL_PROJECTS_EVENT,
  openLocalItemCreate,
  type LocalProject,
} from "./lib/local";
import {
  markCompanionOnline,
  refreshCompanionStatus,
  useCompanionEnabled,
  useCompanionOnline,
} from "./lib/companion";
import { useMembersDirectory } from "./lib/members";
import { showToast } from "./lib/toast";
import { useTauriEvent } from "./lib/tauriEvent";
import { startUpdateStore } from "./lib/update";
import { ActivityBar, type View } from "./components/ActivityBar";
import { AgentConfigHost } from "./agent/AgentConfigTab";
import { useQueueBadge, useQueueBatchRuntime } from "./agent/queueBatch";
import { agentActions, agentStore } from "./agent/store";
import { useTaskFeedRuntime } from "./agent/useAgentRuntime";
import { AgentOpenButton } from "./components/AgentOpenButton";
import { CompanionDialog } from "./components/CompanionDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Dialog } from "./components/Dialog";
import { ForceUpdateModal } from "./components/ForceUpdateModal";
import { LocalProjectDialog } from "./components/LocalProjectDialog";
import { LoginGate } from "./components/LoginGate";
import { MediaPreviewHost } from "./components/MediaPreviewHost";
import { Onboarding } from "./components/Onboarding";
import { ProjectOpenButton } from "./components/ProjectOpenButton";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { TabExtraAction } from "./components/TabExtraAction";
import { TitleBar } from "./components/TitleBar";
import { ToastHost } from "./components/ToastHost";
import { Button } from "./components/ui";
import { useLocalProjects } from "./hooks/useLocalProjects";
import { usePoll } from "./hooks/usePoll";
import { useDetailPane } from "./hooks/useDetailPane";
import {
  LAYOUT_GUTTER,
  RAIL_WIDTH,
  useSidebarLayout,
} from "./hooks/useSidebarLayout";
import { useTerminalPanel } from "./hooks/useTerminalPanel";
import {
  useWorkspaceData,
  type WorkspacePaneBridge,
} from "./hooks/useWorkspaceData";
import type { BugScope } from "./components/bugListPrefs";
import {
  GROUP_GAP,
  PAGE_VIEWS,
  PANEL_MIN_SIZE,
  groupMinSize,
} from "./workbench/layout/defaults";
import { GROUP_INSET } from "./workbench/components/SplitView";
import type {
  PanelRef,
  WorkbenchLayoutApi,
} from "./workbench/layout/types";
import { activePage } from "./workbench/layout/ops";
import { useWorkbenchLayout } from "./workbench/layout/useWorkbenchLayout";
import { Workbench } from "./workbench/Workbench";
import { Sash } from "./workbench/components/Sash";
import { clearDirtyPanels, hasDirtyPanels } from "./workbench/panels/dirty";
import type { PageHostServices } from "./workbench/components/pageContext";

/** The singleton bug detail panel, if the layout has one. */
function findBugPanel(layout: WorkbenchLayoutApi): PanelRef | null {
  for (const group of layout.groups) {
    const panel = group.panels.find((item) => item.kind === "bug");
    if (panel) return panel;
  }
  return null;
}

/** Width the layout area needs beside the side bar, including canonical docks. */
function layoutContentMinWidth(layout: WorkbenchLayoutApi): number {
  const primary = layout.groups.find((group) => group.role === "primary");
  const secondary = layout.groups.find((group) => group.role === "secondary");
  const primaryMin = primary
    ? groupMinSize(primary).width
    : PANEL_MIN_SIZE.page.width;
  const secondaryMin =
    secondary && secondary.panels.length
      ? groupMinSize(secondary).width + GROUP_GAP
      : 0;
  return Math.max(primaryMin + secondaryMin + GROUP_GAP, 460);
}

export default function App() {
  const [scope, setScope] = useState<BugScope>("mine");
  // The workflow feed is global: the bug list paints queued tasks and the
  // title bar's queue button works without the Agent page ever being opened.
  useTaskFeedRuntime();
  useQueueBatchRuntime();
  const queueBadge = useQueueBadge();
  const layoutApi = useWorkbenchLayout();
  /** Latest layout API for stable callbacks defined before the domain hooks. */
  const layoutRef = useRef(layoutApi);
  layoutRef.current = layoutApi;
  /** Latest TAPD selection, readable from stable callbacks. */
  const workspaceIdRef = useRef("");
  const active = activePage(layoutApi.layout);
  const view = active?.view ?? null;
  const activeProjectId = active?.projectId ?? null;
  const setView = useCallback(
    (next: View) => {
      // Switching pages must reveal the primary dock even if another group was
      // maximized (notification jumps, activity-bar clicks).
      if (layoutApi.layout.maximizedGroupId) layoutApi.maximizeGroup(null);
      // Global pages share one tab; project pages are opened from the project
      // list, which targets a project id instead.
      layoutApi.openPage(next);
    },
    [layoutApi.maximizeGroup, layoutApi.openPage, layoutApi.layout.maximizedGroupId],
  );
  const [railAnim, setRailAnim] = useState<{ id: string; token: number } | null>(null);
  const railAnimTimer = useRef<number | null>(null);
  /** Mobile companion QR dialog; the rail entry exists only while enabled. */
  const [companionOpen, setCompanionOpen] = useState(false);
  /** Unsaved edits block logout / window close until the user decides. */
  const [unsavedExit, setUnsavedExit] = useState<"logout" | "quit" | null>(null);
  const companionEnabled = useCompanionEnabled();
  /** Any paired phone heartbeat within the last minute. */
  const companionOnline = useCompanionOnline();

  /** Local projects; the selection is mutually exclusive with a TAPD workspace. */
  const local = useLocalProjects();
  const localProject =
    local.projects.find((project) => project.id === local.selectedId) ?? null;
  /**
   * Projects a free conversation can be created under (a repository is
   * configured). The project tabs'「新建会话」is offered only for these, the
   * same rule the Agent page's project groups follow.
   */
  const sessionProjects = useSyncExternalStore(
    agentStore.subscribe,
    () => agentStore.get().projects,
  );
  /** Create (`project: null`) / edit dialog, opened from the side bar or projects page. */
  const [localProjectDialog, setLocalProjectDialog] = useState<{
    project: LocalProject | null;
  } | null>(null);
  const [localProjectDelete, setLocalProjectDelete] = useState<LocalProject | null>(
    null,
  );
  const [localProjectDeleting, setLocalProjectDeleting] = useState(false);
  useEffect(() => {
    startUpdateStore();
    void refreshCompanionStatus();
    // The project tabs offer「新建会话」before the Agent page is ever opened,
    // so the project list is primed here instead of waiting for that mount.
    void agentActions.refreshProjects();
  }, []);

  // Closing the window with unsaved edits asks first. `destroy` in the dialog
  // bypasses this handler, so confirming cannot loop.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!hasDirtyPanels()) return;
        event.preventDefault();
        setUnsavedExit("quit");
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  // Green rail icon while a phone is online. Pairing/presence events flip i
  // immediately; the poll clears it after the 60s heartbeat window expires.
  usePoll(
    () => void refreshCompanionStatus(),
    companionEnabled ? 20_000 : 0,
    { pauseWhenHidden: true },
  );
  useTauriEvent("companion://paired", () => markCompanionOnline());
  useTauriEvent("companion://presence", () => markCompanionOnline());

  // A local folder created here (or on the paired phone) must join the Agent
  // page's project groups and its「新建会话」targets without a remount.
  useTauriEvent(LOCAL_PROJECTS_EVENT, () => {
    void local.refresh();
    void agentActions.refreshProjects();
  });

  // The capsule asked to land on a specific page (the update state opens the
  // account page, which owns 立即更新). Anything else is ignored rather than
  // trusting the island's payload as a page id.
  useTauriEvent<{ view?: string }>("notification://open-view", (payload) => {
    const target = payload?.view;
    if (!target || !(PAGE_VIEWS as readonly string[]).includes(target)) return;
    setView(target as View);
  });

  /** Detail actions read by workspace events without a hook-order cycle. */
  const paneBridgeRef = useRef<WorkspacePaneBridge>({
    loadBugDetail: () => undefined,
    closeDetail: () => undefined,
  });

  /** Opens a TAPD project's page tab (notifications jump across projects). */
  const openWorkspacePage = useCallback((targetWorkspaceId: string) => {
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.openPage("bugs", targetWorkspaceId);
  }, []);

  const {
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
  } = useWorkspaceData({
    view,
    showToast,
    pane: paneBridgeRef,
    openWorkspacePage,
  });

  // Stable callbacks above (rail clicks, ⌘J) read the selection from here.
  workspaceIdRef.current = workspaceId;

  /** TAPD project the visible page belongs to (project tabs carry their own). */
  const pageWorkspaceId =
    view === "bugs" ? (activeProjectId ?? workspaceId) : workspaceId;

  /**
   * Row the project list paints as selected. A row stands for the project page
   * on screen, so a global tab (settings, Agent, …) selects no row — the
   * remembered `workspaceId` alone must not keep a closed project highlighted.
   */
  const selectedWorkspaceId = view === "bugs" ? pageWorkspaceId : "";

  // Members belong to the page's TAPD workspace. A local selection is only
  // relevant while the local page is active, so it must not suppress members
  // when the user switches back to the bug list.
  useMembersDirectory(
    info?.loggedIn ?? false,
    view === "local" ? "" : pageWorkspaceId,
  );

  /** Opens/focuses the singleton bug panel in the secondary dock. */
  const openBugPanel = (
    targetWorkspaceId: string,
    bugId: string,
    label?: string,
  ) => {
    // A maximized group may be covering the secondary dock.
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.open({
      resource: { type: "bug", workspaceId: targetWorkspaceId, bugId },
      target: "secondary",
      label,
    });
  };

  /** Removes the bug panel; called by the drawer close and tab close paths. */
  const closeBugPanel = () => {
    const panel = findBugPanel(layoutRef.current);
    if (panel) layoutRef.current.closePanel(panel.id);
  };

  const detailPane = useDetailPane({
    workspaceId,
    context,
    me: context?.user.nick ?? info?.me ?? null,
    bumpList,
    showToast,
    openPanel: openBugPanel,
    closePanel: closeBugPanel,
  });

  const { loadDetail: loadBugDetail, reset: resetBugDetail } = detailPane;

  // App owns the trigger: whenever the active bug panel resource changes, the
  // detail fetch follows. A target that already matches was opened through
  // `openDetail`, which loaded it directly; closing the tab resets the hook.
  const bugPanel = findBugPanel(layoutApi);
  const detailTarget = detailPane.target;
  /** Dedupes the loader across StrictMode's double effect invocation. */
  const requestedBugRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bugPanel || bugPanel.resource.type !== "bug") {
      requestedBugRef.current = null;
      resetBugDetail();
      return;
    }
    const { workspaceId: targetWorkspaceId, bugId } = bugPanel.resource;
    const key = `${targetWorkspaceId}:${bugId}`;
    if (
      detailTarget &&
      detailTarget.workspaceId === targetWorkspaceId &&
      detailTarget.bugId === bugId
    ) {
      requestedBugRef.current = key;
      return;
    }
    if (requestedBugRef.current === key) return;
    requestedBugRef.current = key;
    loadBugDetail(targetWorkspaceId, bugId);
  }, [bugPanel?.id, detailTarget, loadBugDetail, resetBugDetail]);

  /** Width the layout area needs beside the rail and the project column. */
  const contentMinWidth = layoutContentMinWidth(layoutApi);
  /**
   * Window width the current docks need. The extra `GROUP_GAP * 2` is slack:
   * `ensure_window_width` resizes to whole logical pixels and `innerWidth`
   * floors the result, so an exact fit would read as "too narrow" and collapse
   * the column right after growing.
   */
  const requiredWindowWidth =
    RAIL_WIDTH +
    layoutApi.sidebarWidth +
    contentMinWidth +
    LAYOUT_GUTTER +
    GROUP_GAP * 2;

  /** Secondary dock contents; a change fills or empties the dock. */
  const secondaryKindKey =
    layoutApi.groups
      .find((group) => group.role === "secondary")
      ?.panels.map((panel) => panel.kind)
      .join("|") ?? "";
  /** Dock content key whose window growth was already requested this entry. */
  const growthRequestedKey = useRef(secondaryKindKey);
  /** Viewport width a programmatic growth is heading for. */
  const [growingViewportWidth, setGrowingViewportWidth] = useState<number | null>(
    null,
  );

  /**
   * The render that fills the dock also grows `contentMinWidth`, but the resize
   * is requested by an effect (after paint). Treat the window as already wide
   * enough for that commit so the column keeps its width instead of collapsing
   * and popping back once the resize lands.
   */
  const pendingViewportWidth =
    growingViewportWidth ??
    (growthRequestedKey.current === secondaryKindKey
      ? null
      : requiredWindowWidth);

  const sidebar = useSidebarLayout({
    sidebarWidth: layoutApi.sidebarWidth,
    setSidebarWidth: layoutApi.setSidebarWidth,
    sidebarCollapsed: layoutApi.sidebarCollapsed,
    setSidebarCollapsed: layoutApi.setSidebarCollapsed,
    contentMinWidth,
    pendingViewportWidth,
  });

  /**
   * Window growth: a newly filled secondary dock needs room for the primary
   * minimum, the secondary minimum and the rail/column. Watching the dock's
   * panel kinds catches every path (bug panel, `services.open`, drag into the
   * dock); a restored layout is skipped so startup never resizes the window.
   */
  const requiredWindowWidthRef = useRef(requiredWindowWidth);
  requiredWindowWidthRef.current = requiredWindowWidth;
  useEffect(() => {
    if (growthRequestedKey.current === secondaryKindKey) return;
    growthRequestedKey.current = secondaryKindKey;
    if (!secondaryKindKey) {
      setGrowingViewportWidth(null);
      return;
    }
    const target = requiredWindowWidthRef.current;
    if (target <= window.innerWidth + 1) {
      setGrowingViewportWidth(null);
      return;
    }
    setGrowingViewportWidth(target);
    void api
      .ensureWindowWidth(target)
      // A monitor clamp returns the capped width: the column then collapses
      // (correctly) after the resize lands, instead of flickering before it.
      .then((achieved) => setGrowingViewportWidth(achieved))
      .catch(() => setGrowingViewportWidth(null));
  }, [secondaryKindKey]);

  // Release the reservation once the window reports the new width, or after a
  // moment when no resize arrives (the OS refused the growth).
  useEffect(() => {
    if (pendingViewportWidth === null) return;
    if (sidebar.viewportWidth + 2 >= pendingViewportWidth) {
      setGrowingViewportWidth(null);
      return;
    }
    const timer = window.setTimeout(() => setGrowingViewportWidth(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [pendingViewportWidth, sidebar.viewportWidth]);

  const terminal = useTerminalPanel({ workspaceId, showToast });

  // Layout mirrors the backend-owned PTY list; hiding the dock removes its
  // panels (the PTYs stay alive) and showing it restores every session.
  const syncTerminalPanels = layoutApi.syncTerminalPanels;
  useEffect(() => {
    syncTerminalPanels(
      terminal.hidden
        ? []
        : terminal.sessions.map((session) => ({
            id: session.id,
            label: session.title || session.cwd,
          })),
    );
    // The sync callback is read from the current render; only the session
    // list and visibility decide when the layout changes.
  }, [syncTerminalPanels, terminal.hidden, terminal.sessions]);

  /** Show => focus the bottom dock (spawning a first shell when empty). */
  const wantTerminalFocus = useRef(false);
  useEffect(() => {
    if (terminal.hidden || !wantTerminalFocus.current) return;
    if (terminal.sessions.length === 0) return;
    wantTerminalFocus.current = false;
    const target = terminal.activeId ?? terminal.sessions[0]!.id;
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.open({
      resource: { type: "terminal", sessionId: target },
      target: "bottom",
    });
  }, [terminal.hidden, terminal.sessions, terminal.activeId]);

  const hasTerminalPanels = layoutApi.groups.some((group) =>
    group.panels.some((panel) => panel.kind === "terminal"),
  );
  const terminalOpen = !terminal.hidden && hasTerminalPanels;

  /**
   * Show the shell dock: restores its tabs, spawns the first shell when there
   * is none, and focuses the bottom dock. Shared by ⌘J and the welcome page's
   *「打开终端」, which must never fold a dock the reader is already using.
   */
  const showTerminal = useCallback(() => {
    terminal.show();
    wantTerminalFocus.current = true;
    if (terminal.sessions.length === 0) terminal.create();
  }, [terminal.create, terminal.show, terminal.sessions.length]);

  /**
   * ⌘J / rail toggle. Hiding keeps every PTY alive; showing restores the tabs,
   * spawns the first shell when there is none, and focuses the bottom dock.
   */
  const toggleTerminal = useCallback(() => {
    if (!terminal.hidden && hasTerminalPanels) {
      terminal.hide();
      return;
    }
    showTerminal();
  }, [hasTerminalPanels, showTerminal, terminal.hide, terminal.hidden]);

  // ⌘J is the shell dock's only global shortcut. Captured so a focused editor
  // cannot swallow it; Ctrl+J is a newline inside a shell, so only the platform
  // modifier is accepted.
  useEffect(() => {
    const primaryModifier = navigator.userAgent.includes("Mac");
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = primaryModifier ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      toggleTerminal();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [toggleTerminal]);

  // Detail actions read by workspace events (notifications, logout) without a
  // hook-order cycle.
  paneBridgeRef.current = {
    loadBugDetail: detailPane.openDetail,
    closeDetail: detailPane.closeDetail,
  };

  // Project tabs are named after their project; a rename must follow through.
  useEffect(() => {
    for (const group of layoutApi.groups) {
      for (const panel of group.panels) {
        if (panel.resource.type !== "page" || !panel.resource.projectId) continue;
        const { view: pageView, projectId } = panel.resource;
        const label =
          pageView === "bugs"
            ? context?.workspaces.find((item) => item.id === projectId)?.name
            : local.projects.find((item) => item.id === projectId)?.name;
        if (label && panel.label !== label) {
          layoutRef.current.setPanelLabel(panel.id, label);
        }
      }
    }
  }, [layoutApi.groups, context, local.projects]);

  // A layout restored from disk can hold a generic page written before the
  // project was known; adopt it once the selection arrives. Never while
  // logged out: a restored tree must not adopt the ended session's workspace.
  useEffect(() => {
    if (!workspaceId || !info?.loggedIn) return;
    layoutRef.current.retargetPage("bugs", workspaceId);
  }, [workspaceId, info?.loggedIn, layoutApi.layout]);

  useEffect(() => {
    if (local.loading || !local.selectedId) return;
    layoutRef.current.retargetPage("local", local.selectedId);
  }, [local.loading, local.selectedId, layoutApi.layout]);

  // A deleted local project takes its tab with it.
  useEffect(() => {
    if (local.loading || local.error) return;
    const known = new Set(local.projects.map((project) => project.id));
    for (const group of layoutApi.groups) {
      for (const panel of group.panels) {
        if (
          panel.resource.type === "page" &&
          panel.resource.view === "local" &&
          panel.resource.projectId &&
          !known.has(panel.resource.projectId)
        ) {
          layoutRef.current.closePanel(panel.id);
        }
      }
    }
  }, [local.loading, local.error, local.projects, layoutApi.groups]);

  // Activating a tab is a project switch: keep the side bar highlight and the
  // pages' shared selection in step with the visible tab.
  useEffect(() => {
    if (!activeProjectId) return;
    if (view === "bugs" && activeProjectId !== workspaceIdRef.current) {
      setWorkspaceId(activeProjectId);
      void api.setLastWorkspace(activeProjectId);
    } else if (view === "local" && activeProjectId !== local.selectedId) {
      local.select(activeProjectId);
    }
  }, [view, activeProjectId, setWorkspaceId, local.select, local.selectedId]);

  /** Switch views and replay the destination's rail icon animation. */
  const activateView = useCallback((id: View) => {
    setView(id);
    setRailAnim({ id, token: Date.now() });
    if (railAnimTimer.current !== null) {
      window.clearTimeout(railAnimTimer.current);
    }
    railAnimTimer.current = window.setTimeout(() => setRailAnim(null), 720);
  }, [setView]);

  useEffect(
    () => () => {
      if (railAnimTimer.current !== null) {
        window.clearTimeout(railAnimTimer.current);
      }
    },
    [],
  );

  /** Project rows are the entry point: each one opens its own page tab. */
  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    workspaceIdRef.current = id;
    openWorkspacePage(id);
    // Detail belongs to the previous project: drop both the panel and its data.
    detailPane.closeDetail();
    void api.setLastWorkspace(id);
  };

  const selectLocalProject = (id: string) => {
    local.select(id);
    const name = local.projects.find((project) => project.id === id)?.name;
    // The tab may live in another dock (dragged out of the primary): reveal it.
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.openPage("local", id, name);
    // The bug detail belongs to TAPD; the local page has no such panel.
    detailPane.closeDetail();
  };

  const openBug = useCallback(
    (bug: BugSummary) => {
      detailPane.openDetail(bug.workspaceId, bug.id, bug.title);
    },
    [detailPane.openDetail],
  );

  /** Opens/switches the bug detail panel without leaving the current view. */
  const openBugById = useCallback(
    (targetWorkspaceId: string, bugId: string) => {
      detailPane.openDetail(targetWorkspaceId, bugId);
    },
    [detailPane.openDetail],
  );

  /** Jumps from a bug row or the workflow queue to that task's Agent page. */
  const openAgentTask = useCallback((sessionId: string) => {
    agentActions.selectSession(sessionId);
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.openPage("agent");
  }, []);

  /**
   * 「新建会话」in a project tab's extra: allocates a free conversation bound
   * to that project (its repo, branch and worktree switch) and reveals it on
   * the Agent page. `newSession` reports its own failure in the runtime notice,
   * so the page still opens and the reader sees why.
   */
  const newProjectSession = useCallback(
    async (project: { kind: "tapd" | "local"; id: string }) => {
      await agentActions.newSession(project);
      if (layoutRef.current.layout.maximizedGroupId) {
        layoutRef.current.maximizeGroup(null);
      }
      layoutRef.current.openPage("agent");
    },
    [],
  );

  /** Opens one local item in the secondary dock, like the bug detail panel. */
  const openLocalItem = useCallback(
    (projectId: string, itemId: string, label?: string) => {
      if (layoutRef.current.layout.maximizedGroupId) {
        layoutRef.current.maximizeGroup(null);
      }
      layoutRef.current.open({
        resource: { type: "local_item", projectId, itemId },
        target: "secondary",
        ...(label ? { label } : {}),
      });
    },
    [],
  );

  /** Opens the workflow queue tab (title-bar button, bug-list empty state). */
  const openQueue = useCallback(() => {
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.openPage("queue");
  }, []);

  /** Cancels one queued/running task; the row reports a failure as a toast. */
  const cancelAgentTask = useCallback(async (sessionId: string) => {
    try {
      await agentActions.cancelTask(sessionId);
    } catch (error) {
      showToast("error", String(error));
    }
  }, []);

  const deleteLocalProject = async () => {
    if (!localProjectDelete || localProjectDeleting) return;
    setLocalProjectDeleting(true);
    try {
      await local.remove(localProjectDelete.id);
      setLocalProjectDelete(null);
    } catch (error) {
      showToast("error", String(error));
    } finally {
      setLocalProjectDeleting(false);
    }
  };

  const openPath = useCallback(
    (path: string) => {
      void api.openPath(path).catch((error) => showToast("error", String(error)));
    },
    [showToast],
  );

  const openFile = useCallback(
    async (path: string, kind?: string, target?: string) => {
      try {
        // The app comes to the front on success; only failures need a toast.
        await api.openFile(path, kind, target);
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [showToast],
  );

  /** Local paths in agent replies open as a new tab in the right-hand dock. */
  const openFileTab = useCallback((target: FileTabTarget) => {
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.open({
      resource: {
        type: "file",
        workspaceId: target.workspaceId,
        path: target.path,
        ...(target.review ? { review: target.review } : {}),
      },
      preview: false,
      target: "secondary",
      ...(target.label ? { label: target.label } : {}),
    });
  }, []);

  const openMedia = useCallback(
    async (url: string, mode: OpenMediaMode, kind?: string, target?: string) => {
      try {
        // Opening is self-evident (the app comes to the front); only failures
        // need a toast.
        await api.openMedia(url, mode, kind, target);
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [showToast],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        showToast("error", t("app.copy.failed", { error: String(error) }));
      }
    },
    [showToast],
  );

  if (!info) {
    return (
      <>
        <div className="flex h-full items-center justify-center gap-2 bg-slate-50 text-ui-caption text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {t("app.startup.loading")}
        </div>
        <ForceUpdateModal />
      </>
    );
  }

  if (!info.loggedIn) {
    return (
      <>
        <LoginGate
          info={info}
          onRefresh={() => void refreshBase()}
          onToast={showToast}
        />
        <ForceUpdateModal />
        <ToastHost />
      </>
    );
  }

  /**
   * Trailing slot of the tab strip (`ActiveTabExtra`): the focused tab in a
   * group declares its own actions there. A project page (TAPD or local) can
   * start a conversation bound to that project; a local project can also add a
   * work item without scrolling back to the page's header. The 缺陷列表 opens
   * the bound folder and Agent opens the selected session's working directory.
   * Pages without such an action declare nothing and the slot stays empty.
   */
  const activeTabExtra = (panel: PanelRef) => {
    if (panel.resource.type !== "page") return null;
    const { view: panelView, projectId } = panel.resource;
    if (panelView === "local") {
      // A tab for a deleted project has no page behind it and must not offer
      // a conversation that cannot resolve its repository.
      const project =
        local.projects.find((item) => item.id === (projectId ?? local.selectedId)) ??
        null;
      if (!project) return null;
      return (
        <div className="flex items-center gap-1">
          <TabExtraAction
            label={t("agent.task.newInProject", { name: project.name })}
            onClick={() => void newProjectSession({ kind: "local", id: project.id })}
          >
            <MessageSquarePlus size={14} />
          </TabExtraAction>
          <TabExtraAction
            label={t("local.items.create")}
            onClick={() => openLocalItemCreate(project.id)}
          >
            <ListPlus size={14} />
          </TabExtraAction>
        </div>
      );
    }
    if (panelView === "bugs") {
      const targetId = projectId ?? workspace?.id;
      if (!targetId) return null;
      const open = (
        <ProjectOpenButton
          key={targetId}
          workspaceId={targetId}
          onError={(text) => showToast("error", text)}
        />
      );
      // A TAPD project without a bound repository cannot host a session.
      const canStart =
        sessionProjects?.some(
          (item) => item.kind === "tapd" && item.id === targetId,
        ) ?? false;
      if (!canStart) return open;
      const name = context?.workspaces.find((item) => item.id === targetId)?.name;
      return (
        <div className="flex items-center gap-1">
          <TabExtraAction
            label={
              name
                ? t("agent.task.newInProject", { name })
                : t("agent.task.newSession")
            }
            onClick={() => void newProjectSession({ kind: "tapd", id: targetId })}
          >
            <MessageSquarePlus size={14} />
          </TabExtraAction>
          {open}
        </div>
      );
    }
    if (panelView === "agent") {
      return <AgentOpenButton toast={showToast} />;
    }
    return null;
  };

  /** Leading strip action: the side bar toggle sits above the tabs. */
  const primaryLeading = (
    <button
      type="button"
      aria-label={
        sidebar.hidden ? t("app.sidebar.expand") : t("app.sidebar.collapse")
      }
      title={
        sidebar.autoCollapse
          ? sidebar.peek
            ? t("app.sidebar.collapse")
            : t("app.sidebar.expandNarrow")
          : sidebar.hidden
            ? t("app.sidebar.expand")
            : t("app.sidebar.collapse")
      }
      onClick={sidebar.toggle}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-overlay hover:text-slate-700"
    >
      {sidebar.hidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
    </button>
  );

  /** Sign out after the unsaved-edit confirmation (if any). */
  const performLogout = () => {
    // Clear the selection *before* closing panels: closing a project page
    // re-renders App, and a still-set workspaceId would immediately reopen the
    // ended session's project tab (and persist it for the next account).
    workspaceIdRef.current = "";
    setWorkspaceId("");
    const panels = layoutRef.current.groups.flatMap((group) => group.panels);
    for (const panel of panels) {
      // Project pages belong to the ended session; global pages (设置 / Agent…)
      // stay open. With nothing left the primary dock shows the welcome page.
      const projectPage =
        panel.resource.type === "page" && Boolean(panel.resource.projectId);
      if (panel.kind !== "page" || projectPage) {
        layoutRef.current.closePanel(panel.id);
      }
    }
    handleLogout();
    setUnsavedExit(null);
  };

  /** Sign out: drop every project-scoped panel, then let the session layer run. */
  const logout = () => {
    if (hasDirtyPanels()) {
      setUnsavedExit("logout");
      return;
    }
    performLogout();
  };

  const page: PageHostServices = {
    info,
    context,
    contextLoading,
    contextError,
    workspace,
    workspaceId,
    scope,
    setScope,
    activeBug: detailPane.target,
    localProjects: local.projects,
    localProject,
    localLoading: local.loading,
    localError: local.error,
    projectsKnown,
    hiddenWorkspaceIds,
    refreshToken,
    toast: showToast,
    onOpenBug: openBug,
    onOpenBugById: openBugById,
    onOpenAgentTask: openAgentTask,
    onCancelAgentTask: cancelAgentTask,
    onOpenLocalItem: openLocalItem,
    onOpenQueue: openQueue,
    onOpenView: (target) => {
      if (layoutRef.current.layout.maximizedGroupId) {
        layoutRef.current.maximizeGroup(null);
      }
      layoutRef.current.openPage(target);
    },
    onOpenProject: (projectId, label) => {
      if (layoutRef.current.layout.maximizedGroupId) {
        layoutRef.current.maximizeGroup(null);
      }
      layoutRef.current.openPage("bugs", projectId, label);
    },
    onOpenWeb: openPath,
    onOpenPath: openPath,
    onCopy: copy,
    onClaim: detailPane.claimFromList,
    onSetWorkspaceVisible: setWorkspaceVisible,
    onSelectLocalProject: selectLocalProject,
    onCreateLocalProject: () => setLocalProjectDialog({ project: null }),
    onEditLocalProject: (project) => setLocalProjectDialog({ project }),
    onDeleteLocalProject: (project) => setLocalProjectDelete(project),
    onOpenMedia: openMedia,
    onOpenFile: openFileTab,
    onOpenProjects: () => layoutRef.current.openPage("projects"),
    loadContext,
    refreshBase,
    onShowLogin: () => {
      void api.sessionShow().catch((error) => showToast("error", String(error)));
    },
    onLogout: logout,
    onRefresh: () => {
      void refreshBase();
      void loadContext();
    },
    onShowOnboarding: () => {
      void api
        .resetOnboarding()
        .then(() => refreshBase())
        .catch((error) => showToast("error", String(error)));
    },
  };

  const services = {
    toast: showToast,
    copy,
    openFile,
    workspaceName: (targetWorkspaceId: string) =>
      targetWorkspaceId.startsWith(SESSION_WORKSPACE_PREFIX)
        ? t("agent.file.sessionRoot")
        : targetWorkspaceId === ROOT_WORKSPACE_ID
          ? t("agent.file.rootRoot")
          : context?.workspaces.find((item) => item.id === targetWorkspaceId)?.name ??
            local.projects.find((item) => item.id === targetWorkspaceId)?.name ??
            targetWorkspaceId,
    currentWorkspaceId: workspaceId,
    bug: {
      detail: detailPane.detail,
      loading: detailPane.loading,
      error: detailPane.error,
      exporting: detailPane.exporting,
      lastExport: detailPane.lastExport,
      me: context?.user.nick ?? info.me,
      members: detailPane.members,
      membersLoading: detailPane.membersLoading,
      onOpenWeb: openPath,
      onCopy: copy,
      onExport: detailPane.exportDetail,
      onOpenPath: openPath,
      onOpenMedia: openMedia,
      onRefreshMembers: detailPane.refreshMembers,
      onClaim: detailPane.claimFromDetail,
      onAddComment: detailPane.addComment,
      onChangeField: detailPane.changeField,
      onTransition: detailPane.transition,
      onClose: detailPane.closeDetail,
    },
    terminal: {
      sessions: terminal.sessions,
      create: terminal.create,
      close: terminal.closeSession,
      restart: terminal.restart,
    },
  };

  /** Project menu entry: the read-only explorer opens in the secondary dock. */
  const openExplorer = (targetWorkspaceId: string) => {
    const name =
      context?.workspaces.find((item) => item.id === targetWorkspaceId)?.name ??
      local.projects.find((item) => item.id === targetWorkspaceId)?.name ??
      targetWorkspaceId;
    if (layoutRef.current.layout.maximizedGroupId) {
      layoutRef.current.maximizeGroup(null);
    }
    layoutRef.current.open({
      resource: { type: "explorer", workspaceId: targetWorkspaceId },
      label: name,
      target: "secondary",
    });
  };

  return (
    <div
      data-component="App"
      className={clsx(
        "flex h-full flex-col overflow-hidden bg-canvas text-slate-900",
        sidebar.resizing && "select-none",
      )}
    >
      <TitleBar
        onOpenAccount={() => activateView("account")}
        onOpenQueue={openQueue}
        queueBadge={queueBadge}
      />

      <div className="flex min-h-0 flex-1">
        <ActivityBar
          view={view}
          railAnim={railAnim}
          sidebarHidden={sidebar.hidden}
          meAvatar={info.meAvatar}
          name={context?.user.nick || info.me}
          showCompanion={companionEnabled}
          companionOnline={companionOnline}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenCompanion={() => setCompanionOpen(true)}
          onActivate={activateView}
        />

        <ProjectSidebar
          context={context}
          contextError={contextError}
          contextLoading={contextLoading}
          visibleWorkspaces={visibleWorkspaces}
          workspaceId={selectedWorkspaceId}
          localProjects={local.projects}
          localProjectId={view === "local" ? activeProjectId : null}
          view={view}
          account={{
            meAvatar: info.meAvatar,
            name: context?.user.nick || info.me || t("app.account.signedIn"),
            company: context?.user.company || t("app.account.title"),
          }}
          autoCollapse={sidebar.autoCollapse}
          resizing={sidebar.resizing}
          width={sidebar.effectiveWidth}
          projectMenu={projectMenu}
          onRetry={() => void loadContext()}
          onSelectWorkspace={selectWorkspace}
          onSelectLocalProject={selectLocalProject}
          onCreateLocalProject={() => setLocalProjectDialog({ project: null })}
          onEditLocalProject={(project) => setLocalProjectDialog({ project })}
          onDeleteLocalProject={setLocalProjectDelete}
          onOpenAccount={() => activateView("account")}
          onOpenProjectMenu={setProjectMenu}
          onCloseProjectMenu={() => setProjectMenu(null)}
          onHideWorkspace={hideWorkspace}
          onManageProjects={() => {
            // The context menu closes itself after its exit animation.
            setView("projects");
          }}
          onBrowseFiles={openExplorer}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Workbench
            layout={layoutApi}
            services={services}
            page={page}
            primaryLeading={primaryLeading}
            activeTabExtra={activeTabExtra}
            onOpenTerminal={showTerminal}
          />

          {!sidebar.hidden ? (
            <Sash
              axis="x"
              label={t("settings.sidebar.resizeLabel")}
              title={t("settings.sidebar.resizeTooltip")}
              className="z-20"
              style={{ left: -4, top: 0, width: 8, height: "100%" }}
              inset={GROUP_INSET}
              onDragStart={() => {
                sidebar.beginResize();
                return {
                  move: (delta) => sidebar.resize(delta),
                  end: sidebar.endResize,
                };
              }}
              onReset={sidebar.resetWidth}
            />
          ) : null}
        </div>
      </div>

      {!info.onboarded ? (
        <Onboarding info={info} onDone={() => void refreshBase()} />
      ) : null}

      <AgentConfigHost toast={showToast} />

      {companionOpen ? (
        <CompanionDialog
          onClose={() => setCompanionOpen(false)}
          toast={showToast}
        />
      ) : null}

      {unsavedExit ? (
        <Dialog
          title={t("layout.unsavedTitle")}
          icon={<AlertTriangle size={15} className="text-amber-500" />}
          onClose={() => setUnsavedExit(null)}
        >
          <p className="text-ui-caption leading-6 text-slate-600">
            {unsavedExit === "logout"
              ? t("layout.unsavedLogout")
              : t("layout.unsavedQuit")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setUnsavedExit(null)}
            >
              {t("layout.keepEditing")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (unsavedExit === "logout") {
                  clearDirtyPanels();
                  performLogout();
                  return;
                }
                clearDirtyPanels();
                const window = getCurrentWindow();
                void window.destroy().catch(() => window.close());
              }}
            >
              {unsavedExit === "logout"
                ? t("layout.logoutAnyway")
                : t("layout.quitAnyway")}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {localProjectDialog ? (
        <LocalProjectDialog
          key={localProjectDialog.project?.id ?? "new-local-project"}
          project={localProjectDialog.project}
          onClose={() => setLocalProjectDialog(null)}
          onSubmit={async (values) => {
            const editing = localProjectDialog.project;
            if (editing) {
              // An empty name is rejected by the backend; the dialog shows it.
              await local.update(editing.id, {
                name: values.name,
                repoPath: values.repoPath,
                rule: values.rule,
              });
              return;
            }
            const project = await local.create({
              repoPath: values.repoPath,
              rule: values.rule,
              ...(values.name ? { name: values.name } : {}),
            });
            // The new project is the one the user wants to work in.
            local.select(project.id);
            if (layoutRef.current.layout.maximizedGroupId) {
              layoutRef.current.maximizeGroup(null);
            }
            layoutRef.current.openPage("local", project.id, project.name);
          }}
        />
      ) : null}

      {localProjectDelete ? (
        <ConfirmDialog
          title={t("local.projects.delete")}
          message={t("local.projects.deleteConfirm", {
            name: localProjectDelete.name,
          })}
          busy={localProjectDeleting}
          onCancel={() => setLocalProjectDelete(null)}
          onConfirm={() => void deleteLocalProject()}
        />
      ) : null}

      {/* One preview surface for every inline image/video in the app. */}
      <MediaPreviewHost />

      {/* Last layer: a forced update covers onboarding, dialogs and settings. */}
      <ForceUpdateModal />

      <ToastHost />
    </div>
  );
}
