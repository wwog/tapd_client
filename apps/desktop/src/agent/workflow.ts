import type { BadgeTone } from "../components/ui";
import type { DshTask, DshTaskWorkflow } from "../lib/dsh";
import { t, type MessageKey } from "../lib/i18n";

/** The chip every task surface paints for a workflow value (list, task pane). */
export const WORKFLOW: Record<
  DshTaskWorkflow,
  { label: MessageKey; tone: BadgeTone }
> = {
  queued: { label: "agent.task.workflowQueued", tone: "neutral" },
  running: { label: "agent.task.workflowRunning", tone: "blue" },
  awaiting_review: { label: "agent.task.workflowAwaitingReview", tone: "amber" },
  finalizing: { label: "agent.task.workflowFinalizing", tone: "cyan" },
  done: { label: "agent.task.workflowDone", tone: "green" },
  failed: { label: "agent.task.workflowFailed", tone: "red" },
  canceled: { label: "agent.task.workflowCanceled", tone: "neutral" },
};

/**
 * Icon tint for the single-line list mark; the hue of each tone mirrors
 * `BADGE_TONES` (`components/ui.tsx`) minus its background.
 */
export const WORKFLOW_MARK: Record<DshTaskWorkflow, string> = {
  queued: "text-slate-300",
  running: "text-sky-600",
  awaiting_review: "text-amber-600",
  finalizing: "text-cyan-600",
  done: "text-emerald-600",
  failed: "text-rose-600",
  canceled: "text-slate-300",
};

/** A workflow task (bug or local item) rather than a free chat. */
export const isWorkflowTask = (task?: { kind: string } | null): boolean =>
  !!task && task.kind !== "chat";

/** Start/commit/merge revisions, for the task pane and the done receipt. */
export const taskHashes = (task: DshTask): { label: string; value: string }[] =>
  [
    { label: t("agent.task.gitStart"), value: task.git.start },
    { label: t("agent.task.gitCommit"), value: task.git.commit },
    { label: t("agent.task.gitMerge"), value: task.git.merge },
  ].filter(
    (row): row is { label: string; value: string } => Boolean(row.value),
  );
