import type { DshGoal } from "../lib/dsh";
import { t, type MessageKey } from "../lib/i18n";

const PHASE_LABEL: Record<DshGoal["phase"], MessageKey> = {
  active: "agent.goal.active",
  paused: "agent.goal.paused",
  blocked: "agent.goal.blocked",
  complete: "agent.goal.complete",
};

const PHASE_DOT: Record<DshGoal["phase"], string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-400",
  blocked: "bg-rose-500",
  complete: "bg-slate-300",
};

/**
 * The session's long-running goal, next to the token figures. `/goal` sets a
 * target that survives turns, so the composer is where its state has to be
 * legible: the objective in the title, the phase in the text.
 */
export function GoalChip({ goal }: { goal?: DshGoal }) {
  if (!goal) return null;
  const phase = PHASE_LABEL[goal.phase];
  const rounds =
    goal.maxRounds > 0 ? ` · ${goal.roundsStarted}/${goal.maxRounds}` : "";
  return (
    <span
      data-component="GoalChip"
      data-phase={goal.phase}
      title={[
        goal.objective,
        t(phase) + rounds,
        goal.blockedReason ?? "",
      ]
        .filter(Boolean)
        .join("\n")}
      className="inline-flex min-w-0 max-w-[16rem] items-center gap-1 text-ui-xs text-slate-400"
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${PHASE_DOT[goal.phase]}`}
      />
      <span className="min-w-0 truncate">{goal.objective}</span>
      <span className="shrink-0 text-slate-300">·</span>
      <span className="shrink-0">{t(phase)}</span>
    </span>
  );
}
