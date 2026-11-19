import { memo, type ReactNode } from "react";
import clsx from "clsx";
import { Bot, ChevronRight, Loader2 } from "lucide-react";

import type { AgentLocale } from "./types";
import type { AgentSubagentRow } from "./subagents";
import { agentLabel } from "./labels";
import { ScrollingName } from "./ScrollingName";
import { Collapse } from "./Collapse";

/** Status text for the root row. */
function childStatus(row: AgentSubagentRow, locale: AgentLocale): string {
  if (row.running) return agentLabel("subagent.running", locale);
  switch (row.settled?.stopReason) {
    case "error":
      return agentLabel("subagent.failed", locale);
    case "aborted":
      return agentLabel("subagent.stopped", locale);
    case "max-tokens":
      return agentLabel("subagent.outOfRoom", locale);
    case "refusal":
      return agentLabel("subagent.declined", locale);
    default:
      return agentLabel("subagent.done", locale);
  }
}

/** Icon tile hues, cycled per call so concurrent children stay distinguishable. */
const ACCENTS = [
  "from-sky-400 to-indigo-500",
  "from-violet-400 to-fuchsia-500",
  "from-amber-400 to-orange-500",
  "from-emerald-400 to-teal-500",
] as const;

/**
 * A root-level sub-agent row. It is its own fold domain: the single line is
 * the model's `description` (not a verb), and opening it inlines the child
 * session's transcript — which renders with the same flow-based turn view.
 *
 * The row never joins a flow's groups or summary: a sub-agent is work at the
 * turn root, not a step among reads and commands.
 */
export const SubagentRow = memo(function SubagentRow({
  row,
  locale,
  renderTurns,
  open,
  onToggle,
}: {
  row: AgentSubagentRow;
  locale: AgentLocale;
  /** Renders the child transcript; the host recurses through the turn view. */
  renderTurns?: (child: AgentSubagentRow) => ReactNode;
  open: boolean;
  /** Receives the child session id, so the callback stays stable per parent. */
  onToggle: (sessionId: string) => void;
}) {
  const label =
    row.description || row.name || agentLabel("subagent.group", locale);
  const accent =
    ACCENTS[Math.abs(row.callSeq) % ACCENTS.length] ?? ACCENTS[0];
  const hasTranscript = (row.turns.length > 0 || Boolean(row.error)) && renderTurns;

  return (
    <div data-component="SubagentRow" className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(row.sessionId)}
        className="group/subagent -ml-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-ui-caption transition-colors hover:bg-sky-50/60 hover:text-sky-800"
      >
        <span
          className={clsx(
            "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] bg-gradient-to-br text-white",
            accent,
          )}
        >
          <Bot size={10} />
        </span>
        <ScrollingName
          text={label}
          className="min-w-0 flex-1 text-sky-700"
        />
        {row.running ? (
          <Loader2 size={10} className="shrink-0 animate-spin text-sky-500" />
        ) : null}
        <span className="shrink-0 text-slate-400">{childStatus(row, locale)}</span>
        <ChevronRight
          size={12}
          className={clsx(
            "shrink-0 text-sky-300 opacity-40 transition-[opacity,transform] group-hover/subagent:opacity-100 group-focus-visible/subagent:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>

      <Collapse open={open}>
        <div className="mt-1 flex max-h-[60vh] flex-col gap-2 overflow-y-auto overscroll-contain border-l border-sky-200 pl-3">
          {row.error && row.turns.length === 0 ? (
            <div className="text-ui-xs text-rose-600">{row.error}</div>
          ) : row.loading || (row.running && !hasTranscript) ? (
            <div className="flex items-center gap-1.5 text-ui-xs text-slate-400">
              <Loader2 size={11} className="animate-spin" />
              {agentLabel("subagent.running", locale)}
            </div>
          ) : hasTranscript ? (
            renderTurns(row)
          ) : row.turns.length > 0 ? (
            // A host without a transcript renderer still shows what it has.
            <div className="text-ui-xs text-slate-400">
              {agentLabel("subagent.group", locale)}
            </div>
          ) : null}
          {row.settled?.text ? (
            <div className="text-ui-xs text-slate-500">
              <span className="text-slate-400">
                {agentLabel("notice.closing", locale)}:
              </span>{" "}
              <span className="break-words">{row.settled.text}</span>
            </div>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
});
