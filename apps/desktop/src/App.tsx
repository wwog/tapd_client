import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2, PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";

import { api, type BugSummary, type OpenMediaMode } from "./lib/api";
import {
  agentActiveBugIds,
  agentApi,
  agentBugKey,
  type RecoveryReport,
} from "./lib/agent";
import { clearDevSimForTask, DEV_SIM } from "./lib/devSim";
import { useMembersDirectory } from "./lib/members";
import { showToast } from "./lib/toast";
import { useTauriEvent } from "./lib/tauriEvent";
import { startUpdateStore } from "./lib/update";
import { AccountPage } from "./components/AccountPage";
import { AgentPage } from "./components/AgentPage";
import {
  AgentComposeSheet,
  type AgentComposePayload,
} from "./components/AgentComposeSheet";
import { BugListView } from "./components/BugListView";
import { CoworkerPage } from "./components/CoworkerPage";
import { DetailPaneHost } from "./components/DetailPaneHost";
import { FolderPicker } from "./components/FolderPicker";
import { ForceUpdateModal } from "./components/ForceUpdateModal";
import { LoginGate } from "./components/LoginGate";
import { McpPage } from "./components/McpPage";
import { NavRail, type View } from "./components/NavRail";
import { Onboarding } from "./components/Onboarding";
import { ProjectOpenButton } from "./components/ProjectOpenButton";
import { ProjectSettings } from "./components/ProjectSettings";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { SettingsPage } from "./components/SettingsPage";
import { SkeletonRows } from "./components/Skeleton";
import { TitleBar } from "./components/TitleBar";
import { ToastHost } from "./components/ToastHost";
import { Button } from "./components/ui";
import { useAgentQueue } from "./hooks/useAgentQueue";
import {
  useDetailPane,
  type DetailLayoutRef,
  type DetailPaneBridge,
} from "./hooks/useDetailPane";
import {
  DETAIL_PANEL_WIDTH,
  defaultSidebarWidth,
  useSidebarLayout,
} from "./hooks/useSidebarLayout";
import {
  useWorkspaceData,
  type WorkspacePaneBridge,
} from "./hooks/useWorkspaceData";
import type { BugScope } from "./components/bugListPrefs";

/** Minimal bug shape needed to enqueue an Agent task. */
type AgentTarget = {
  workspaceId: string;
  id: string;
  title: string;
  severityLabel: string;
  priorityLabel: string;
  workspaceName?: string;
};

/** Header title for every view whose title is static. */
const VIEW_TITLES: Record<Exclude<View, "bugs">, string> = {
  projects: "项目管理",
  agent: "Agent",
  coworker: "同事",
  mcp: "MCP",
  account: "账户与会话",
  settings: "设置",
};

