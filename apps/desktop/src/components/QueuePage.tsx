import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  ArrowUpRight,
  CheckCircle2,
  ListTodo,
  PauseCircle,
  Play,
  X,
  XCircle,
} from "lucide-react";

import { ActivityGlyph } from "./ActivityGlyph";
import { ScrollingName } from "./ScrollingName";
import { SkeletonRows } from "./Skeleton";
import { Badge, Button, EmptyState } from "./ui";
import {
  markQueueReportSeen,
  useQueueBatch,
  type QueueReportRow,
} from "../agent/queueBatch";
import { agentActions } from "../agent/store";
import {
  queueOrder,
  useTaskFeed,
  type TaskFeedEntry,
} from "../agent/taskFeed";
import { WORKFLOW, taskWorkflowView } from "../agent/workflow";
import { formatDateTime } from "../lib/format";
import { relativeTime } from "../lib/api";
import { t } from "../lib/i18n";
import { plainTitle } from "../lib/title";
import { showToast } from "../lib/toast";

type Props = {
  /** The queue page is what the user is looking at; retires the green badge. */
  active: boolean;
  /** Selects the task and opens the Agent page on it. */
  onOpenTask: (sessionId: string) => void;
  /** Opens the source bug in the secondary detail panel. */
  onOpenBug: (workspaceId: string, bugId: string) => void;
  /** Opens the source work item in the secondary detail panel. */
  onOpenLocalItem: (projectId: string, itemId: string, label?: string) => void;
};

/** Data a queue/report row needs to jump back to its source record. */
type SourceLink = {
  id: string;
  kind: string;
  title: string;
  workflow?: string;
  project: { id: string; name: string; kind: string } | null;
  bugId?: string;
  localItemId?: string;
};

