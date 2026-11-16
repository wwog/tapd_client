import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  AlertCircle,
  Cpu,
  FolderGit2,
  Loader2,
  MessagesSquare,
  Play,
  Plus,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-react";

import {
  agentApi,
  supportsAgentChat,
  type AgentConfig,
  type AgentRuntimeDescriptor,
} from "../lib/agent";
import {
  buildModelOptions,
  readRecentModels,
  readRememberedModel,
  rememberModel,
  useRuntimeModels,
} from "../lib/agentModels";
import { useAgentScan } from "../lib/agentScan";
import { relativeTime, type Workspace } from "../lib/api";
import { chatApi, type ChatSessionView, type ChatStatus } from "../lib/chat";
import type { ToastFn } from "../lib/feature";
import { useAgentChat } from "../hooks/useAgentChat";
import { useChatSessions } from "../hooks/useChatSessions";
import { AgentChatPane } from "./AgentChatPane";
import { AgentIcon } from "./AgentIcon";
import { AgentPicker } from "./AgentPicker";
import { AgentTerminal } from "./AgentTerminal";
import { Segmented } from "./Segmented";
import { SelectPicker } from "./SelectPicker";
import { Badge, Button } from "./ui";

type Props = {
  /** 左侧项目栏当前选中的项目，作为新建会话的默认值。 */
  defaultWorkspaceId: string | null;
  workspaces: Workspace[];
  toast: ToastFn;
  onOpenProjects: () => void;
};

type ChatView = "chat" | "terminal";

const STATUS_META: Record<
  ChatStatus,
  { label: string; tone: "neutral" | "blue" | "green" | "red"; text: string }
> = {
  starting: { label: "启动中", tone: "blue", text: "text-sky-600" },
  running: { label: "运行中", tone: "green", text: "text-emerald-600" },
  stopped: { label: "已停止", tone: "neutral", text: "text-slate-400" },
  failed: { label: "失败", tone: "red", text: "text-rose-600" },
};

/**
 * 对话页：左侧会话列表，右侧新建面板 / 会话详情。
 *
 * 会话由 Rust 端的自由对话子系统管理，与缺陷任务队列无关；对话与终端视图
 * 复用 Agent 页的同一套组件，因此 transcript、权限卡片和 PTY 行为保持一致。
 */
