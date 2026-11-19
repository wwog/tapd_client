import { useEffect, useState } from "react";
import clsx from "clsx";
import { Clock, PauseCircle } from "lucide-react";

import { ActivityGlyph } from "./ActivityGlyph";
import type { TaskFeedEntry } from "../agent/taskFeed";
import { localeTag, t } from "../lib/i18n";

/**
 * Two compact lines under a bug title while the bug owns a workflow task:
 * who is working on it ([model] 处理中 / 排队中 #n) and the created/elapsed
 * times with a 16px activity glyph. Informational only — the row click still
 * opens the bug, the action column carries the jump to the task.
 */
export function AgentActivityLine({ entry }: { entry: TaskFeedEntry }) {
  const now = useClock();
  const { task } = entry;
  const interrupted = entry.interrupted;
  const model = entry.model ?? t("bugs.agentFallbackName");

  const label = interrupted
    ? t("bugs.agentInterrupted", { model })
    : task.workflow === "queued"
      ? entry.position
        ? t("bugs.agentQueuedPosition", {
            model,
            position: entry.position,
          })
        : t("bugs.agentQueued", { model })
      : task.workflow === "awaiting_review"
        ? t("bugs.agentAwaitingReview", { model })
        : task.workflow === "finalizing"
          ? t("bugs.agentFinalizing", { model })
          : t("bugs.agentRunning", { model });

  return (
    <div
      data-component="AgentActivityLine"
      className="mt-1 flex flex-col gap-0.5 pl-9"
    >
      <span
        className={clsx(
          "block truncate",
          interrupted || task.workflow === "awaiting_review"
            ? "text-amber-700"
            : task.workflow === "queued"
              ? "text-slate-600"
              : "text-sky-700",
        )}
        title={label}
      >
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-500">
        {interrupted ? (
          <PauseCircle size={12} className="shrink-0 text-amber-600" />
        ) : task.workflow === "awaiting_review" ? (
          <Clock size={12} className="shrink-0 text-amber-600" />
        ) : (
          <ActivityGlyph seed={task.id} />
        )}
        <span className="truncate">
          {t("bugs.agentElapsed", {
            time: startClock(task.createdAt),
            elapsed: elapsedSince(task.createdAt, now),
          })}
        </span>
      </span>
    </div>
  );
}

/** 1s ticker; idle rows without a task never mount this. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function startClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(localeTag(), {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function elapsedSince(value: string, now: number): string {
  const start = Date.parse(value);
  if (!Number.isFinite(start)) return "—";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return t("bugs.agentElapsedHours", { hours, minutes });
  }
  if (minutes > 0) {
    return t("bugs.agentElapsedMinutes", { minutes, seconds: rest });
  }
  return t("bugs.agentElapsedSeconds", { seconds });
}
