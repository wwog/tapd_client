import { useState } from "react";
import {
  Archive,
  Check,
  Eye,
  GitMerge,
  LoaderCircle,
  CircleExclamationPoint,
} from "lucide-react";

import { api, type AgentTask } from "../lib/api";
import { bugTitle } from "../lib/format";
import { Badge } from "./Badge";

/** Task title with the tester punctuation normalized; empty-safe. */
const titleOf = (task: AgentTask): string => bugTitle(task.title) || "（无标题）";

/** Small push-page affordance in a card footer. */
function DetailLink(props: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="shrink-0 rounded-md px-2 py-1.5 text-ui-sm text-slate-400 transition active:bg-overlay-soft"
    >
      详情
    </button>
  );
}

/**
 * 待审核卡：Agent 完成修改后暂停在这里。通过后重新入队提交；搁置会把改动
 * 储藏到 git stash 并取消任务、暂停队列（恢复在桌面端进行）。
 * Shared by the Agent page and the task detail page.
 */
export function ReviewCard(props: {
  task: AgentTask;
  /** The page owns one busy key at a time; blocks this card's actions. */
  busy: boolean;
  onApprove: (task: AgentTask) => void;
  onStop: (task: AgentTask) => void;
  /** Opens #/agent/task/:id; omitted on the detail page itself. */
  onOpen?: () => void;
}) {
  const { task, busy } = props;
  const approval = task.approval;
  const files = approval?.files ?? [];
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
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
      setDiff(await api.agentDiff(task.id));
    } catch (err) {
      setDiffError(String(err));
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <article className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600">
          <CircleExclamationPoint size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 text-ui-caption leading-5 text-slate-900" title={titleOf(task)}>
            {titleOf(task)}
          </h3>
          <p className="mt-0.5 text-ui-xs text-slate-400">
            {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
          </p>
        </div>
        <Badge tone="amber">待审核</Badge>
      </div>

      <p
        className="mt-3 select-text break-words rounded-lg bg-overlay-soft px-3 py-2 text-ui-sm leading-5 text-slate-600"
        title={approval?.summary}
      >
        {approval?.summary || "Agent 已完成修改，等待审核。"}
      </p>

      {files.length > 0 ? (
        <div className="mt-2">
          <div className="text-ui-xs text-slate-400">涉及文件 {files.length} 个</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {files.slice(0, 12).map((file) => (
              <span
                key={file}
                title={file}
                className="max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-ui-2xs text-slate-600"
              >
                {file}
              </span>
            ))}
            {files.length > 12 ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-ui-2xs text-slate-500">
                +{files.length - 12}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {approval?.risk ? (
        <p
          className="select-text mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-ui-sm leading-5 text-amber-800"
          title={approval.risk}
        >
          风险：{approval.risk}
        </p>
      ) : null}

      {diffOpen ? (
        <div className="mt-2 rounded-lg bg-zinc-950 p-2.5">
          <div className="mb-1.5 text-ui-2xs text-zinc-400">
            <span className="font-mono">相对任务起点的差异（只读）</span>
          </div>
          {diffBusy ? (
            <div className="flex items-center gap-1.5 py-3 text-ui-sm text-zinc-400">
              <LoaderCircle size={12} className="animate-spin" />
              正在读取差异…
            </div>
          ) : diffError ? (
            <div className="select-text break-all py-2 text-ui-sm text-rose-300">{diffError}</div>
          ) : (
            <pre className="select-text max-h-72 overflow-auto whitespace-pre font-mono text-ui-2xs leading-4 text-zinc-200">
              {diff ?? ""}
            </pre>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={busy}
          title="通过后 Agent 继续核对、提交并回写 TAPD。"
          onClick={() => props.onApprove(task)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />}
          通过
        </button>
        <button
          type="button"
          disabled={busy}
          title="搁置：本次改动存入 git stash，任务取消，队列暂停（在桌面端恢复）。代码不会丢。"
          onClick={() => props.onStop(task)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <Archive size={12} />
          搁置
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggleDiff()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-sm text-slate-500 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <Eye size={12} />
          {diffOpen ? "收起改动" : "查看改动"}
        </button>
        {props.onOpen ? <DetailLink onOpen={props.onOpen} /> : null}
      </div>
    </article>
  );
}

/**
 * 待合并卡：审核通过、worktree 分支已提交。用原 Agent 合并回主仓库；
 * Agent 不能合并时返回手动步骤。
 */
export function MergeCard(props: {
  task: AgentTask;
  busy: boolean;
  /** Steps returned by the latest merge_start; wins over persisted ones. */
  instructions?: string | null;
  onMergeStart: (task: AgentTask) => void;
  /** Opens #/agent/task/:id; omitted on the detail page itself. */
  onOpen?: () => void;
}) {
  const { task, busy } = props;
  const instructions = props.instructions ?? task.merge?.instructions ?? null;

  return (
    <article className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-600">
          <GitMerge size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 text-ui-caption leading-5 text-slate-900" title={titleOf(task)}>
            {titleOf(task)}
          </h3>
          <p className="mt-0.5 text-ui-xs text-slate-400">
            {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
          </p>
        </div>
        <Badge tone="cyan">待合并</Badge>
      </div>

      <p
        className="mt-3 text-ui-sm leading-5 text-slate-600"
        title="合并由原 Agent 在主仓库执行，合并成功才算完成。"
      >
        审核已通过。确认后使用原 Agent 把分支合并到主仓库。
      </p>

      {task.worktreeBranch ? (
        <p
          className="mt-1 truncate font-mono text-ui-xs text-sky-700"
          title={task.worktreePath ?? task.worktreeBranch}
        >
          ⎇ {task.worktreeBranch}
        </p>
      ) : null}

      {task.merge?.error ? (
        <p className="select-text mt-2 break-words rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-1.5 text-ui-sm leading-5 text-rose-700">
          {task.merge.error}
        </p>
      ) : null}

      {instructions ? (
        <div className="mt-2">
          <div className="text-ui-xs text-slate-400">手动合并步骤</div>
          <pre className="select-text mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-overlay-soft px-3 py-2 font-mono text-ui-xs leading-5 text-slate-600">
            {instructions}
          </pre>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => props.onMergeStart(task)}
          className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <GitMerge size={12} />}
          用原 Agent 合并
        </button>
        {props.onOpen ? <DetailLink onOpen={props.onOpen} /> : null}
      </div>
    </article>
  );
}