const shortDate = (value: string) =>
  formatDateTime(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * Global workflow queue: every project's running and waiting tasks plus the
 * report of the last completed batch. The bug list and local item list no
 * longer carry queue tabs; this is the single queue surface.
 */
export function QueuePage({
  active,
  onOpenTask,
  onOpenBug,
  onOpenLocalItem,
}: Props) {
  const feed = useTaskFeed();
  const batch = useQueueBatch();
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const running = feed.entries
    .filter((entry) => entry.task.workflow === "running" && !entry.interrupted)
    .sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt));
  const interrupted = feed.entries.filter((entry) => entry.interrupted);
  const queued = feed.entries
    .filter((entry) => entry.task.workflow === "queued")
    .sort((left, right) => queueOrder(left.task, right.task));
  // The batch stays open through review and finishing; showing those rows
  // keeps the yellow badge and the page's contents consistent.
  const review = feed.entries
    .filter((entry) => entry.task.workflow === "awaiting_review")
    .sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt));
  const finalizing = feed.entries
    .filter((entry) => entry.task.workflow === "finalizing")
    .sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt));

  const total =
    running.length +
    interrupted.length +
    queued.length +
    review.length +
    finalizing.length;
  const report = batch.report;

  // Being seen reads the report; the green badge retires here. `active` is
  // the panel host's `visible` (tab active, group focused, not maximized
  // away) — a stacked or hidden tab must not swallow the badge. Only retire
  // it once the task feed actually rendered the report (a skeleton or a
  // failed task read must not swallow the badge either).
  useEffect(() => {
    if (active && report && feed.loaded) markQueueReportSeen();
  }, [active, report, feed.loaded]);

  /**
   * Open the record a row came from. A queued task has no dsh session, and a
   * report row's task may have been deleted, so the Agent fallback is only for
   * live tasks with a session.
   */
  const openSource = (row: SourceLink, allowSessionFallback: boolean) => {
    if (row.kind === "bug" && row.bugId && row.project?.kind === "tapd") {
      onOpenBug(row.project.id, row.bugId);
      return;
    }
    if (
      row.kind === "local_item" &&
      row.localItemId &&
      row.project?.kind === "local"
    ) {
      onOpenLocalItem(row.project.id, row.localItemId, row.title);
      return;
    }
    if (allowSessionFallback && row.workflow !== "queued") {
      onOpenTask(row.id);
    }
  };

  const runRow = async (id: string, action: () => Promise<unknown>) => {
    if (busyIds.has(id)) return;
    setBusyIds((current) => new Set(current).add(id));
    try {
      await action();
    } catch (error) {
      showToast("error", String(error));
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const continueTask = (entry: TaskFeedEntry) =>
    runRow(entry.task.id, () =>
      agentActions.continueTask(entry.task.id, t("agent.task.continuePrompt")),
    );

  const cancelTask = (entry: TaskFeedEntry) =>
    runRow(entry.task.id, () => agentActions.cancelTask(entry.task.id));

  const renderEntry = (entry: TaskFeedEntry) => {
    const { task } = entry;
    const workflow = taskWorkflowView(task, entry.interrupted);
    const busy = busyIds.has(task.id);
    return (
      <li
        key={task.id}
        data-component="QueueRow"
        className="group flex items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 transition hover:border-slate-300"
      >
        <span className="mt-0.5 grid h-6 w-8 shrink-0 place-items-center">
          {entry.position ? (
            <span className="font-mono text-ui-xs text-slate-400">
              #{entry.position}
            </span>
          ) : entry.interrupted ? (
            <PauseCircle size={14} className="text-amber-600" />
          ) : (
            <ActivityGlyph seed={task.id} />
          )}
        </span>

        <button
          type="button"
          onClick={() => openSource(task, true)}
          className="min-w-0 flex-1 rounded text-left"
          title={t("agent.queue.openSource")}
        >
          <div className="flex min-w-0 items-center gap-2">
            <ScrollingName
              text={plainTitle(task.title) || t("agent.task.untitled")}
              className="min-w-0 flex-1 text-ui-caption text-slate-800"
            />
            <Badge tone={workflow.tone}>{t(workflow.label)}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-slate-400">
            <span className="truncate">
              {task.project?.name ?? t("agent.task.noProject")}
            </span>
            <span className="shrink-0">
              {t("agent.queue.created", { time: shortDate(task.createdAt) })}
            </span>
            {entry.model ? (
              <span className="min-w-0 truncate text-sky-700">{entry.model}</span>
            ) : null}
            {task.branch ? (
              <span
                className="max-w-[16rem] truncate font-mono"
                title={task.branch}
              >
                {task.branch}
              </span>
            ) : null}
            {task.changes ? (
              <span className="shrink-0" title={t("agent.task.changesHint")}>
                {t("agent.task.changes", { files: task.changes.files })}
                <span className="ml-1 text-emerald-700">
                  +{task.changes.additions}
                </span>
                <span className="ml-1 text-rose-600">
                  −{task.changes.deletions}
                </span>
              </span>
            ) : null}
            <span className="ml-auto shrink-0">
              {relativeTime(task.updatedAt)}
            </span>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {entry.interrupted ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Play size={12} />}
              loading={busy}
              title={t("agent.task.continueHint")}
              onClick={() => void continueTask(entry)}
            >
              {t("agent.task.continue")}
            </Button>
          ) : task.workflow === "queued" || task.workflow === "running" ? (
            <button
              type="button"
              disabled={busy}
              aria-label={t("agent.queue.cancel")}
              title={t("agent.queue.cancel")}
              onClick={() => void cancelTask(entry)}
              className={clsx(
                "grid h-7 w-7 place-items-center rounded-lg border border-border bg-surface transition",
                busy
                  ? "cursor-not-allowed opacity-60"
                  : "text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700",
              )}
            >
              <X size={13} />
            </button>
          ) : null}
          {/* A queued task has no dsh session yet: only the source record and
              the cancel action apply until the scheduler starts it. */}
          {task.workflow !== "queued" ? (
            <button
              type="button"
              aria-label={t("agent.queue.open")}
              title={t("agent.queue.open")}
              onClick={() => onOpenTask(task.id)}
              className="grid h-7 w-7 place-items-center rounded-lg border border-border bg-surface text-slate-500 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
            >
              <ArrowUpRight size={13} />
            </button>
          ) : null}
        </div>
      </li>
    );
  };

  const renderReportRow = (row: QueueReportRow) => {
    const workflow = WORKFLOW[row.workflow];
    return (
      <li
        key={row.id}
        data-component="QueueReportRow"
        className="flex items-start gap-2 px-1 py-2"
      >
        {row.workflow === "done" ? (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" />
        ) : (
          <XCircle
            size={13}
            className={clsx(
              "mt-0.5 shrink-0",
              row.workflow === "failed" ? "text-rose-600" : "text-slate-400",
            )}
          />
        )}
        <button
          type="button"
          onClick={() => openSource(row, false)}
          className="min-w-0 flex-1 rounded text-left"
          title={t("agent.queue.openSource")}
        >
          <div className="flex min-w-0 items-center gap-2">
            <ScrollingName
              text={plainTitle(row.title) || t("agent.task.untitled")}
              className="min-w-0 flex-1 text-ui-caption text-slate-700"
            />
            <Badge tone={workflow.tone}>{t(workflow.label)}</Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-ui-xs text-slate-400">
            <span className="truncate">
              {row.project?.name ?? t("agent.task.noProject")}
            </span>
            <span>{shortDate(row.finishedAt)}</span>
            {row.changes ? (
              <span>
                {t("agent.task.changes", { files: row.changes.files })}
                <span className="ml-1 text-emerald-700">
                  +{row.changes.additions}
                </span>
                <span className="ml-1 text-rose-600">
                  −{row.changes.deletions}
                </span>
              </span>
            ) : null}
          </div>
        </button>
      </li>
    );
  };

  const reportCounts = report
    ? report.rows.reduce(
        (counts, row) => {
          counts[row.workflow] += 1;
          return counts;
        },
        { done: 0, canceled: 0, failed: 0 },
      )
    : null;

  return (
    <div data-component="QueuePage" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-6 py-3">
        <h1 className="text-ui-caption text-slate-800">{t("app.nav.queue")}</h1>
        {feed.loaded ? (
          <span className="text-ui-xs text-slate-400">
            {t("agent.queue.execution", {
              running: running.length,
              total: feed.executionUnits,
            })}
            <span className="mx-1.5 text-slate-300">·</span>
            {t("agent.queue.waiting", { count: queued.length })}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!feed.loaded ? (
          <SkeletonRows
            className="pt-2"
            rows={6}
            columns={["w-2/5", "w-16", "w-20"]}
            label={t("agent.queue.loading")}
          />
        ) : total === 0 && !report ? (
          <EmptyState
            icon={<ListTodo size={22} />}
            title={t("agent.queue.empty")}
            description={t("agent.queue.emptyHint")}
          />
        ) : (
          <div className="mx-auto w-full max-w-4xl space-y-5 px-6 py-4">
            {report && report.rows.length > 0 && reportCounts ? (
              <section data-component="QueueReport">
                <div className="mb-1.5 flex items-center gap-2 px-1">
                  <span className="text-ui-xs text-emerald-700">
                    {t("agent.queue.report")}
                  </span>
                  <span className="text-ui-xs text-slate-400">
                    {shortDate(report.startedAt)} – {shortDate(report.finishedAt)}
                  </span>
                  <span className="text-ui-xs text-slate-400">
                    {t("agent.queue.reportSummary", {
                      done: reportCounts.done,
                      canceled: reportCounts.canceled,
                      failed: reportCounts.failed,
                    })}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <ul className="divide-y divide-slate-100 rounded-xl border border-border bg-surface px-2">
                  {report.rows.map(renderReportRow)}
                </ul>
              </section>
            ) : null}

            {running.length > 0 ? (
              <section>
                <QueueHeading label={t("agent.queue.running")} count={running.length} />
                <ul className="space-y-1.5">{running.map(renderEntry)}</ul>
              </section>
            ) : null}
            {interrupted.length > 0 ? (
              <section>
                <QueueHeading
                  label={t("agent.queue.interrupted")}
                  count={interrupted.length}
                  tone="text-amber-600"
                />
                <ul className="space-y-1.5">{interrupted.map(renderEntry)}</ul>
              </section>
            ) : null}
            {queued.length > 0 ? (
              <section>
                <QueueHeading label={t("agent.queue.queued")} count={queued.length} />
                <ul className="space-y-1.5">{queued.map(renderEntry)}</ul>
              </section>
            ) : null}
            {review.length > 0 ? (
              <section>
                <QueueHeading
                  label={t("agent.task.workflowAwaitingReview")}
                  count={review.length}
                  tone="text-amber-600"
                />
                <ul className="space-y-1.5">{review.map(renderEntry)}</ul>
              </section>
            ) : null}
            {finalizing.length > 0 ? (
              <section>
                <QueueHeading
                  label={t("agent.task.workflowFinalizing")}
                  count={finalizing.length}
                  tone="text-cyan-600"
                />
                <ul className="space-y-1.5">{finalizing.map(renderEntry)}</ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function QueueHeading({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-1">
      <span className={clsx("text-ui-xs", tone ?? "text-slate-500")}>
        {label}
      </span>
      <span className="font-mono text-ui-2xs text-slate-400">{count}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
