import {
  Bug,
  FolderGit2,
  FolderOpen,
  Loader2,
  MessagesSquare,
  Square,
  Terminal,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  canOpenAgentWorktree,
  type AgentRuntimePhase,
  type AgentRuntimeStatus,
  type AgentTask,
} from "../lib/agent";
import { useAgentTaskChanges } from "../lib/agentStore";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { t } from "../lib/i18n";
import { ActivityGlyph } from "./ActivityGlyph";
import { AgentIcon } from "./AgentIcon";
import { Segmented } from "./Segmented";
import { ScrollingName } from "./ScrollingName";
import { Badge, Button } from "./ui";

/** 运行 tab 右侧的两种视图：结构化对话或原始 TUI。 */
export type AgentChatView = "chat" | "terminal";

const RUNTIME_TONES = {
  idle: "neutral",
  working: "blue",
  waiting_permission: "amber",
  waiting_question: "cyan",
  error: "red",
} as const satisfies Record<
  AgentRuntimePhase,
  "neutral" | "blue" | "amber" | "cyan" | "red"
>;

type Props = {
  task: AgentTask;
  /** Human-readable name of the runtime that owns this task. */
  runtimeName?: string;
  /** 运行中的当前动作、等待状态与最后消息。 */
  runtimeStatus?: AgentRuntimeStatus;
  canCancel: boolean;
  actionBusy: string | null;
  live: boolean;
  /** 对话 / 终端切换；不传时只显示终端。 */
  view?: AgentChatView;
  chatSupported?: boolean;
  /** 当前运行使用的模型；显式选择或 transcript 里识别到的。 */
  model?: string | null;
  /** 任务选定的访问权限。 */
  permissionLabel?: string | null;
  permissionId?: string | null;
  /** Change panel state, controlled by the page from the +A −D badge. */
  changesOpen?: boolean;
  onToggleChanges?: () => void;
  onOpenWorktree?: () => void;
  onViewChange?: (view: AgentChatView) => void;
  onCancel: () => void;
  onOpenExportDir: () => void;
  onOpenBug: () => void;
};

