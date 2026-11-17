import { useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronRight, Loader2 } from "lucide-react";

import type { DshEntry } from "../lib/dsh";
import { t } from "../lib/i18n";
import type { LiveToolCall } from "./store";
import type { TurnBlock as TurnBlockModel } from "./turns";
import { AnswerBlock, MessageMeta, UserBubble } from "./MessageParts";
import { ToolRow, TraceReasoning } from "./TraceRows";
import { duration } from "./usage/format";

/** The live attempt overlaid on the running turn. */
export type LiveTrace = {
  text: string;
  reasoning: string;
  tools: LiveToolCall[];
};

type AssistantEntry = Extract<DshEntry, { kind: "assistant" }>;

function isAnswer(entry: DshEntry): entry is AssistantEntry {
  return entry.kind === "assistant" && entry.text.trim().length > 0;
}

function entryKey(entry: DshEntry): string {
  if (entry.kind === "tool" && entry.callId) return `tool:${entry.callId}`;
  return `${entry.kind}:${entry.seq}`;
}

/**
 * Elapsed wall time of one turn. A running turn ticks once a second; a settled
 * turn is a fixed difference, so only the live header owns an interval.
 */
function useElapsed(block: TurnBlockModel, running: boolean): number | null {
  const start = block.start ? Date.parse(block.start.at) : Number.NaN;
  const end = block.end ? Date.parse(block.end.at) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (Number.isNaN(start)) return null;
  const stop = running ? now : end;
  if (Number.isNaN(stop) || stop < start) return null;
  return stop - start;
}

/**
 * One turn, the way the reference agent UI reads: the prompt, a single "worked
 * for…" line, and the final answer. Everything the turn did on the way there —
 * reasoning, tool calls, intermediate notes — is the expandable trace, so a
 * long tool loop does not drown the answer.
 */
export function TurnBlock({
  block,
  running,
  live,
}: {
  block: TurnBlockModel;
  running: boolean;
  live?: LiveTrace;
}) {
  const [open, setOpen] = useState(false);
  const users = block.entries.filter((entry) => entry.kind === "user");
  const content = block.entries.filter((entry) => entry.kind !== "user");
  // The last committed answer of a settled turn; while running the streaming
  // text is the answer and every committed row is already trace.
  const answer = running
    ? undefined
    : [...content].reverse().find(isAnswer);
  const trace = content.filter((entry) => entry !== answer);
  const liveText = running ? (live?.text ?? "") : "";
  const liveReasoning = running ? (live?.reasoning.trim() ?? "") : "";
  const liveTools = running ? (live?.tools ?? []) : [];
  const currentTool = running ? liveTools[liveTools.length - 1]?.name : undefined;

  const hasTrace =
    trace.length > 0 ||
    Boolean(answer?.reasoning) ||
    Boolean(liveReasoning) ||
    liveTools.length > 0;

  const elapsed = useElapsed(block, running);
  const label = elapsed !== null ? duration(elapsed) : null;
  const status = running
    ? label
      ? t("agent.turn.running", { duration: label })
      : t("agent.turn.runningPlain")
    : label
      ? t("agent.turn.worked", { duration: label })
      : t("agent.turn.trace");
  // A loose block from an old log has no markers and nothing to settle, so it
  // gets no status line at all rather than a permanent "trace" label.
  const showStatus = running || hasTrace || elapsed !== null;

  return (
    <div className="flex flex-col gap-1.5">
      {users.map((entry) => (
        <div key={entryKey(entry)} className="flex flex-col">
          <UserBubble text={entry.text} />
          <MessageMeta at={entry.at} text={entry.text} align="right" />
        </div>
      ))}

      {showStatus ? (
        <div className="flex items-center gap-1.5 text-ui-xs text-slate-400">
          {running ? <Loader2 size={11} className="shrink-0 animate-spin" /> : null}
            {hasTrace ? (
              <button
                type="button"
                aria-expanded={open}
                title={open ? t("agent.turn.collapse") : t("agent.turn.expand")}
                onClick={() => setOpen((value) => !value)}
                className="-ml-1 inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 transition hover:bg-overlay hover:text-slate-600"
              >
                <span className="shrink-0 tabular-nums">{status}</span>
                {currentTool ? (
                  <span className="min-w-0 truncate font-mono text-slate-400">
                    {currentTool}
                  </span>
                ) : null}
                <ChevronRight
                  size={12}
                  className={clsx("shrink-0 transition-transform", open && "rotate-90")}
                />
              </button>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5 px-1">
                <span className="shrink-0 tabular-nums">{status}</span>
                {currentTool ? (
                  <span className="min-w-0 truncate font-mono text-slate-400">
                    {currentTool}
                  </span>
                ) : null}
              </span>
            )}
        </div>
      ) : null}

      {open && hasTrace ? (
        <div className="flex flex-col gap-2 border-l border-border pl-3">
          {trace.map((entry) => (
            <TraceEntry key={entryKey(entry)} entry={entry} />
          ))}
          {answer?.reasoning ? <TraceReasoning text={answer.reasoning} /> : null}
          {liveReasoning ? <TraceReasoning text={liveReasoning} /> : null}
          {liveTools.map((tool, index) => (
            <ToolRow
              key={`live-${tool.callId || index}`}
              name={tool.name}
              args={tool.args}
              status="running"
            />
          ))}
        </div>
      ) : null}

      {answer ? (
        <div className="flex flex-col">
          <AnswerBlock text={answer.text} />
          <MessageMeta
            at={answer.at}
            text={answer.text}
            align="left"
            usage={answer.usage}
            provider={answer.provider}
            model={answer.model}
          />
        </div>
      ) : liveText ? (
        <AnswerBlock text={liveText} />
      ) : null}
    </div>
  );
}

/** One committed row of the trace: an intermediate note or a tool call. */
function TraceEntry({ entry }: { entry: DshEntry }) {
  if (entry.kind === "tool") {
    return (
      <ToolRow
        name={entry.name}
        args={entry.args}
        status={entry.status}
        result={entry.result}
      />
    );
  }
  if (entry.kind === "assistant") {
    return (
      <>
        {entry.reasoning ? <TraceReasoning text={entry.reasoning} /> : null}
        {entry.text ? <AnswerBlock text={entry.text} /> : null}
      </>
    );
  }
  return null;
}
