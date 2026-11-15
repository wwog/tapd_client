import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, type BugSummary, type OpenMediaMode } from "./lib/api";
import {
  agentActiveBugIds,
  agentApi,
  agentBugKey,
  type RecoveryReport,
} from "./lib/agent";
import { clearDevSimForTask, DEV_SIM } from "./lib/devSim";
import { t } from "./lib/i18n";
import { localApi, type LocalProject, type WorkItem } from "./lib/local";
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
import {
  AgentComposeSheet,
  type AgentComposePayload,
} from "./components/AgentComposeSheet";
import { CompanionDialog } from "./components/CompanionDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Dialog } from "./components/Dialog";
import { FolderPicker } from "./components/FolderPicker";
import { ForceUpdateModal } from "./components/ForceUpdateModal";
import { LocalProjectDialog } from "./components/LocalProjectDialog";
import { LoginGate } from "./components/LoginGate";
import { Onboarding } from "./components/Onboarding";
import { ProjectOpenButton } from "./components/ProjectOpenButton";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { TitleBar } from "./components/TitleBar";
import { ToastHost } from "./components/ToastHost";
import { Button } from "./components/ui";
import { useAgentQueue } from "./hooks/useAgentQueue";
import { useLocalProjects } from "./hooks/useLocalProjects";
import { usePoll } from "./hooks/usePoll";
import { useDetailPane } from "./hooks/useDetailPane";
import { useSidebarLayout } from "./hooks/useSidebarLayout";
import { useTerminalPanel } from "./hooks/useTerminalPanel";
import {
  useWorkspaceData,
  type WorkspacePaneBridge,
} from "./hooks/useWorkspaceData";
import type { BugScope } from "./components/bugListPrefs";
import {
  GROUP_GAP,
  PANEL_MIN_SIZE,
  groupMinSize,
} from "./workbench/layout/defaults";
import {
  panelId,
  type PageView,
  type PanelRef,
  type WorkbenchLayoutApi,
} from "./workbench/layout/types";
import { activeView } from "./workbench/layout/ops";
import { useWorkbenchLayout } from "./workbench/layout/useWorkbenchLayout";
import { Workbench } from "./workbench/Workbench";
import { Sash } from "./workbench/components/Sash";
import { clearDirtyPanels, hasDirtyPanels } from "./workbench/panels/dirty";
import type { PageHostServices } from "./workbench/components/pageContext";

/** Minimal bug shape needed to enqueue an Agent task. */
type BugAgentTarget = {
  kind: "bug";
  workspaceId: string;
  id: string;
  title: string;
  severityLabel: string;
  priorityLabel: string;
  workspaceName?: string;
};

/** A local work item handed to an Agent; never has a bug or TAPD workspace. */
type LocalAgentTarget = {
  kind: "local";
  projectId: string;
  itemId: string;
  title: string;
};

type AgentTarget = BugAgentTarget | LocalAgentTarget;

