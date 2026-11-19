import { useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, ListTodo, PauseCircle, Play, X } from "lucide-react";

import { ActivityGlyph } from "./ActivityGlyph";
import { ScrollingName } from "./ScrollingName";
import { SkeletonRows } from "./Skeleton";
import { Badge, Button, EmptyState } from "./ui";
import { agentActions } from "../agent/store";
import {
  queueOrder,
  useTaskFeed,
  type TaskFeedEntry,
} from "../agent/taskFeed";
import { taskWorkflowView } from "../agent/workflow";
import { relativeTime } from "../lib/api";
import { t } from "../lib/i18n";
import { plainTitle } from "../lib/title";
import { showToast } from "../lib/toast";

type Props = {
  /** Selects the task and opens the Agent page on it. */
  onOpenTask: (sessionId: string) => void;
};

/**
 * Global workflow queue: every project's running and waiting tasks in one
 * place. The bug list's 队列中 tab is the per-project view of the same facts;
 * this page is where an unexpectedly interrupted task is continued.
 */
export function QueuePage({ onOpenTask }: Props) {
  const feed = useTaskFeed();
  const [busyId, setBusyId] = useState<string | null>(null);

  const running = feed.entries
    .filter((entry) => entry.task.workflow === "running" && !entry.interrupted)
    .sort((left, right) => left.task.createdAt.localeCompare(right.task.createdAt));
  const interrupted = feed.entries.filter((entry) => entry.interrupted);
  const queued = feed.entries
    .filter((entry) => entry.task.workflow === "queued")
    .sort((left, right) => queueOrder(left.task, right.task));

  const total = running.length + interrupted.length + queued.length;

  const continueTask = async (entry: TaskFeedEntry) => {
    if (busyId) return;
    setBusyId(entry.task.id);
    try {
      await agentActions.continueTask(
        entry.task.id,
        t("agent.task.continuePrompt"),
      );
    } catch (error) {
      showToast("error", String(error));
    } finally {
      setBusyId(null);
    }
  };

  const cancelTask = async (entry: TaskFeedEntry) => {
    if (busyId) return;
    setBusyId(entry.task.id);
    try {
      await agentActions.cancelTask(entry.task.id);
    } catch (error) {
      showToast("error", String(error));
    } finally {
      setBusyId(null);
    }
  };

  const renderEntry = (entry: TaskFeedEntry) => {
    const { task } = entry;
    const workflow = taskWorkflowView(task, entry.interrupted);
    const busy = busyId === task.id;
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
          onClick={() => onOpenTask(task.id)}
          className="min-w-0 flex-1 rounded text-left"
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
            {entry.model ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-sky-700">
                <span className="truncate">{entry.model}</span>
              </span>
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
              <span title={t("agent.task.changesHint")}>
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
          ) : (
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
          )}
          <button
            type="button"
            aria-label={t("agent.queue.open")}
            title={t("agent.queue.open")}
            onClick={() => onOpenTask(task.id)}
            className="grid h-7 w-7 place-items-center rounded-lg border border-border bg-surface text-slate-500 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
          >
            <ArrowUpRight size={13} />
          </button>
        </div>
      </li>
    );
  };

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
        ) : total === 0 ? (
          <EmptyState
            icon={<ListTodo size={22} />}
            title={t("agent.queue.empty")}
            description={t("agent.queue.emptyHint")}
          />
        ) : (
          <div className="mx-auto w-full max-w-4xl space-y-5 px-6 py-4">
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