/** Title, metadata and action buttons above the live terminal. */
export function AgentTaskHeader(props: Props) {
  const {
    task,
    runtimeName,
    runtimeStatus,
    canCancel,
    actionBusy,
    live,
    view = "terminal",
    chatSupported = false,
    model,
    permissionLabel,
    permissionId,
    changesOpen,
    onToggleChanges,
    onOpenWorktree,
    onViewChange,
    onCancel,
    onOpenExportDir,
    onOpenBug,
  } = props;

  // Live push first: it is the freshest summary while the task runs; the task
  // snapshot's own `changes` covers everything else.
  const pushedChanges = useAgentTaskChanges(task.id);
  const changes = pushedChanges ?? task.changes ?? null;

  return (
    <div className="shrink-0 border-b border-slate-100 px-3.5 py-2.5">
      <div className="flex flex-wrap items-start gap-2.5">
        <AgentIcon
          runtimeId={task.runtimeId}
          name={runtimeName}
          size={28}
          className="mt-0.5 rounded-lg"
        />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-[16ch] flex-1 text-ui-base font-normal text-slate-900">
              <ScrollingName text={bugTitle(task.title) || t("agent.untitled")} />
            </h2>
            <Badge tone={AGENT_STATUS_TONES[task.status]}>
              {t(AGENT_STATUS_LABELS[task.status])}
            </Badge>
            {runtimeName ? <Badge tone="neutral">{runtimeName}</Badge> : null}
            {model ? (
              <Badge tone="neutral" className="max-w-[22ch] truncate font-mono">
                {model}
              </Badge>
            ) : null}
            {permissionLabel && permissionId !== "default" ? (
              <Badge tone={permissionId === "full_access" ? "amber" : "neutral"}>
                {permissionLabel}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
            <span className="shrink-0">
              {task.workspaceName || task.workspaceId} · #
              {task.bugId.slice(-7)}
            </span>
            {/* The expanded panel shows the same totals, so the header keeps
                them only while it is the collapse affordance. */}
            {changes && onToggleChanges && !changesOpen ? (
              <button
                type="button"
                onClick={onToggleChanges}
                aria-expanded={false}
                title={t("agent.changes.toggle")}
                className="inline-flex shrink-0 items-center gap-1 rounded-md transition hover:bg-slate-100"
              >
                {changes.additions > 0 || changes.deletions > 0 ? (
                  <ChangeStats
                    additions={changes.additions}
                    deletions={changes.deletions}
                  />
                ) : (
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 tabular-nums text-slate-500">
                    {t("agent.changes.files", { count: changes.files.length })}
                  </span>
                )}
              </button>
            ) : null}
            {task.worktreeBranch ? (
              <span
                className="min-w-0 max-w-full truncate font-mono text-sky-700"
                title={task.worktreePath ?? task.worktreeBranch}
              >
                ⎇ {task.worktreeBranch}
              </span>
            ) : (
              <span
                className="min-w-0 max-w-full truncate font-mono"
                title={task.repoPath}
              >
                {task.repoPath || t("agent.noRepo")}
              </span>
            )}
            {task.startedAt ? (
              <span className="shrink-0">
                {t("agent.header.startedAt", { time: relativeTime(task.startedAt) })}
              </span>
            ) : null}
            {live ? (
              <span className="shrink-0">{t("agent.header.selectionHint")}</span>
            ) : null}
            {task.exitCode !== undefined ? (
              <span className="shrink-0">exit {task.exitCode}</span>
            ) : null}
          </div>
          {runtimeStatus ? (
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs">
              <Badge tone={RUNTIME_TONES[runtimeStatus.phase]} dot>
                {runtimeStatus.label}
              </Badge>
              {runtimeStatus.tool ? (
                <span className="truncate font-mono text-slate-500">
                  {runtimeStatus.tool}
                </span>
              ) : null}
              {runtimeStatus.subagents > 0 ? (
                <span className="text-slate-500">
                  {t("agent.header.subagents", {
                    count: runtimeStatus.subagents,
                  })}
                </span>
              ) : null}
              {runtimeStatus.model ? (
                <span className="truncate text-slate-400">{runtimeStatus.model}</span>
              ) : null}
            </div>
          ) : null}
          {runtimeStatus?.message || runtimeStatus?.detail ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-500">
              <ActivityGlyph seed={task.id} />
              <span
                className="truncate"
                title={runtimeStatus.message ?? runtimeStatus.detail}
              >
                {runtimeStatus.message ?? runtimeStatus.detail}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {onViewChange ? (
            <Segmented<AgentChatView>
              value={view}
              onChange={onViewChange}
              options={[
                {
                  value: "chat",
                  label: t("agent.view.chat"),
                  icon: <MessagesSquare size={11} />,
                  disabled: !chatSupported,
                },
                {
                  value: "terminal",
                  label: t("agent.view.terminal"),
                  icon: <Terminal size={11} />,
                },
              ]}
            />
          ) : null}
          {onOpenWorktree && canOpenAgentWorktree(task) ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderGit2 size={11} />}
              onClick={onOpenWorktree}
            >
              {t("agent.changes.openWorktree")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            icon={
              actionBusy === `cancel:${task.id}` ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Square size={11} />
              )
            }
            disabled={!canCancel || actionBusy !== null}
            onClick={onCancel}
          >
            {t("agent.header.stop")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderOpen size={11} />}
            disabled={!task.jsonPath}
            onClick={onOpenExportDir}
          >
            {t("agent.header.openExport")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Bug size={11} />}
            onClick={onOpenBug}
          >
            {t("agent.openBug")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** `+A −D` pair; a side with no lines is omitted instead of printing `0`. */
function ChangeStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <>
      {additions > 0 ? (
        <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-ui-xs tabular-nums text-emerald-700">
          +{additions}
        </span>
      ) : null}
      {deletions > 0 ? (
        <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-ui-xs tabular-nums text-rose-700">
          −{deletions}
        </span>
      ) : null}
    </>
  );
}
