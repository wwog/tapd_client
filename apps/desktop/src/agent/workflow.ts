import type { BadgeTone } from "../components/ui";
import type { DshTaskWorkflow } from "../lib/dsh";
import type { MessageKey } from "../lib/i18n";

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
