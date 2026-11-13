import { useEffect, useState } from "react";

import { agentInFlightLabel, type AgentInFlight } from "../lib/agent";
import { elapsedSince, formatElapsed, formatStartedAt } from "../lib/activity";
import { t } from "../lib/i18n";
import { ActivityGlyph } from "./ActivityGlyph";

type Props = {
  task: AgentInFlight;
};

/**
 * Two compact lines under the bug title. Never overlays the title: line one is
 * who is working on it, line two is the created time plus the rolling elapsed
 * time (at most two units) with a 16px activity glyph in front.
 *
 * Purely informational: the row click always opens the bug detail, so this
 * block must not swallow clicks or jump to the Agent view. The action column
 * carries that jump instead.
 */
export function AgentActivityLine({ task }: Props) {
  // The clock lives here rather than in the table: a tick must re-render the
  // two or three rows that show elapsed time, not all 50.
  const now = useClock();

  const label = t("agent.status.desktop", { status: agentInFlightLabel(task) });
  const seed = `${task.task.workspaceId}:${task.task.bugId}:agent`;

  return (
    <div className="mt-1 flex flex-col gap-0.5 pl-9">
      <span className="block truncate text-ui-xs text-sky-700" title={label}>
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-500">
        <ActivityGlyph seed={seed} />
        <span className="truncate">
          {t("agent.activity.createdElapsed", {
            time: formatStartedAt(task.task.createdAt),
            elapsed: formatElapsed(
              elapsedSince(task.task.startedAt ?? task.task.createdAt, now),
            ),
          })}
        </span>
      </span>
    </div>
  );
}

/** 1s ticker; idle rows do not re-render. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
