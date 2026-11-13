import { useEffect, useState, type Ref } from "react";
import clsx from "clsx";
import {
  Archive,
  Bug,
  Check,
  Eye,
  FolderOpen,
  GitMerge,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";

import { agentApi, type AgentTask } from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { formatDateTime } from "../lib/format";
import { t } from "../lib/i18n";
import { Badge, Button } from "./ui";

/** Manual merge steps returned by `mergeStart` when the agent cannot merge. */
export type ManualMerge = { taskId: string; instructions: string };

type Props = {
  tasks: AgentTask[];
  busy: string | null;
  queuePaused: boolean;
  /** Steps returned by 用原 Agent 合并 when it fell back to manual. */
  manualMerge?: ManualMerge | null;
  onApprove: (task: AgentTask) => void;
  onStop: (task: AgentTask) => void;
  onMergeStart: (task: AgentTask) => void;
  onMergeVerify: (task: AgentTask) => void;
  onCancelMerge: (task: AgentTask) => void;
  onResumeQueue: () => void;
  onOpenBug: (workspaceId: string, bugId: string) => void;
  onOpenExportDir: (task: AgentTask) => void;
  /** One-shot task selection, e.g. a task that just entered AwaitingMerge. */
  focusTaskId?: string | null;
  onFocusConsumed?: () => void;
  /** Split container, measured by the page to auto-collapse the list. */
  areaRef?: Ref<HTMLDivElement>;
  /** Leave the width to the review card. */
  listCollapsed?: boolean;
};

/**
 * 待处理：Agent 完成修改后暂停在这里，等待用户的下一步决定。
 *
 * - 待审核：改动还在工作区，通过后重新入队提交（Worktree 任务随后进入合并）。
 * - 待合并：Worktree 分支已提交，确认后用原 Agent 合并回主仓库，或按步骤手动合并。
 *
 * 左侧是待处理队列，右侧是选中任务的操作。
 */
export function AgentApproval(props: Props) {
  const { tasks, queuePaused } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Newest review first: it is the one most likely to still be on screen.
  const ordered = [...tasks].sort((a, b) => {
    const left = Date.parse(a.approval?.requestedAt ?? a.createdAt);
    const right = Date.parse(b.approval?.requestedAt ?? b.createdAt);
    return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left);
  });

  useEffect(() => {
    setSelectedId((current) =>
      current && ordered.some((task) => task.id === current)
        ? current
        : ordered[0]?.id ?? null,
    );
  }, [tasks]);

  useEffect(() => {
    if (!props.focusTaskId) return;
    if (!ordered.some((task) => task.id === props.focusTaskId)) return;
    setSelectedId(props.focusTaskId);
    props.onFocusConsumed?.();
  }, [props.focusTaskId, tasks, props.onFocusConsumed]);

  const selected = ordered.find((task) => task.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {tasks.length > 0 && !queuePaused ? (
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-slate-50 px-3 py-2 text-ui-sm text-slate-600">
          <ShieldAlert size={14} className="shrink-0 text-amber-500" />
          {t("agent.approval.banner")}
        </div>
      ) : null}
      {queuePaused ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-ui-sm text-amber-800">
          <ShieldAlert size={14} className="shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1">
            {t("agent.approval.pausedHint")}
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={props.busy === "queue:resume"}
            disabled={props.busy !== null && props.busy !== "queue:resume"}
            onClick={props.onResumeQueue}
          >
            {t("agent.queue.resume")}
          </Button>
        </div>
      ) : null}

      <div ref={props.areaRef} className="flex min-h-0 flex-1 gap-3">
        {props.listCollapsed ? null : (
          <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface ">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
              <ShieldAlert size={13} className="text-amber-500" />
              <span className="text-ui-sm font-normal text-slate-500">
                {t("agent.approval.title")}
              </span>
              <span className="ml-auto text-ui-xs tabular-nums text-slate-400">
                {t("agent.approval.count", { count: tasks.length })}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {ordered.length === 0 ? (
                <div className="px-3 py-8 text-center text-ui-caption leading-5 text-slate-400">
                  {t("agent.approval.empty")}
                </div>
              ) : (
                <div className="space-y-1">
                  {ordered.map((task) => {
                    const awaitingMerge = task.status === "awaiting_merge";
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => setSelectedId(task.id)}
                        className={clsx(
                          "w-full rounded-lg px-2.5 py-2 text-left transition",
                          task.id === selectedId
                            ? awaitingMerge
                              ? "bg-cyan-50 border border-cyan-200"
                              : "bg-amber-50 border border-amber-200"
                            : "hover:bg-slate-50",
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <Badge tone={awaitingMerge ? "cyan" : "amber"} dot>
                            {awaitingMerge
                              ? t("agent.status.awaitingMerge")
                              : t("agent.status.awaitingApproval")}
                          </Badge>
                          <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
                            {relativeTime(
                              task.approval?.requestedAt ?? task.createdAt,
                            )}
                          </span>
                        </div>
                        <div
                          className="mt-1 line-clamp-2 text-ui-caption font-normal leading-4 text-slate-700"
                          title={bugTitle(task.title)}
                        >
                          {bugTitle(task.title) || t("agent.untitled")}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-ui-xs text-slate-400">
                          <span className="min-w-0 truncate">
                            {task.workspaceName || task.workspaceId} · #
                            {task.bugId.slice(-7)}
                          </span>
                          {task.approval?.files?.length ? (
                            <span className="shrink-0">
                              {t("agent.approval.files", {
                                count: task.approval.files.length,
                              })}
                            </span>
                          ) : task.worktreeBranch ? (
                            <span className="min-w-0 truncate font-mono">
                              {task.worktreeBranch}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        )}
        <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface p-4 ">
          {selected ? (
            selected.status === "awaiting_merge" ? (
              <MergeCard key={selected.id} task={selected} {...props} />
            ) : (
              <ReviewCard key={selected.id} task={selected} {...props} />
            )
          ) : (
            <div className="grid h-full place-items-center px-6 py-10 text-center">
              <div className="max-w-md">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-500">
                  <ShieldAlert size={22} />
                </div>
                <h3
                  className="mt-3 text-ui-base text-slate-800"
                  title={t("agent.approval.emptyHint")}
                >
                  {t("agent.approval.empty")}
                </h3>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ReviewCard({
  task,
  busy,
  onApprove,
  onStop,
  onOpenBug,
  onOpenExportDir,
}: Props & { task: AgentTask }) {
  const approval = task.approval;
  const worktree = Boolean(task.worktreeBranch);
  const approveBusy = busy === `approve:${task.id}`;
  const stopBusy = busy === `stop:${task.id}`;
  const files = approval?.files ?? [];
  const [diff, setDiff] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const toggleDiff = async () => {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setDiffOpen(true);
    if (diff !== null || diffBusy) return;
    setDiffBusy(true);
    setDiffError(null);
    try {
      const result = await agentApi.reviewDiff(task.id);
      setDiff(result.diff);
    } catch (error) {
      setDiffError(String(error));
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600">
          <ShieldAlert size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3
              className="min-w-0 truncate text-ui-base font-normal text-slate-900"
              title={bugTitle(task.title)}
            >
              {bugTitle(task.title) || t("agent.untitled")}
            </h3>
            <Badge tone="amber">{t("agent.status.awaitingApproval")}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
            <span className="shrink-0">
              {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
            </span>
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
            {approval?.requestedAt ? (
              <span className="shrink-0">
                {formatDateTime(approval.requestedAt, {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon={<Eye size={11} />}
            disabled={busy !== null}
            onClick={() => void toggleDiff()}
          >
            {diffOpen ? t("agent.approval.hideDiff") : t("agent.approval.viewDiff")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Bug size={11} />}
            disabled={busy !== null}
            onClick={() => onOpenBug(task.workspaceId, task.bugId)}
          >
            {t("agent.openBug")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={11} />}
            disabled={busy !== null || !task.jsonPath}
            onClick={() => onOpenExportDir(task)}
          >
            {t("agent.approval.exportDir")}
          </Button>
        </div>
      </div>

      <div className="select-text mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2.5 text-ui-caption leading-5 text-slate-600">
        {approval?.summary ||
          (worktree
            ? t("agent.approval.reviewSummaryWorktree")
            : t("agent.approval.reviewSummary"))}
      </div>

      {files.length > 0 ? (
        <div className="mt-2">
          <div className="text-ui-xs font-normal text-slate-400">
            {t("agent.approval.filesChanged", { count: files.length })}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {files.slice(0, 12).map((file) => (
              <span
                key={file}
                title={file}
                className="max-w-[260px] truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-ui-xs text-slate-600"
              >
                {file}
              </span>
            ))}
            {files.length > 12 ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-ui-xs text-slate-500">
                +{files.length - 12}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {approval?.risk ? (
        <div className="select-text mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-1.5 text-ui-sm leading-5 text-amber-800">
          {t("agent.approval.risk", { risk: approval.risk })}
        </div>
      ) : null}

      {diffOpen ? (
        <div className="mt-2 rounded-lg bg-zinc-950 p-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-ui-xs text-zinc-400">
            <span className="font-mono">{t("agent.approval.diffTitle")}</span>
            <span className="ml-auto">
              {t("agent.approval.diffHint")}
            </span>
          </div>
          {diffBusy ? (
            <div className="flex items-center gap-1.5 py-3 text-ui-sm text-zinc-400">
              <Loader2 size={12} className="animate-spin" />
              {t("agent.approval.readingDiff")}
            </div>
          ) : diffError ? (
            <div className="select-text break-all py-2 text-ui-sm text-rose-300">{diffError}</div>
          ) : (
            <pre className="select-text max-h-72 overflow-auto whitespace-pre font-mono text-ui-xs leading-4 text-zinc-200">
              {diff ?? ""}
            </pre>
          )}
        </div>
      ) : null}

      <div
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
        title={
          worktree
            ? t("agent.approval.approveHintWorktree")
            : t("agent.approval.approveHint")
        }
      >
        <Button
          size="sm"
          variant="primary"
          loading={approveBusy}
          disabled={busy !== null && !approveBusy}
          icon={<Check size={12} />}
          onClick={() => onApprove(task)}
        >
          {worktree ? t("agent.approval.approveMerge") : t("agent.approval.approveCommit")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={stopBusy}
          disabled={busy !== null && !stopBusy}
          icon={<Archive size={12} />}
          onClick={() => onStop(task)}
        >
          {worktree ? t("agent.approval.stopTask") : t("agent.approval.stopStash")}
        </Button>
      </div>
    </article>
  );
}

/** 待合并：分支已提交，确认后用原 Agent 合并，或按步骤手动合并。 */
function MergeCard({
  task,
  busy,
  manualMerge,
  onMergeStart,
  onMergeVerify,
  onCancelMerge,
  onOpenBug,
  onOpenExportDir,
}: Props & { task: AgentTask }) {
  const merge = task.merge;
  const mergeBusy = busy === `merge:${task.id}`;
  const verifyBusy = busy === `verify:${task.id}`;
  const cancelBusy = busy === `merge-cancel:${task.id}`;
  // Steps returned by this exact click win over the persisted fallback.
  const instructions =
    manualMerge && manualMerge.taskId === task.id
      ? manualMerge.instructions
      : merge?.instructions;

  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-600">
          <GitMerge size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3
              className="min-w-0 truncate text-ui-base font-normal text-slate-900"
              title={bugTitle(task.title)}
            >
              {bugTitle(task.title) || t("agent.untitled")}
            </h3>
            <Badge tone="cyan">{t("agent.status.awaitingMerge")}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
            <span className="shrink-0">
              {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
            </span>
            {task.worktreeBranch ? (
              <span
                className="min-w-0 max-w-full truncate font-mono text-sky-700"
                title={task.worktreePath ?? task.worktreeBranch}
              >
                ⎇ {task.worktreeBranch}
              </span>
            ) : null}
            <span
              className="min-w-0 max-w-full truncate font-mono"
              title={task.repoPath}
            >
              {task.repoPath || t("agent.noRepo")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon={<Bug size={11} />}
            disabled={busy !== null}
            onClick={() => onOpenBug(task.workspaceId, task.bugId)}
          >
            {t("agent.openBug")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={11} />}
            disabled={busy !== null || !task.jsonPath}
            onClick={() => onOpenExportDir(task)}
          >
            {t("agent.approval.exportDir")}
          </Button>
        </div>
      </div>

      <p className="select-text mt-3 text-ui-caption leading-5 text-slate-600">
        {t("agent.approval.mergeSummary")}
      </p>

      {merge?.error ? (
        <div className="select-text mt-2 break-words rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-1.5 text-ui-sm leading-5 text-rose-700">
          {merge.error}
        </div>
      ) : null}

      {instructions ? (
        <div className="mt-2 max-w-2xl">
          <div className="text-ui-xs font-normal text-slate-400">
            {t("agent.approval.mergeSteps")}
          </div>
          <pre className="select-text mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2.5 font-mono text-ui-caption leading-5 text-slate-600">
            {instructions}
          </pre>
        </div>
      ) : null}

      <div
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
        title={t("agent.approval.mergeHint")}
      >
        <Button
          size="sm"
          variant="primary"
          loading={mergeBusy}
          disabled={busy !== null && !mergeBusy}
          icon={<GitMerge size={12} />}
          onClick={() => onMergeStart(task)}
        >
          {t("agent.approval.mergeWithAgent")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={verifyBusy}
          disabled={busy !== null && !verifyBusy}
          icon={<Check size={12} />}
          onClick={() => onMergeVerify(task)}
        >
          {t("agent.approval.mergedManually")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={cancelBusy}
          disabled={busy !== null && !cancelBusy}
          icon={<X size={12} />}
          onClick={() => onCancelMerge(task)}
        >
          {t("agent.approval.cancelTask")}
        </Button>
      </div>
    </article>
  );
}
