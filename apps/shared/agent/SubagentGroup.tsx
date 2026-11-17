import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { Bot, ChevronRight, Loader2 } from "lucide-react";

import type { AgentLocale, AgentTurnBlock } from "./types";
import { agentLabel } from "./labels";

/** One child agent shown inside the parent turn's subagent group. */
export type AgentSubagentChild = {
  /** Model-facing child name: `agent-1`, or `reviewer/checker` when nested. */
  name: string;
  /** Agent preset the child ran under, when known. */
  preset?: string;
  /** The child's own session id — the fold's data source. */
  sessionId: string;
  /** True while the child's session is still running a turn. */
  running: boolean;
  /** Child transcript grouped with the shared `groupTurns`; empty until loaded. */
  turns: AgentTurnBlock[];
  /** True while the host is fetching the child transcript for the first time. */
  loading?: boolean;
  /** The fetch failed; the fold shows this instead of retrying silently. */
  error?: string;
  /** The settled notice, once the runtime has delivered one. */
  settled?: { at: string; summary: string; stopReason?: string; text: string };
};

/** Status text for the folded child row. */
function childStatus(child: AgentSubagentChild, locale: AgentLocale): string {
  if (child.running) return agentLabel("subagent.running", locale);
  switch (child.settled?.stopReason) {
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

/**
 * The sub-agent fold of one turn: a `subagent` tool call starts a child, the
 * child keeps its own session, and this group is where its chat lives —
 * folded at the root level like the turn's own "已工作" line, expandable into
 * the child's turns. The host app renders each child's turns through
 * `renderTurns` so the same turn-block component is reused end to end.
 *
 * Child folds are uncontrolled by default (`openIds` omitted → internal
 * state). Passing `openIds` makes the host own them; `onToggleChild` fires
 * either way so a host can lazy-load a transcript when a fold opens instead
 * of inferring that from mount/unmount.
 */
export function SubagentGroup({
  subagents,
  locale,
  renderTurns,
  openIds,
  onToggleChild,
}: {
  subagents: AgentSubagentChild[];
  locale: AgentLocale;
  /** Renders one child's transcript (already grouped into turns). */
  renderTurns: (child: AgentSubagentChild) => ReactNode;
  /** Controlled child-fold state; omit for the internal default. */
  openIds?: ReadonlySet<string>;
  /** A child fold was toggled; fires in both controlled and uncontrolled mode. */
  onToggleChild?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set());
  if (subagents.length === 0) return null;

  const expanded = openIds ?? internalExpanded;

  const toggleChild = (sessionId: string) => {
    if (!openIds) {
      setInternalExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
    }
    onToggleChild?.(sessionId);
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-ml-1 flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-xs text-slate-500 transition hover:bg-overlay hover:text-slate-700"
      >
        <Bot size={12} className="shrink-0 text-slate-400" />
        <span className="shrink-0">
          {agentLabel("subagent.group", locale)} {subagents.length}
        </span>
        <ChevronRight
          size={12}
          className={clsx("shrink-0 text-slate-300 transition-transform", open && "rotate-90")}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-1 border-l border-border pl-3">
          {subagents.map((child) => {
            const isOpen = expanded.has(child.sessionId);
            return (
              <div key={child.sessionId} className="flex min-w-0 flex-col">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleChild(child.sessionId)}
                  className="-ml-1 flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-xs text-slate-500 transition hover:bg-overlay hover:text-slate-700"
                >
                  {child.running ? (
                    <Loader2 size={11} className="shrink-0 animate-spin text-slate-400" />
                  ) : (
                    <Bot size={11} className="shrink-0 text-slate-400" />
                  )}
                  <span className="shrink-0 font-mono">{child.name}</span>
                  {child.preset ? (
                    <span className="shrink-0 text-slate-400">· {child.preset}</span>
                  ) : null}
                  <span className="shrink-0 text-slate-400">· {childStatus(child, locale)}</span>
                  <ChevronRight
                    size={12}
                    className={clsx(
                      "shrink-0 text-slate-300 transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                </button>
                {isOpen ? (
                  <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3">
                    {child.error && child.turns.length === 0 ? (
                      <div className="text-ui-xs text-rose-600">{child.error}</div>
                    ) : child.loading && child.turns.length === 0 ? (
                      <div className="flex items-center gap-1.5 text-ui-xs text-slate-400">
                        <Loader2 size={11} className="animate-spin" />
                      </div>
                    ) : (
                      renderTurns(child)
                    )}
                    {child.settled && child.settled.text ? (
                      <div className="text-ui-xs text-slate-500">
                        <span className="text-slate-400">
                          {agentLabel("notice.closing", locale)}:
                        </span>{" "}
                        <span className="break-words">{child.settled.text}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