export default function App() {
  const [scope, setScope] = useState<BugScope>("mine");
  const [view, setView] = useState<View>("bugs");
  const [railAnim, setRailAnim] = useState<{ id: string; token: number } | null>(null);
  const railAnimTimer = useRef<number | null>(null);
  /** Set when the user asks for an Agent fix without a configured folder. */
  const [pendingAgent, setPendingAgent] = useState<{
    target: AgentTarget;
    payload: AgentComposePayload | null;
  } | null>(null);
  /** Bug whose compose sheet (prompt + resources) is open. */
  const [composeAgent, setComposeAgent] = useState<AgentTarget | null>(null);
  const [composeSubmitting, setComposeSubmitting] = useState(false);
  /** Task the island capsule asked us to focus in the Agent tab. */
  const [agentFocusTaskId, setAgentFocusTaskId] = useState<string | null>(null);
  /** Incremented by the title-bar badge to open the approval queue. */
  const [agentReviewFocus, setAgentReviewFocus] = useState(0);
  /** Incremented by 设置 → 默认 Agent to open Agent 页 →「配置」. */
  const [agentConfigFocus, setAgentConfigFocus] = useState(0);

  /** Tasks the backend restored when this system entry began. */
  const [recoveryReport, setRecoveryReport] = useState<RecoveryReport | null>(null);
  /** Report ids the user already dismissed; a re-login must not re-show them. */
  const acknowledgedRecoveryIds = useRef<Set<number>>(new Set());
  /** One request per system entry; failures clear it so the next entry retries. */
  const recoveryRequestedRef = useRef(false);

  useEffect(() => {
    startUpdateStore();
  }, []);

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
    projectListHidden,
    workspace,
    setWorkspaceVisible,
    hideWorkspace,
    handleLogout,
  } = useWorkspaceData({ view, setView, showToast, pane: paneBridgeRef });

  useMembersDirectory(info?.loggedIn ?? false, workspaceId);

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
  // finishes (or the user switches project) fall back to 我负责的 so the list
  // can never sit on a scope whose segment is gone.
  const processingCount = agentActiveBugIds(workspaceId, agentInFlight).length;
  useEffect(() => {
    if (scope === "processing" && processingCount === 0) setScope("mine");
  }, [scope, processingCount]);

  /** Layout values readable from the stable detail callback. */
  const detailLayoutRef = useRef<DetailLayoutRef>({
    viewportWidth: 1280,
    sidebarWidth: defaultSidebarWidth(1280),
    detailWidth: DETAIL_PANEL_WIDTH,
    projectListHidden: false,
  });
  /** Sidebar controls the detail pane needs when it opens / resizes. */
  const detailBridgeRef = useRef<DetailPaneBridge>({
    setSidebarCollapsed: () => undefined,
    setSidebarPeek: () => undefined,
    getSidebarWidth: () => 0,
  });

  const detailPane = useDetailPane({
    workspaceId,
    context,
    me: context?.user.nick ?? info?.me ?? null,
    bumpList,
    showToast,
    layoutRef: detailLayoutRef,
    bridge: detailBridgeRef,
  });

  const sidebar = useSidebarLayout({
    projectListHidden,
    detailRendered: detailPane.rendered,
    detailWidth: detailPane.width,
  });

  // The two panes depend on each other's latest values at event time only;
  // wiring the bridges after both hooks keeps render values in the same frame.
  paneBridgeRef.current = {
    loadBugDetail: detailPane.openDetail,
    closeDetail: detailPane.closeDetail,
  };
  detailBridgeRef.current = {
    setSidebarCollapsed: sidebar.setCollapsed,
    setSidebarPeek: sidebar.setPeek,
    getSidebarWidth: sidebar.getEffectiveWidth,
  };
  detailLayoutRef.current = {
    viewportWidth: sidebar.viewportWidth,
    sidebarWidth: sidebar.expandedWidth,
    detailWidth: detailPane.width,
    projectListHidden,
  };

  /** Switch views and replay the destination's rail icon animation. */
  const activateView = useCallback((id: View) => {
    setView(id);
    setRailAnim({ id, token: Date.now() });
    if (railAnimTimer.current !== null) {
      window.clearTimeout(railAnimTimer.current);
    }
    railAnimTimer.current = window.setTimeout(() => setRailAnim(null), 720);
  }, []);

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
  }, []);

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
    setView("bugs");
    detailPane.closeDetail();
    void api.setLastWorkspace(id);
  };

  const openBug = useCallback(
    (bug: BugSummary) => {
      detailPane.openDetail(bug.workspaceId, bug.id);
    },
    [detailPane.openDetail],
  );

  /** Opens/switches the right-side detail pane without leaving the current view. */
  const openBugById = useCallback(
    (targetWorkspaceId: string, bugId: string) => {
      detailPane.openDetail(targetWorkspaceId, bugId);
    },
    [detailPane.openDetail],
  );

  const doEnqueueAgent = useCallback(
    async (target: AgentTarget, payload: AgentComposePayload | null) => {
      const workspaceName =
        target.workspaceName ||
        context?.workspaces.find((item) => item.id === target.workspaceId)?.name ||
        null;

      try {
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
        });
        // The view switches to the Agent tab and focuses this task; a toast
        // on top of that is just noise.
        setAgentFocusTaskId(task.id);
        setView("agent");
        return true;
      } catch (error) {
        showToast("error", String(error));
        return false;
      }
    },
    [context, showToast],
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
      pending: { target: AgentTarget; payload: AgentComposePayload | null },
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
    (target: Parameters<typeof enqueueAgent>[0]) => void enqueueAgent(target),
    [enqueueAgent],
  );

  /** Open the compose sheet, or jump to the existing task for this bug. */
  const openAgentCompose = useCallback(
    (target: AgentTarget) => {
      const existing = agentInFlight.get(agentBugKey(target.workspaceId, target.id));
      if (existing) {
        openAgentTask(existing.task.id);
        return;
      }
      setComposeAgent(target);
    },
    [agentInFlight, openAgentTask],
  );

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
        showToast("ok", "已复制");
      } catch (error) {
        showToast("error", `复制失败：${String(error)}`);
      }
    },
    [showToast],
  );

  if (!info) {
    return (
      <>
        <div className="flex h-full items-center justify-center gap-2 bg-slate-50 text-ui-caption text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          正在启动客户端…
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

  const title =
    view === "bugs" ? (workspace?.name ?? "缺陷") : VIEW_TITLES[view];
  const subtitle =
    view === "bugs" && !workspace
      ? projectsKnown
        ? "选择左侧项目开始"
        : "正在读取项目…"
      : "";

  const renderView = () => {
    switch (view) {
      case "bugs":
        return contextError ? (
          <div className="p-5">
            <div className="rounded-xl bg-rose-50 p-4 text-ui-caption leading-6 text-rose-700 border border-rose-100">
              <div className="font-normal">项目列表加载失败</div>
              <div className="mt-1 break-all">{contextError}</div>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => void loadContext()}
                icon={<RefreshCw size={13} />}
              >
                重新加载
              </Button>
            </div>
          </div>
        ) : workspace ? (
          <BugListView
            key={workspace.id}
            workspace={workspace}
            me={context?.user.nick ?? info.me}
            scope={scope}
            onScopeChange={setScope}
            onOpenBug={openBug}
            activeBugId={
              // `rendered` (not `open`) keeps the highlight through the close
              // animation, so it fades out with the pane instead of snapping.
              detailPane.rendered && detailPane.target?.workspaceId === workspace.id
                ? detailPane.target.bugId
                : null
            }
            onOpenWeb={openPath}
            onCopy={copy}
            onAgentFix={enqueueAgent}
            onAgentCompose={openAgentCompose}
            agentInFlight={agentInFlight}
            onOpenAgentTask={openAgentTask}
            onCancelTask={cancelAgentTask}
            onClaim={detailPane.claimFromList}
            refreshToken={refreshToken}
          />
        ) : (
          <div className="min-h-0 flex-1 p-4">
            <SkeletonRows
              rows={10}
              columns={["w-2/5", "w-16", "w-12", "w-16", "w-20", "w-16", "w-24"]}
              label="正在加载项目…"
            />
          </div>
        );
      case "projects":
        return (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mx-auto max-w-4xl">
              <ProjectSettings
                context={context}
                hiddenWorkspaceIds={hiddenWorkspaceIds}
                onSetWorkspaceVisible={setWorkspaceVisible}
                toast={showToast}
              />
            </div>
          </div>
        );
      case "agent":
        return (
          <AgentPage
            focusTaskId={agentFocusTaskId}
            focusReviewToken={agentReviewFocus}
            focusConfigToken={agentConfigFocus}
            onOpenBug={openBugById}
            toast={showToast}
            onFocusConsumed={clearAgentFocus}
          />
        );
      case "coworker":
        return <CoworkerPage toast={showToast} />;
      case "mcp":
        return (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <McpPage
              workspaces={context?.workspaces ?? []}
              onCopy={copy}
              toast={showToast}
            />
          </div>
        );
      case "account":
        return (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <AccountPage
              info={info}
              context={context}
              onShowLogin={() => {
                void api
                  .sessionShow()
                  .catch((error) => showToast("error", String(error)));
              }}
              onLogout={handleLogout}
              onRefresh={() => {
                void refreshBase();
                void loadContext();
              }}
              toast={showToast}
            />
          </div>
        );
      default:
        return (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <SettingsPage
              info={info}
              onOpenPath={openPath}
              onCopy={(text) => void copy(text)}
              onShowOnboarding={() => {
                void api
                  .resetOnboarding()
                  .then(() => refreshBase())
                  .catch((error) => showToast("error", String(error)));
              }}
              onManageAgents={() => {
                setAgentConfigFocus((current) => current + 1);
                activateView("agent");
              }}
              toast={showToast}
            />
          </div>
        );
    }
  };

  return (
    <div
      className={clsx(
        "flex h-full flex-col overflow-hidden bg-canvas text-slate-900",
        (sidebar.resizing || detailPane.resizing) && "select-none",
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
        <NavRail
          view={view}
          railAnim={railAnim}
          sidebarHidden={sidebar.hidden}
          meAvatar={info.meAvatar}
          name={context?.user.nick || info.me}
          onActivate={activateView}
        />

        <ProjectSidebar
          context={context}
          contextError={contextError}
          contextLoading={contextLoading}
          visibleWorkspaces={visibleWorkspaces}
          workspaceId={workspaceId}
          view={view}
          account={{
            meAvatar: info.meAvatar,
            name: context?.user.nick || info.me || "已登录",
            company: context?.user.company || "账户与会话",
          }}
          autoCollapse={sidebar.autoCollapse}
          resizing={sidebar.resizing}
          width={sidebar.effectiveWidth}
          projectMenu={projectMenu}
          onRetry={() => void loadContext()}
          onSelectWorkspace={selectWorkspace}
          onOpenAccount={() => activateView("account")}
          onOpenProjectMenu={setProjectMenu}
          onHideWorkspace={hideWorkspace}
          onManageProjects={() => {
            setProjectMenu(null);
            setView("projects");
          }}
          onResizeStart={sidebar.startResize}
        />

        {/* Content panel */}
        <main className="mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface  border border-border">
          <header className="flex h-12 shrink-0 items-center gap-1.5 px-2" data-tauri-drag-region>
            {!projectListHidden ? (
              <button
                type="button"
                aria-label={sidebar.hidden ? "展开项目列表" : "收起项目列表"}
                title={
                  sidebar.autoCollapse
                    ? sidebar.peek
                      ? "收起项目列表"
                      : "展开项目列表（窗口过窄，会自动收起）"
                    : sidebar.hidden
                      ? "展开项目列表"
                      : "收起项目列表"
                }
                onClick={sidebar.toggle}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-overlay hover:text-slate-700"
              >
                {sidebar.hidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              </button>
            ) : null}

            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-ui-base font-normal leading-5 text-slate-900">
                {title}
              </h1>
              {subtitle ? (
                <p className="truncate text-ui-sm leading-4 text-slate-400">{subtitle}</p>
              ) : null}
            </div>

            {view === "bugs" && workspace ? (
              <ProjectOpenButton
                key={workspace.id}
                workspaceId={workspace.id}
                onError={(text) => showToast("error", text)}
              />
            ) : null}

          </header>

          {recoveryReport ? (
            <RecoveryBanner
              report={recoveryReport}
              onOpenTasks={() => activateView("agent")}
              onDismiss={dismissRecoveryReport}
            />
          ) : null}

          {renderView()}
        </main>

        <DetailPaneHost
          rendered={detailPane.rendered}
          open={detailPane.open}
          width={detailPane.width}
          resizing={detailPane.resizing}
          onResizeStart={detailPane.startResize}
          detail={detailPane.detail}
          loading={detailPane.loading}
          error={detailPane.error}
          exporting={detailPane.exporting}
          lastExport={detailPane.lastExport}
          onClose={detailPane.closeDetail}
          onOpenWeb={openPath}
          onCopy={copy}
          onExport={detailPane.exportDetail}
          onAgentFix={handleAgentFix}
          onAgentCompose={openAgentCompose}
          agentInFlight={agentInFlight}
          onOpenAgentTask={openAgentTask}
          onOpenPath={openPath}
          onOpenMedia={openMedia}
          me={context?.user.nick ?? info.me}
          members={detailPane.members}
          membersLoading={detailPane.membersLoading}
          onRefreshMembers={detailPane.refreshMembers}
          onClaim={detailPane.claimFromDetail}
          onAddComment={detailPane.addComment}
          onChangeField={detailPane.changeField}
          onTransition={detailPane.transition}
        />
      </div>

      <AgentComposeSheet
        key={composeAgent ? `${composeAgent.workspaceId}:${composeAgent.id}` : "agent-compose"}
        open={composeAgent !== null}
        title={composeAgent?.title ?? ""}
        submitting={composeSubmitting}
        onClose={() => setComposeAgent(null)}
        onSubmit={(payload) => void submitAgentCompose(payload)}
        toast={showToast}
      />

      {pendingAgent ? (
        <FolderPicker
          open
          title="没有配置项目目录"
          description={`${
            pendingAgent.target.workspaceName || pendingAgent.target.workspaceId
          } 还没有设置本地仓库目录。选择后会自动加入 Agent 队列。`}
          confirmLabel="使用并继续"
          onCancel={() => setPendingAgent(null)}
          onSelect={(path) => void applyAgentFolder(pendingAgent, path)}
        />
      ) : null}

      {!info.onboarded ? (
        <Onboarding info={info} onDone={() => void refreshBase()} />
      ) : null}

      {/* Last layer: a forced update covers onboarding, dialogs and settings. */}
      <ForceUpdateModal />

      <ToastHost />
    </div>
  );
}