const bugTarget = (
  bug: BugSummary & { workspaceName?: string },
): BugAgentTarget => ({
  kind: "bug",
  workspaceId: bug.workspaceId,
  id: bug.id,
  title: bug.title,
  severityLabel: bug.severityLabel,
  priorityLabel: bug.priorityLabel,
  workspaceName: bug.workspaceName,
});

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
  const layoutApi = useWorkbenchLayout();
  const view = activeView(layoutApi.layout);
  const setView = useCallback(
    (next: View) => {
      // Switching pages must reveal the primary dock even if another group was
      // maximized (notification jumps, activity-bar clicks).
      if (layoutApi.layout.maximizedGroupId) layoutApi.maximizeGroup(null);
      layoutApi.openPage(next);
    },
    [layoutApi.maximizeGroup, layoutApi.openPage, layoutApi.layout.maximizedGroupId],
  );
  const [railAnim, setRailAnim] = useState<{ id: string; token: number } | null>(null);
  const railAnimTimer = useRef<number | null>(null);
  /** Set when the user asks for an Agent fix without a configured folder. */
  const [pendingAgent, setPendingAgent] = useState<{
    target: BugAgentTarget;
    payload: AgentComposePayload | null;
  } | null>(null);
  /** Bug whose compose sheet (prompt + resources) is open. */
  const [composeAgent, setComposeAgent] = useState<AgentTarget | null>(null);
  const [composeSubmitting, setComposeSubmitting] = useState(false);
  /** Task the island capsule asked us to focus in the Agent tab. */
  const [agentFocusTaskId, setAgentFocusTaskId] = useState<string | null>(null);
  /** Incremented by the title-bar badge to open the approval queue. */
  const [agentReviewFocus, setAgentReviewFocus] = useState(0);
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
  /** Create (`project: null`) / edit dialog, opened from the side bar or projects page. */
  const [localProjectDialog, setLocalProjectDialog] = useState<{
    project: LocalProject | null;
  } | null>(null);
  const [localProjectDelete, setLocalProjectDelete] = useState<LocalProject | null>(
    null,
  );
  const [localProjectDeleting, setLocalProjectDeleting] = useState(false);
  /** Bumped after an enqueue so the items page refetches its Agent task links. */
  const [localItemsToken, setLocalItemsToken] = useState(0);

  /** Tasks the backend restored when this system entry began. */
  const [recoveryReport, setRecoveryReport] = useState<RecoveryReport | null>(null);
  /** Report ids the user already dismissed; a re-login must not re-show them. */
  const acknowledgedRecoveryIds = useRef<Set<number>>(new Set());
  /** One request per system entry; failures clear it so the next entry retries. */
  const recoveryRequestedRef = useRef(false);

  useEffect(() => {
    startUpdateStore();
    void refreshCompanionStatus();
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

  // Pending commit reviews are surfaced in the title bar so they cannot be
  // forgotten behind the Agent tab.
  const { pendingReviews, agentInFlight } = useAgentQueue();

  /** Detail actions read by workspace events without a hook-order cycle. */
  const paneBridgeRef = useRef<WorkspacePaneBridge>({
    loadBugDetail: () => undefined,
    closeDetail: () => undefined,
  });

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
    projectListHidden: workspaceListHidden,
    workspace,
    setWorkspaceVisible,
    hideWorkspace,
    handleLogout,
  } = useWorkspaceData({ view, setView, showToast, pane: paneBridgeRef });

  /**
   * The column hides only for a single TAPD project with no local projects:
   * local rows are part of the same list, so they must keep it visible.
   */
  const projectListHidden = workspaceListHidden && local.projects.length === 0;

  // Members belong to the page's TAPD workspace. A local selection is only
  // relevant while the local page is active, so it must not suppress members
  // when the user switches back to the bug list.
  useMembersDirectory(
    info?.loggedIn ?? false,
    view === "local" ? "" : workspaceId,
  );

  // The workflow may only be initialized after login + onboarding; the backend
  // rejects an earlier call. One request per system entry, and a failure clears
  // the guard so the next entry can retry.
  const sessionReady = info?.loggedIn === true && info?.onboarded === true;
  useEffect(() => {
    if (!sessionReady) {
      // Logout / onboarding reset re-arms the request for the next entry.
      recoveryRequestedRef.current = false;
      return;
    }
    if (recoveryRequestedRef.current) return;
    recoveryRequestedRef.current = true;

    void agentApi
      .enterSystem()
      .then(({ report }) => {
        if (!report) return;
        if (acknowledgedRecoveryIds.current.has(report.id)) return;
        setRecoveryReport((current) => (current?.id === report.id ? current : report));
      })
      .catch((error) => {
        // Older backends lack this command; the main UI must stay usable.
        recoveryRequestedRef.current = false;
        showToast("error", String(error));
      });
  }, [sessionReady, showToast]);

  /** Remember the dismissal so the same report never reappears after re-login. */
  const dismissRecoveryReport = useCallback(() => {
    setRecoveryReport((report) => {
      if (report) acknowledgedRecoveryIds.current.add(report.id);
      return null;
    });
  }, []);

  // 处理中 exists only while an agent works on this project; when the last one
  // finishes (or the user switches project) fall back to 我负责的 so the lis
  // can never sit on a scope whose segment is gone.
  const processingCount = agentActiveBugIds(workspaceId, agentInFlight).length;
  useEffect(() => {
    if (scope === "processing" && processingCount === 0) setScope("mine");
  }, [scope, processingCount]);

  /** Latest layout API for stable callbacks and effects. */
  const layoutRef = useRef(layoutApi);
  layoutRef.current = layoutApi;

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

  const sidebar = useSidebarLayout({
    projectListHidden,
    sidebarWidth: layoutApi.sidebarWidth,
    setSidebarWidth: layoutApi.setSidebarWidth,
    contentMinWidth: layoutContentMinWidth(layoutApi),
  });

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
   * ⌘J / rail toggle. Hiding keeps every PTY alive; showing restores the tabs,
   * spawns the first shell when there is none, and focuses the bottom dock.
   */
  const toggleTerminal = useCallback(() => {
    if (!terminal.hidden && hasTerminalPanels) {
      terminal.hide();
      return;
    }
    terminal.show();
    wantTerminalFocus.current = true;
    if (terminal.sessions.length === 0) terminal.create();
  }, [
    hasTerminalPanels,
    terminal.create,
    terminal.hide,
    terminal.hidden,
    terminal.sessions.length,
    terminal.show,
  ]);

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

  // The bugs page tab is the workspace name; update it when the project
  // switches (the tab label is persisted with the panel).
  const bugsPagePanel = layoutApi.groups
    .flatMap((group) => group.panels)
    .find((panel) => panel.id === panelId.page("bugs"));
  useEffect(() => {
    if (!bugsPagePanel) return;
    const label = workspace?.name ?? t("common.bugs");
    if (bugsPagePanel.label === label) return;
    layoutRef.current.setPanelLabel(bugsPagePanel.id, label);
  }, [bugsPagePanel?.id, bugsPagePanel?.label, workspace?.name]);

  // The items page tab follows the selected local project, falling back to the
  // generic page name when nothing is selected.
  const localPagePanel = layoutApi.groups
    .flatMap((group) => group.panels)
    .find((panel) => panel.id === panelId.page("local"));
  useEffect(() => {
    if (!localPagePanel) return;
    const label = localProject?.name ?? t("app.nav.local");
    if (localPagePanel.label === label) return;
    layoutRef.current.setPanelLabel(localPagePanel.id, label);
  }, [localPagePanel?.id, localPagePanel?.label, localProject?.name]);

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

  // The island capsule can jump straight to a task.
  useTauriEvent<{ taskId: string }>("agent://focus", (payload) => {
    setView("agent");
    setAgentFocusTaskId(payload.taskId);
  });

  /** Jump to a live agent task instead of enqueuing the same bug twice. */
  const openAgentTask = useCallback((taskId: string) => {
    setAgentFocusTaskId(taskId);
    setView("agent");
  }, [setView]);

  /** The focus request is one-shot: the Agent page clears it after applying. */
  const clearAgentFocus = useCallback(() => {
    setAgentFocusTaskId(null);
    setAgentReviewFocus(0);
  }, []);

  /** Row 取消 for a local task: queued is removed, running is interrupted. */
  const cancelAgentTask = useCallback(
    async (taskId: string) => {
      if (DEV_SIM && clearDevSimForTask(taskId)) return;
      try {
        await agentApi.cancel(taskId);
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [showToast],
  );

  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    // Keep the local page's last project as a separate context: the sidebar
    // highlights whichever page is active, and the row is still there when
    // the user comes back to 事项.
    setView("bugs");
    // Detail belongs to the previous project: drop both the panel and its data.
    detailPane.closeDetail();
    void api.setLastWorkspace(id);
  };

  const selectLocalProject = (id: string) => {
    local.select(id);
    // The bug detail belongs to TAPD; the local page has no such panel.
    detailPane.closeDetail();
    setView("local");
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

  const doEnqueueAgent = useCallback(
    async (target: AgentTarget, payload: AgentComposePayload | null) => {
      try {
        // Local work items read the folder from the project itself, so the
        // missing-folder prompt below does not apply to them.
        if (target.kind === "local") {
          // The item description already travels in quest.json; the compose
          // prompt is only the user's additional instructions for this run.
          const prompt = payload?.prompt.trim() ?? "";
          const { task } = await localApi.enqueueItem(target.itemId, {
            extraPrompt: prompt.length > 0 ? prompt : null,
            attachments: payload?.attachments.length
              ? payload.attachments
              : undefined,
            runtimeId: payload?.runtimeId ?? null,
            model: payload?.model ?? null,
            permissionMode: payload?.permissionMode ?? null,
          });
          setAgentFocusTaskId(task.id);
          // The item now carries the new task id; refetch the item list.
          setLocalItemsToken((token) => token + 1);
          setView("agent");
          return true;
        }

        const workspaceName =
          target.workspaceName ||
          context?.workspaces.find((item) => item.id === target.workspaceId)?.name ||
          null;

        const { task } = await agentApi.enqueueBug({
          workspaceId: target.workspaceId,
          bugId: target.id,
          workspaceName,
          title: target.title,
          severity: target.severityLabel,
          priority: target.priorityLabel,
          extraPrompt: payload?.prompt.trim() ? payload.prompt : null,
          attachments: payload?.attachments.length ? payload.attachments : undefined,
          // 提交面板可以为本次任务单独选 Agent；为空时后端用默认运行时。
          runtimeId: payload?.runtimeId ?? null,
          model: payload?.model ?? null,
          permissionMode: payload?.permissionMode ?? null,
        });
        // The view switches to the Agent tab and focuses this task; a toas
        // on top of that is just noise.
        setAgentFocusTaskId(task.id);
        setView("agent");
        return true;
      } catch (error) {
        showToast("error", String(error));
        return false;
      }
    },
    [context, setView, showToast],
  );

  /**
   * Asks for the project folder first when none is configured, then enqueues.
   * Returns "queued" when the task exists (or is focused instead of duplicated)
   * and "needs_folder" when the picker took over.
   */
  const enqueueAgent = useCallback(
    async (
      target: AgentTarget,
      payload: AgentComposePayload | null = null,
    ): Promise<"queued" | "needs_folder" | "error"> => {
      if (target.kind === "local") {
        return (await doEnqueueAgent(target, payload)) ? "queued" : "error";
      }

      // The bug is already queued/running: focus that task instead of creating
      // a duplicate. The list and drawer also disable the action, this covers
      // stale snapshots and notification-triggered flows.
      const existing = agentInFlight.get(agentBugKey(target.workspaceId, target.id));
      if (existing) {
        openAgentTask(existing.task.id);
        return "queued";
      }

      try {
        const { config } = await agentApi.configGet();
        const repoPath = (config.projects?.[target.workspaceId]?.repoPath ?? "").trim();
        if (!repoPath) {
          setPendingAgent({ target, payload });
          return "needs_folder";
        }
      } catch (error) {
        showToast("error", String(error));
        return "error";
      }
      return (await doEnqueueAgent(target, payload)) ? "queued" : "error";
    },
    [agentInFlight, doEnqueueAgent, openAgentTask, showToast],
  );

  const applyAgentFolder = useCallback(
    async (
      pending: { target: BugAgentTarget; payload: AgentComposePayload | null },
      path: string,
    ) => {
      setPendingAgent(null);
      try {
        const { config } = await agentApi.configGet();
        const projects = {
          ...(config.projects ?? {}),
          [pending.target.workspaceId]: {
            ...(config.projects?.[pending.target.workspaceId] ?? {
              repoPath: "",
              rule: "",
            }),
            repoPath: path,
          },
        };
        await agentApi.configSet({ projects });
      } catch (error) {
        showToast("error", String(error));
        return;
      }
      if (await doEnqueueAgent(pending.target, pending.payload)) {
        setComposeAgent(null);
      }
    },
    [doEnqueueAgent, showToast],
  );

  const handleAgentFix = useCallback(
    (bug: BugSummary & { workspaceName?: string }) =>
      void enqueueAgent(bugTarget(bug)),
    [enqueueAgent],
  );

  /** Open the compose sheet, or jump to the existing task for this bug. */
  const openAgentCompose = useCallback(
    (target: AgentTarget) => {
      if (target.kind === "local") {
        setComposeAgent(target);
        return;
      }
      const existing = agentInFlight.get(agentBugKey(target.workspaceId, target.id));
      if (existing) {
        openAgentTask(existing.task.id);
        return;
      }
      setComposeAgent(target);
    },
    [agentInFlight, openAgentTask],
  );

  /** Compose entry for a bug row / detail drawer (wraps it in a bug target). */
  const composeBugAgent = useCallback(
    (bug: BugSummary & { workspaceName?: string }) => openAgentCompose(bugTarget(bug)),
    [openAgentCompose],
  );

  /** Compose entry for one local work item; the description stays in quest.json. */
  const composeLocalItem = useCallback((project: LocalProject, item: WorkItem) => {
    setComposeAgent({
      kind: "local",
      projectId: project.id,
      itemId: item.id,
      title: item.title,
    });
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

  const submitAgentCompose = useCallback(
    async (payload: AgentComposePayload) => {
      if (!composeAgent || composeSubmitting) return;
      setComposeSubmitting(true);
      try {
        const result = await enqueueAgent(composeAgent, payload);
        // A missing repo keeps the sheet open behind the folder picker, so the
        // typed instructions survive a cancel.
        if (result === "queued") setComposeAgent(null);
      } finally {
        setComposeSubmitting(false);
      }
    },
    [composeAgent, composeSubmitting, enqueueAgent],
  );

  const openPath = useCallback(
    (path: string) => {
      void api.openPath(path).catch((error) => showToast("error", String(error)));
    },
    [showToast],
  );

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

  const activeBugId =
    detailPane.target && detailPane.target.workspaceId === workspace?.id
      ? detailPane.target.bugId
      : null;

  const primaryGroup =
    layoutApi.groups.find((group) => group.role === "primary") ??
    layoutApi.groups[0];
  const primaryActivePanel = primaryGroup?.panels.find(
    (panel) => panel.id === primaryGroup.activePanelId,
  );
  const primaryView: PageView | null =
    primaryActivePanel?.resource.type === "page"
      ? primaryActivePanel.resource.view
      : null;

  const primaryActions = (
    <>
      {!projectListHidden ? (
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
      ) : null}
      {primaryView === "bugs" && workspace ? (
        <ProjectOpenButton
          key={workspace.id}
          workspaceId={workspace.id}
          onError={(text) => showToast("error", text)}
        />
      ) : null}
    </>
  );

  /** Sign out after the unsaved-edit confirmation (if any). */
  const performLogout = () => {
    const panels = layoutRef.current.groups.flatMap((group) => group.panels);
    for (const panel of panels) {
      if (panel.kind !== "page") layoutRef.current.closePanel(panel.id);
    }
    layoutRef.current.openPage("bugs");
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
    activeBugId,
    localProjects: local.projects,
    localProject,
    localItemsToken,
    localLoading: local.loading,
    localError: local.error,
    projectsKnown,
    hiddenWorkspaceIds,
    agentInFlight,
    agentFocusTaskId,
    agentReviewFocus,
    refreshToken,
    toast: showToast,
    onOpenBug: openBug,
    onOpenBugById: openBugById,
    onOpenWeb: openPath,
    onOpenPath: openPath,
    onCopy: copy,
    onClaim: detailPane.claimFromList,
    onAgentFix: handleAgentFix,
    onAgentCompose: composeBugAgent,
    onOpenAgentTask: openAgentTask,
    onCancelTask: cancelAgentTask,
    onClearAgentFocus: clearAgentFocus,
    onSetWorkspaceVisible: setWorkspaceVisible,
    onSelectLocalProject: selectLocalProject,
    onCreateLocalProject: () => setLocalProjectDialog({ project: null }),
    onEditLocalProject: (project) => setLocalProjectDialog({ project }),
    onDeleteLocalProject: (project) => setLocalProjectDelete(project),
    onComposeLocalItem: composeLocalItem,
    onOpenMedia: openMedia,
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
    openPath,
    workspaceName: (targetWorkspaceId: string) =>
      context?.workspaces.find((item) => item.id === targetWorkspaceId)?.name ??
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
      agentInFlight,
      onOpenWeb: openPath,
      onCopy: copy,
      onExport: detailPane.exportDetail,
      onAgentFix: handleAgentFix,
      onAgentCompose: composeBugAgent,
      onOpenAgentTask: openAgentTask,
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

  const banner = recoveryReport ? (
    <RecoveryBanner
      report={recoveryReport}
      onOpenTasks={() => activateView("agent")}
      onDismiss={dismissRecoveryReport}
    />
  ) : null;

  /** Project menu entry: the read-only explorer opens in the secondary dock. */
  const openExplorer = (targetWorkspaceId: string) => {
    const name =
      context?.workspaces.find((item) => item.id === targetWorkspaceId)?.name ??
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
      className={clsx(
        "flex h-full flex-col overflow-hidden bg-canvas text-slate-900",
        sidebar.resizing && "select-none",
      )}
    >
      <TitleBar
        pendingReviews={pendingReviews}
        onOpenReviews={() => {
          activateView("agent");
          setAgentReviewFocus((token) => token + 1);
        }}
        onOpenAccount={() => activateView("account")}
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
          workspaceId={workspaceId}
          localProjects={local.projects}
          localProjectId={view === "local" ? local.selectedId : null}
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
          // The shared Sash overlays the old handle; its mousedown is inert.
          onResizeStart={(event) => event.preventDefault()}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Workbench
            layout={layoutApi}
            services={services}
            page={page}
            primaryActions={primaryActions}
            banner={banner}
          />

          {!sidebar.hidden && !projectListHidden ? (
            <Sash
              axis="x"
              label={t("settings.sidebar.resizeLabel")}
              className="z-20"
              style={{ left: -6, top: 0, width: 8, height: "100%" }}
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

      <AgentComposeSheet
        key={
          composeAgent
            ? composeAgent.kind === "local"
              ? `local:${composeAgent.projectId}:${composeAgent.itemId}`
              : `${composeAgent.workspaceId}:${composeAgent.id}`
            : "agent-compose"
        }
        open={composeAgent !== null}
        title={composeAgent?.title ?? ""}
        plainTitle={composeAgent?.kind === "local"}
        heading={
          composeAgent?.kind === "local" ? t("local.items.toAgent") : undefined
        }
        submitting={composeSubmitting}
        onClose={() => setComposeAgent(null)}
        onSubmit={(payload) => void submitAgentCompose(payload)}
        toast={showToast}
      />

      {pendingAgent ? (
        <FolderPicker
          open
          title={t("app.agent.noFolder")}
          description={t("app.agent.noFolderHint", {
            name: pendingAgent.target.workspaceName || pendingAgent.target.workspaceId,
          })}
          confirmLabel={t("app.agent.useAndContinue")}
          onCancel={() => setPendingAgent(null)}
          onSelect={(path) => void applyAgentFolder(pendingAgent, path)}
        />
      ) : null}

      {!info.onboarded ? (
        <Onboarding info={info} onDone={() => void refreshBase()} />
      ) : null}

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
            setView("local");
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

      {/* Last layer: a forced update covers onboarding, dialogs and settings. */}
      <ForceUpdateModal />

      <ToastHost />
    </div>
  );
}
