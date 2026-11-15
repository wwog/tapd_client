import { useState } from "react";
import {
  Archive,
  Check,
  Eye,
  GitMerge,
  LoaderCircle,
  CircleExclamationPoint,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  api,
  asApiError,
  isTapdTask,
  type AgentDiffView,
  type AgentTask,
} from "../lib/api";
import { bugTitle } from "../lib/format";
import { t } from "../lib/i18n";
import { Badge } from "./Badge";
import {
  CHANGE_LETTERS,
  CHANGE_TONES,
  CommitHash,
  useAgentChangeSummary,
} from "./AgentChanges";

/** `+A −D`, optionally preceded by the file count; a zero side is omitted. */
function ChangeTotals(props: { additions: number; deletions: number; fileCount?: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-ui-xs">
      {props.fileCount === undefined ? null : (
        <span className="shrink-0 text-slate-400">
          {t("magent.changes.files", { count: props.fileCount })}
        </span>
      )}
      {props.additions > 0 ? (
        <span className="shrink-0 tabular-nums text-emerald-700">+{props.additions}</span>
      ) : null}
      {props.deletions > 0 ? (
        <span className="shrink-0 tabular-nums text-rose-700">−{props.deletions}</span>
      ) : null}
    </span>
  );
}

/** Task title with the tester punctuation normalized; empty-safe. */
const titleOf = (task: AgentTask): string => bugTitle(task.title) || t("magent.untitled");

/**
 * Card subtitle: the project, plus the bug ref only for TAPD-sourced tasks —
 * a task raised from a local work item has no bug id to show.
 */
const originOf = (task: AgentTask): string => {
  const project = task.workspaceName || task.workspaceId;
  return isTapdTask(task) ? `${project} · #${task.bugId.slice(-7)}` : project;
};

