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
          有待处理任务。Worktree 任务不会阻塞新任务；停止审核会储藏改动并暂停队列。
        </div>
      ) : null}
      {queuePaused ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-ui-sm text-amber-800">
          <ShieldAlert size={14} className="shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1">
            队列已暂停：审核任务不会自动继续。处理完后可手动恢复。
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={props.busy === "queue:resume"}
            disabled={props.busy !== null && props.busy !== "queue:resume"}
            onClick={props.onResumeQueue}
          >
            继续队列
          </Button>
        </div>
      ) : null}

      <div ref={props.areaRef} className="flex min-h-0 flex-1 gap-3">
        {props.listCollapsed ? null : (
          <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface ">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
              <ShieldAlert size={13} className="text-amber-500" />
              <span className="text-ui-sm font-normal text-slate-500">待处理任务</span>
              <span className="ml-auto text-ui-xs tabular-nums text-slate-400">
                {tasks.length} 个
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {ordered.length === 0 ? (
                <div className="px-3 py-8 text-center text-ui-caption leading-5 text-slate-400">
                  没有待处理的任务
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
                            {awaitingMerge ? "待合并" : "待审核"}
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
                          {bugTitle(task.title) || "（无标题）"}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-ui-xs text-slate-400">
                          <span className="min-w-0 truncate">
                            {task.workspaceName || task.workspaceId} · #
                            {task.bugId.slice(-7)}
                          </span>
                          {task.approval?.files?.length ? (
                            <span className="shrink-0">
                              {task.approval.files.length} 个文件
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
                  title="Worktree 任务的改动会在这里等待审核，通过后再确认合并；停止会把本次涉及的文件储藏到 git stash 并暂停队列，代码不会丢。"
                >
                  没有待处理的任务
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
              {bugTitle(task.title) || "（无标题）"}
            </h3>
            <Badge tone="amber">待审核</Badge>
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
                {task.repoPath || "未配置仓库"}
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
            {diffOpen ? "收起改动" : "查看改动"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Bug size={11} />}
            disabled={busy !== null}
            onClick={() => onOpenBug(task.workspaceId, task.bugId)}
          >
            打开缺陷
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={11} />}
            disabled={busy !== null || !task.jsonPath}
            onClick={() => onOpenExportDir(task)}
          >
            导出目录
          </Button>
        </div>
      </div>

      <div className="select-text mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2.5 text-ui-caption leading-5 text-slate-600">
        {approval?.summary ||
          (worktree
            ? "Agent 已完成修改，等待审核后合并。"
            : "Agent 已暂停，等待确认后提交。")}
      </div>

      {files.length > 0 ? (
        <div className="mt-2">
          <div className="text-ui-xs font-normal text-slate-400">
            涉及文件 {files.length} 个
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
          风险：{approval.risk}
        </div>
      ) : null}

      {diffOpen ? (
        <div className="mt-2 rounded-lg bg-zinc-950 p-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-ui-xs text-zinc-400">
            <span className="font-mono">相对任务起点的差异</span>
            <span className="ml-auto">只包含已跟踪文件；未跟踪文件见上方列表</span>
          </div>
          {diffBusy ? (
            <div className="flex items-center gap-1.5 py-3 text-ui-sm text-zinc-400">
              <Loader2 size={12} className="animate-spin" />
              正在读取差异…
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
            ? "通过后进入合并确认，再用原 Agent 合并回主仓库；停止会取消任务，未提交改动存入 git stash，已提交分支保留。"
            : "通过会重新入队，Agent 只做核对、提交与 TAPD 回写；停止会把本次涉及的文件储藏到 git stash 并暂停队列。"
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
          {worktree ? "通过并进入合并" : "通过并提交"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={stopBusy}
          disabled={busy !== null && !stopBusy}
          icon={<Archive size={12} />}
          onClick={() => onStop(task)}
        >
          {worktree ? "停止任务" : "停止并储藏"}
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
              {bugTitle(task.title) || "（无标题）"}
            </h3>
            <Badge tone="cyan">待合并</Badge>
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
              {task.repoPath || "未配置仓库"}
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
            打开缺陷
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={11} />}
            disabled={busy !== null || !task.jsonPath}
            onClick={() => onOpenExportDir(task)}
          >
            导出目录
          </Button>
        </div>
      </div>

      <p className="select-text mt-3 text-ui-caption leading-5 text-slate-600">
        审核已通过。确认后会使用原 Agent 把分支合并到主仓库；合并成功才算完成。
      </p>

      {merge?.error ? (
        <div className="select-text mt-2 break-words rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-1.5 text-ui-sm leading-5 text-rose-700">
          {merge.error}
        </div>
      ) : null}

      {instructions ? (
        <div className="mt-2 max-w-2xl">
          <div className="text-ui-xs font-normal text-slate-400">手动合并步骤</div>
          <pre className="select-text mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2.5 font-mono text-ui-caption leading-5 text-slate-600">
            {instructions}
          </pre>
        </div>
      ) : null}

      <div
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
        title="合并由原 Agent 在主仓库执行；分支尚未合并时可用「我已手动合并」校验。"
      >
        <Button
          size="sm"
          variant="primary"
          loading={mergeBusy}
          disabled={busy !== null && !mergeBusy}
          icon={<GitMerge size={12} />}
          onClick={() => onMergeStart(task)}
        >
          用原 Agent 合并
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={verifyBusy}
          disabled={busy !== null && !verifyBusy}
          icon={<Check size={12} />}
          onClick={() => onMergeVerify(task)}
        >
          我已手动合并
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={cancelBusy}
          disabled={busy !== null && !cancelBusy}
          icon={<X size={12} />}
          onClick={() => onCancelMerge(task)}
        >
          取消任务
        </Button>
      </div>
    </article>
  );
}