export function ChatPage({
  defaultWorkspaceId,
  workspaces,
  toast,
  onOpenProjects,
}: Props) {
  const { sessions, loading, error, refresh } = useChatSessions();
  const { byRuntime, snapshot: scan } = useAgentScan();

  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [composing, setComposing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [runtimeId, setRuntimeId] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [starting, setStarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** 每个会话显式选择的右侧视图；未选择时按运行时能力决定。 */
  const [viewChoice, setViewChoice] = useState<Record<string, ChatView>>({});
  /** 后端读取的运行时模型列表；与任务启动表单共用。 */
  const { models: runtimeModels, loading: modelsLoading } = useRuntimeModels(runtimeId);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([agentApi.configGet(), agentApi.runtimes()])
      .then(([configResult, runtimeResult]) => {
        if (cancelled) return;
        setConfig(configResult.config);
        setRuntimes(runtimeResult.runtimes.filter((runtime) => runtime.available));
      })
      .catch((cause) => toast("error", String(cause)));
    return () => {
      cancelled = true;
    };
  }, [toast]);

  /** 只有配置了本地仓库目录的项目才能开启会话。 */
  const projects = useMemo(() => {
    const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
    return Object.entries(config?.projects ?? {})
      .map(([id, project]) => ({
        id,
        name: names.get(id) ?? id,
        repoPath: project.repoPath.trim(),
      }))
      .filter((project) => project.repoPath.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [config, workspaces]);

  const selected = sessions?.find((session) => session.id === selectedId) ?? null;
  // 新建表单的运行时（与当前选中会话无关）。
  const formRuntime = runtimes.find((runtime) => runtime.id === runtimeId);
  const permissionOptions = formRuntime?.permissions ?? [];
  /** 最近选择的模型，选择后立即刷新菜单里的「最近使用」分组。 */
  const recentModels = useMemo(() => readRecentModels(runtimeId), [model, runtimeId]);
  /** 静态建议 + CLI 读取结果去重；首项永远是「默认模型」。 */
  const modelOptions = useMemo(
    () => buildModelOptions(runtimeModels, formRuntime?.models, model, recentModels),
    [formRuntime, model, recentModels, runtimeModels],
  );

  // 首次拿到列表时选中最近一条；删除或切换后自动回到可用状态。
  useEffect(() => {
    if (composing) return;
    if (selectedId && sessions?.some((session) => session.id === selectedId)) return;
    setSelectedId(sessions?.[0]?.id ?? null);
  }, [sessions, selectedId, composing]);

  // 新建表单的默认项目：优先跟随左侧项目栏。
  useEffect(() => {
    if (projectId && projects.some((project) => project.id === projectId)) return;
    const preferred =
      projects.find((project) => project.id === defaultWorkspaceId) ?? projects[0];
    setProjectId(preferred?.id ?? "");
  }, [projects, defaultWorkspaceId, projectId]);

  // 默认运行时：设置里的默认值，其次第一个已安装的运行时。
  useEffect(() => {
    if (runtimeId && runtimes.some((runtime) => runtime.id === runtimeId)) return;
    const preferred =
      runtimes.find((runtime) => runtime.id === config?.runtimeId) ?? runtimes[0];
    setRuntimeId(preferred?.id ?? "");
  }, [config, runtimes, runtimeId]);

  // 切换运行时回到上次选择的模型；没有记录时用配置里的默认值。
  useEffect(() => {
    if (!runtimeId) return;
    const defaults = config?.runtimeOptions?.[runtimeId];
    const runtime = runtimes.find((item) => item.id === runtimeId);
    setModel(readRememberedModel(runtimeId) ?? defaults?.model ?? "");
    setPermissionMode(
      defaults?.permissionMode || runtime?.permissions[0]?.id || "",
    );
  }, [runtimeId, config, runtimes]);

  /** 用户选择模型时立即记住，下次新建会话或启动任务时作为默认值。 */
  const chooseModel = (next: string) => {
    setModel(next);
    rememberModel(runtimeId, next);
  };

  const chat = useAgentChat(selected?.id ?? null, selected?.status === "running");
  const running = selected?.status === "running";
  const canChat = supportsAgentChat(selected?.runtimeId);
  const view: ChatView = selected
    ? viewChoice[selected.id] ?? (canChat ? "chat" : "terminal")
    : "chat";
  const currentModel =
    selected?.model || chat.data?.model || selected?.runtime?.model || "";
  const live = running && Boolean(selected?.ready);

  const runtimeName = (id?: string) =>
    runtimes.find((runtime) => runtime.id === id)?.name ?? id ?? "Agent";

  const selectSession = (id: string) => {
    setComposing(false);
    setSelectedId(id);
    setConfirmDelete(null);
  };

  const startSession = async () => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || !runtimeId || starting) return;
    setStarting(true);
    try {
      const { session } = await chatApi.start({
        workspaceId: project.id,
        workspaceName: project.name,
        runtimeId,
        model: model.trim() || undefined,
        permissionMode: permissionMode || undefined,
      });
      await refresh();
      setComposing(false);
      setSelectedId(session.id);
      setConfirmDelete(null);
    } catch (cause) {
      toast("error", String(cause));
    } finally {
      setStarting(false);
    }
  };

  const stopSession = async () => {
    if (!selected) return;
    try {
      await chatApi.stop(selected.id);
      await refresh();
    } catch (cause) {
      toast("error", String(cause));
    }
  };

  const resumeSession = async () => {
    if (!selected) return;
    try {
      await chatApi.resume(selected.id);
      setViewChoice((current) => ({ ...current, [selected.id]: "chat" }));
      await refresh();
    } catch (cause) {
      toast("error", String(cause));
    }
  };

  /** 两步确认：第一次点击只进入确认态，避免误删会话记录。 */
  const removeSession = async () => {
    if (!selected) return;
    if (confirmDelete !== selected.id) {
      setConfirmDelete(selected.id);
      return;
    }
    try {
      // 先按当前列表算出下一条，避免删除后右侧闪回新建面板。
      const remaining = (sessions ?? []).filter((session) => session.id !== selected.id);
      await chatApi.remove(selected.id);
      setConfirmDelete(null);
      setComposing(false);
      setSelectedId(remaining[0]?.id ?? null);
      await refresh();
    } catch (cause) {
      toast("error", String(cause));
    }
  };

  const showForm = composing || !selected;
  const project = projects.find((item) => item.id === projectId);
  const statusMeta = selected ? STATUS_META[selected.status] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-2.5">
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
            <MessagesSquare size={13} className="text-slate-400" />
            <span className="text-ui-sm text-slate-700">会话</span>
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              icon={<Plus size={11} />}
              onClick={() => {
                setComposing(true);
                setSelectedId(null);
                setConfirmDelete(null);
              }}
            >
              新建
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {sessions === null && loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-ui-caption text-slate-400">
                <Loader2 size={13} className="animate-spin" />
                正在读取会话…
              </div>
            ) : error ? (
              <div className="m-1 rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-2 text-ui-xs leading-5 text-rose-700">
                {error}
              </div>
            ) : sessions && sessions.length > 0 ? (
              <div className="space-y-0.5">
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={!composing && session.id === selectedId}
                    runtimeName={runtimeName(session.runtimeId)}
                    onSelect={() => selectSession(session.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-6 text-center text-ui-xs text-slate-400">
                还没有对话记录
              </p>
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          {sessions === null && loading ? (
            <div className="grid min-h-0 flex-1 place-items-center text-ui-caption text-slate-400">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                正在读取会话…
              </div>
            </div>
          ) : !config ? (
            <div className="grid min-h-0 flex-1 place-items-center text-ui-caption text-slate-400">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                正在读取项目配置…
              </div>
            </div>
          ) : showForm ? (
            projects.length === 0 ? (
              <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
                <div className="max-w-md">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                    <FolderGit2 size={22} />
                  </div>
                  <h3
                    className="mt-3 text-ui-lg text-slate-900"
                    title="请先在「项目」页为 TAPD 项目配置本地仓库路径，然后回到这里开启对话。"
                  >
                    还没有可用的项目目录
                  </h3>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-4"
                    onClick={onOpenProjects}
                  >
                    去配置项目
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
                <div className="m-auto w-full max-w-[520px]">
                  <div className="flex flex-col items-center text-center">
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-500">
                      <MessagesSquare size={22} />
                    </div>
                    <h2
                      className="mt-3 text-ui-lg text-slate-900"
                      title="会话会直接在项目仓库目录运行，不创建 worktree。"
                    >
                      新建对话
                    </h2>
                  </div>

                  <div className="mt-6 space-y-4">
                    <Field label="项目">
                      <SelectPicker
                        value={projectId}
                        options={projects.map((item) => ({
                          value: item.id,
                          label: item.name,
                          description: item.repoPath,
                        }))}
                        onChange={setProjectId}
                        placeholder="选择项目"
                        emptyHint="选择已配置仓库的项目"
                        leadingIcon={<FolderGit2 size={14} />}
                        disabled={projects.length === 0}
                      />
                    </Field>

                    <Field label="Agent">
                      <AgentPicker
                        runtimes={runtimes}
                        value={runtimeId}
                        byRuntime={byRuntime}
                        hasScan={Boolean(scan)}
                        disabled={runtimes.length === 0}
                        onChange={setRuntimeId}
                        emptyHint="选择本次对话使用的 Agent"
                        className="w-full"
                      />
                    </Field>

                    <div
                      className={
                        permissionOptions.length > 0 ? "grid grid-cols-2 gap-3" : undefined
                      }
                    >
                      <Field label="模型">
                        <SelectPicker
                          compact
                          searchable
                          allowCustom
                          value={model}
                          options={modelOptions}
                          onChange={chooseModel}
                          leadingIcon={<Cpu size={13} />}
                          placeholder="默认模型"
                          title="本次对话的模型；留空使用运行时的默认模型"
                          menuHint={
                            modelsLoading
                              ? "正在读取模型列表…"
                              : runtimeModels?.error
                                ? "无法读取模型列表，可直接输入模型名"
                                : undefined
                          }
                        />
                      </Field>

                      {permissionOptions.length > 0 ? (
                        <Field label="权限">
                          <SelectPicker
                            compact
                            value={permissionMode || permissionOptions[0]?.id || "default"}
                            options={permissionOptions.map((option) => ({
                              value: option.id,
                              label: option.label,
                              description: option.description,
                            }))}
                            onChange={setPermissionMode}
                            leadingIcon={<ShieldCheck size={13} />}
                            placeholder="默认权限"
                          />
                        </Field>
                      ) : null}
                    </div>

                    {runtimes.length === 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-ui-xs leading-5 text-amber-700">
                        没有检测到可用的 Agent，请先在「Agent → 配置」里检查命令与安装状态。
                      </div>
                    ) : null}

                    <Button
                      variant="primary"
                      className="mt-2 w-full"
                      loading={starting}
                      disabled={!project || !runtimeId}
                      onClick={() => void startSession()}
                      icon={<Play size={12} />}
                    >
                      开始对话
                    </Button>
                  </div>
                </div>
              </div>
            )
          ) : selected ? (
            <>
              <header className="shrink-0 border-b border-slate-100 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <AgentIcon
                    runtimeId={selected.runtimeId}
                    name={runtimeName(selected.runtimeId)}
                    size={20}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h2 className="truncate text-ui-base text-slate-800">
                        {selected.title}
                      </h2>
                      {statusMeta ? (
                        <Badge tone={statusMeta.tone} dot>
                          {statusMeta.label}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-slate-400">
                      <span className="truncate">{selected.workspaceName}</span>
                      <span className="truncate font-mono">
                        {runtimeName(selected.runtimeId)}
                      </span>
                      {currentModel ? (
                        <span className="truncate font-mono" title="当前模型">
                          {currentModel}
                        </span>
                      ) : null}
                      <span className="shrink-0">
                        {relativeTime(selected.updatedAt)}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {running ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Square size={11} />}
                        onClick={() => void stopSession()}
                      >
                        停止
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Play size={11} />}
                        disabled={!selected.agentSessionId}
                        title={
                          selected.agentSessionId
                            ? "用同一个 CLI 会话继续对话"
                            : "该运行时没有捕获到会话 id，无法续接"
                        }
                        onClick={() => void resumeSession()}
                      >
                        继续会话
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={confirmDelete === selected.id ? "danger" : "ghost"}
                      onClick={() => void removeSession()}
                    >
                      {confirmDelete === selected.id ? "确认删除" : "删除"}
                    </Button>
                    {running && canChat ? (
                      <Segmented<ChatView>
                        value={view}
                        onChange={(next) =>
                          setViewChoice((current) => ({
                            ...current,
                            [selected.id]: next,
                          }))
                        }
                        options={[
                          {
                            value: "chat",
                            label: "对话",
                            icon: <MessagesSquare size={11} />,
                          },
                          {
                            value: "terminal",
                            label: "终端",
                            icon: <Terminal size={11} />,
                          },
                        ]}
                      />
                    ) : null}
                  </div>
                </div>

                {selected.error ? (
                  <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-1.5 text-ui-xs leading-5 text-rose-700">
                    <AlertCircle size={12} className="mt-1 shrink-0" />
                    <span className="min-w-0 break-all">{selected.error}</span>
                  </div>
                ) : null}
              </header>

              {running && view === "terminal" ? (
                <div className="min-h-0 flex-1 bg-zinc-950 p-1.5">
                  <AgentTerminal
                    key={selected.id}
                    taskId={selected.id}
                    interactive={running}
                    className="h-full w-full"
                  />
                </div>
              ) : running && !selected.ready && canChat ? (
                <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
                  <div className="max-w-md">
                    <div className="mx-auto grid h-10 w-10 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                      <Loader2 size={18} className="animate-spin" />
                    </div>
                    <p className="mt-2 text-ui-caption text-slate-600">
                      正在启动 Agent…
                    </p>
                    <p className="mt-1 text-ui-2xs leading-5 text-slate-400">
                      首次输出后即可在对话中发送消息，也可以先切换到终端查看启动过程。
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      icon={<Terminal size={11} />}
                      onClick={() =>
                        setViewChoice((current) => ({
                          ...current,
                          [selected.id]: "terminal",
                        }))
                      }
                    >
                      切换到终端
                    </Button>
                  </div>
                </div>
              ) : canChat ? (
                <AgentChatPane
                  key={selected.id}
                  taskId={selected.id}
                  runtimeId={selected.runtimeId}
                  runtimeName={runtimeName(selected.runtimeId)}
                  status={selected.runtime}
                  model={currentModel}
                  chat={chat.data}
                  chatError={chat.error}
                  loading={chat.loading}
                  live={live}
                  chatMode
                  onSwitchToTerminal={() => {
                    if (!running) return;
                    setViewChoice((current) => ({
                      ...current,
                      [selected.id]: "terminal",
                    }));
                  }}
                  toast={toast}
                />
              ) : (
                <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
                  <div className="max-w-md">
                    <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                      <Terminal size={22} />
                    </div>
                    <p className="mt-3 text-ui-base text-slate-700">
                      该运行时不支持对话视图
                    </p>
                    <p className="mt-1 text-ui-xs leading-5 text-slate-400">
                      重新开始会话后，可以在终端中继续操作。
                    </p>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** 新建面板的字段行：统一标签字号与行距。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-ui-sm text-slate-500">{label}</span>
      {children}
    </div>
  );
}

function SessionRow({
  session,
  active,
  runtimeName,
  onSelect,
}: {
  session: ChatSessionView;
  active: boolean;
  runtimeName: string;
  onSelect: () => void;
}) {
  const meta = STATUS_META[session.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        "w-full rounded-lg px-2.5 py-2 text-left transition",
        active
          ? "border border-sky-200 bg-sky-50"
          : "hover:bg-slate-50",
      )}
    >
      <div className="flex items-center gap-1.5">
        <AgentIcon runtimeId={session.runtimeId} name={runtimeName} size={14} />
        <span className="truncate text-ui-caption text-slate-700">
          {session.title}
        </span>
        <span className="ml-auto shrink-0 text-ui-2xs text-slate-400">
          {relativeTime(session.updatedAt)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-[20px] text-ui-2xs">
        <span className="truncate text-slate-400">{session.workspaceName}</span>
        <span className={clsx("ml-auto shrink-0", meta.text)}>{meta.label}</span>
      </div>
    </button>
  );
}