/** Small push-page affordance in a card footer. */
function DetailLink(props: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="shrink-0 rounded-md px-2 py-1.5 text-ui-sm text-slate-400 transition active:bg-overlay-soft"
    >
      {t("common.details")}
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
  const changes = task.changes ?? null;
  // Per-file stats come from the change command; the approval only lists paths.
  const summary = useAgentChangeSummary(task.id);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<AgentDiffView | null>(null);
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
      setDiff(await api.agentTaskDiff(task.id));
    } catch (err) {
      setDiffError(asApiError(err).message);
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
            {originOf(task)}
          </p>
        </div>
        <Badge tone="amber">{t(AGENT_STATUS_LABELS.awaiting_approval)}</Badge>
      </div>

      <p
        className="mt-3 select-text break-words rounded-lg bg-overlay-soft px-3 py-2 text-ui-sm leading-5 text-slate-600"
        title={approval?.summary}
      >
        {approval?.summary || t("magent.awaitingReviewHint")}
      </p>

      {summary ? (
        <div className="mt-2">
          <ChangeTotals
            fileCount={summary.fileCount}
            additions={summary.additions}
            deletions={summary.deletions}
          />
          {summary.files.length > 0 ? (
            <div className="mt-1 border-t border-border">
              {summary.files.slice(0, 12).map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-2 border-b border-border py-1 last:border-b-0"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-ui-2xs text-slate-600"
                    title={file.path}
                  >
                    {file.path}
                  </span>
                  <Badge tone={CHANGE_TONES[file.status]}>{CHANGE_LETTERS[file.status]}</Badge>
                  {file.binary ? (
                    <span className="shrink-0 text-ui-2xs text-slate-400">
                      {t("magent.changes.binary")}
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 tabular-nums text-ui-2xs">
                      {file.additions > 0 ? (
                        <span className="text-emerald-700">+{file.additions}</span>
                      ) : null}
                      {file.deletions > 0 ? (
                        <span className="text-rose-700">−{file.deletions}</span>
                      ) : null}
                    </span>
                  )}
                </div>
              ))}
              {summary.files.length > 12 ? (
                <div className="py-1 text-ui-2xs text-slate-500">
                  +{summary.files.length - 12}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : files.length > 0 ? (
        <div className="mt-2">
          {changes ? (
            <ChangeTotals additions={changes.additions} deletions={changes.deletions} />
          ) : null}
          <div className={`text-ui-xs text-slate-400${changes ? " mt-1" : ""}`}>
            {t("magent.files.count", { n: files.length })}
          </div>
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
      ) : changes ? (
        <div className="mt-2">
          <ChangeTotals
            fileCount={changes.files.length}
            additions={changes.additions}
            deletions={changes.deletions}
          />
        </div>
      ) : null}

      {approval?.risk ? (
        <p
          className="select-text mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-ui-sm leading-5 text-amber-800"
          title={approval.risk}
        >
          {t("magent.risk", { risk: approval.risk })}
        </p>
      ) : null}

      {diffOpen ? (
        <div className="mt-2 rounded-lg bg-zinc-950 p-2.5">
          <div className="mb-1.5 text-ui-2xs text-zinc-400">
            <span className="font-mono">{t("magent.diffTitle")}</span>
          </div>
          {diffBusy ? (
            <div className="flex items-center gap-1.5 py-3 text-ui-sm text-zinc-400">
              <LoaderCircle size={12} className="animate-spin" />
              {t("magent.diffLoading")}
            </div>
          ) : diffError ? (
            <div className="select-text break-all py-2 text-ui-sm text-rose-300">{diffError}</div>
          ) : diff?.empty ? (
            <div className="py-2 text-ui-sm text-zinc-400">{t("magent.changes.noDiff")}</div>
          ) : (
            <>
              <pre className="select-text max-h-72 overflow-auto whitespace-pre font-mono text-ui-2xs leading-4 text-zinc-200">
                {diff?.text ?? ""}
              </pre>
              {diff?.truncated ? (
                <div className="mt-1 text-ui-2xs text-zinc-500">
                  {t("magent.changes.diffTruncated")}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={busy}
          title={t("magent.approveHint")}
          onClick={() => props.onApprove(task)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />}
          {t("magent.approve")}
        </button>
        <button
          type="button"
          disabled={busy}
          title={t("magent.shelveHint")}
          onClick={() => props.onStop(task)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <Archive size={12} />
          {t("magent.shelve")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggleDiff()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-sm text-slate-500 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <Eye size={12} />
          {diffOpen ? t("magent.hideDiff") : t("magent.viewDiff")}
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
            {originOf(task)}
          </p>
        </div>
        <Badge tone="cyan">{t(AGENT_STATUS_LABELS.awaiting_merge)}</Badge>
      </div>

      <p
        className="mt-3 text-ui-sm leading-5 text-slate-600"
        title={t("magent.mergeHint")}
      >
        {t("magent.mergeReady")}
      </p>

      {task.worktreeBranch ? (
        <p
          className="mt-1 truncate font-mono text-ui-xs text-sky-700"
          title={task.worktreePath ?? task.worktreeBranch}
        >
          ⎇ {task.worktreeBranch}
        </p>
      ) : null}

      {task.changes ? (
        <div className="mt-1">
          <ChangeTotals
            fileCount={task.changes.files.length}
            additions={task.changes.additions}
            deletions={task.changes.deletions}
          />
        </div>
      ) : null}

      {task.merge?.commit ? (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="shrink-0 text-ui-xs text-slate-400">
            {t("magent.changes.mergedCommit")}
          </span>
          <CommitHash hash={task.merge.commit} />
        </div>
      ) : null}

      {task.merge?.error ? (
        <p className="select-text mt-2 break-words rounded-lg border border-rose-100 bg-rose-50 px-2.5 py-1.5 text-ui-sm leading-5 text-rose-700">
          {task.merge.error}
        </p>
      ) : null}

      {instructions ? (
        <div className="mt-2">
          <div className="text-ui-xs text-slate-400">{t("magent.manualMergeSteps")}</div>
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
          {t("magent.mergeStart")}
        </button>
        {props.onOpen ? <DetailLink onOpen={props.onOpen} /> : null}
      </div>
    </article>
  );
}
