import { useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Brain, ChevronRight, Loader2, PencilLine } from "lucide-react";

import type { DshEntry } from "../lib/dsh";
import { t } from "../lib/i18n";
import { Button } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { agentActions, type LiveToolCall } from "./store";
import type { TurnBlock as TurnBlockModel } from "./turns";
import { describeTool, reasoningPreview, runningVerb } from "./actions";
import { AnswerBlock, MessageMeta, UserBubble } from "./MessageParts";
import { ActionIcon, ActionRow, ReasoningRow } from "./TraceRows";
import { recordIdOf } from "./trajectory/model";
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
 * The trace's headline: what the turn did, by count. It reads like a work log
 * ("read 4, ran 5 commands, changed 6 files"), so a long turn is legible
 * without scrolling the whole timeline.
 */
function traceSummary(entries: DshEntry[], liveTools: LiveToolCall[]): string | null {
  let reads = 0;
  let commands = 0;
  let searches = 0;
  const files = new Set<string>();

  const visit = (name: string, args: string) => {
    const action = describeTool(name, args);
    if (action.kind === "read" || action.kind === "image") reads += 1;
    else if (action.kind === "bash") commands += 1;
    else if (action.kind === "search" || action.kind === "web") searches += 1;
    else if (action.kind === "write" || action.kind === "edit") files.add(action.target);
  };

  for (const entry of entries) {
    if (entry.kind === "tool") visit(entry.name, entry.args);
  }
  for (const tool of liveTools) visit(tool.name, tool.args);

  const parts: string[] = [];
  if (reads > 0) parts.push(t("agent.turn.reads", { count: reads }));
  if (commands > 0) parts.push(t("agent.turn.commands", { count: commands }));
  if (searches > 0) parts.push(t("agent.turn.searches", { count: searches }));
  if (files.size > 0) parts.push(t("agent.turn.files", { count: files.size }));
  return parts.length > 0 ? parts.join(t("agent.turn.summarySeparator")) : null;
}

/**
 * One turn, the way the reference agent UI reads: the prompt, a live line for
 * what the model is thinking or doing, a "working for…" timer, and the final
 * answer. Everything the turn did on the way there — reasoning, tool calls,
 * intermediate notes — is the expandable trace.
 */
export function TurnBlock({
  block,
  running,
  live,
  sessionId,
}: {
  block: TurnBlockModel;
  running: boolean;
  live?: LiveTrace;
  /** The session this turn belongs to; retry is addressed to it. */
  sessionId?: string;
}) {
  const [open, setOpen] = useState(running);
  const [retrying, setRetrying] = useState(false);
  // A running turn shows its own activity; the moment it settles the whole flow
  // folds into its summary line. The user can still open it again, and the next
  // transition re-applies the default.
  useEffect(() => {
    setOpen(running);
  }, [running]);
  const users = block.entries.filter((entry) => entry.kind === "user");
  const content = block.entries.filter((entry) => entry.kind !== "user");
  const end = block.end;
  const failure = !running && (end?.reason === "error" || end?.reason === "blocked");
  const aborted = !running && end?.reason === "aborted";
  // The last committed answer of a settled turn; while running the streaming
  // text is the answer and every committed row is already trace. A failed
  // turn's last note is not an answer either — it stays in the trace above
  // the error row instead of masquerading as the reply.
  const answer = running || failure ? undefined : [...content].reverse().find(isAnswer);
  const trace = content.filter((entry) => entry !== answer);
  const liveText = running ? (live?.text ?? "") : "";
  const liveReasoning = running ? (live?.reasoning.trim() ?? "") : "";
  const liveTools = running ? (live?.tools ?? []) : [];
  const prompt = users[users.length - 1]?.text ?? "";

  const retry = async () => {
    if (retrying || !sessionId) return;
    setRetrying(true);
    // The engine re-runs the turn from its own log: the prompt is not sent
    // again, so it stays a single message in the context.
    await agentActions.retryTurn(sessionId);
    setRetrying(false);
  };

  const hasTrace =
    trace.length > 0 ||
    Boolean(answer?.reasoning) ||
    Boolean(liveReasoning) ||
    liveTools.length > 0;

  const elapsed = useElapsed(block, running);
  const label = elapsed !== null ? duration(elapsed) : null;
  const status = running
    ? label
      ? t("agent.turn.working", { duration: label })
      : t("agent.turn.workingPlain")
    : label
      ? t("agent.turn.worked", { duration: label })
      : t("agent.turn.trace");
  // A loose block from an old log has no markers and nothing to settle, so it
  // gets no status line at all rather than a permanent "trace" label.
  const showStatus = running || hasTrace || elapsed !== null;

  // One line of live commentary, like the reference UI: the running action
  // wins over thinking. Only an in-flight call counts as "current" — a
  // committed call that already finished is history, not what is happening.
  const liveTool = liveTools[liveTools.length - 1];
  const pendingTool = running
    ? [...trace]
        .reverse()
        .find(
          (entry): entry is Extract<DshEntry, { kind: "tool" }> =>
            entry.kind === "tool" && entry.status === "running",
        )
    : undefined;
  const current = liveTool ?? pendingTool;
  const action =
    running && !liveText && current && current.name
      ? describeTool(current.name, current.args)
      : null;
  const thinking =
    running && !liveText && !action && liveReasoning
      ? reasoningPreview(liveReasoning)
      : "";
  // The flow's own statistics. A running flow has none — it is still deciding
  // what it did; the settled flow folds into this line.
  const summary = traceSummary(trace, liveTools);

  return (
    <div className="flex flex-col gap-2">
      {users.map((entry) => (
        <div key={entryKey(entry)} className="flex flex-col">
          <UserBubble text={entry.text} />
          <MessageMeta at={entry.at} text={entry.text} align="right" />
        </div>
      ))}

      <div className="flex flex-col gap-1">
        {/* The folded one-liner: only while the trace is closed, so an open
            trace never repeats what its own rows already say. */}
        {!open && thinking ? (
          <div className="flex min-w-0 items-center gap-2 text-ui-xs text-slate-400">
            <Brain size={12} className="shrink-0" />
            <span className="shrink-0">{t("agent.action.thinking")}</span>
            <ScrollingName text={thinking} className="min-w-0 flex-1 text-slate-300" />
          </div>
        ) : null}

        {!open && action ? (
          <div className="flex min-w-0 items-center gap-2 text-ui-xs">
            <ActionIcon action={action} />
            <span className="shrink-0 text-slate-500">{runningVerb(action.kind)}</span>
            <ScrollingName
              text={action.target}
              className="min-w-0 flex-1 font-mono text-slate-600"
            />
            {action.added ? (
              <span className="shrink-0 tabular-nums text-emerald-600">
                +{action.added}
              </span>
            ) : null}
            {action.removed ? (
              <span className="shrink-0 tabular-nums text-rose-500">
                -{action.removed}
              </span>
            ) : null}
          </div>
        ) : null}

        {showStatus ? (
          <div className="flex items-center gap-1.5 text-ui-xs text-slate-400">
            {running ? <Loader2 size={11} className="shrink-0 animate-spin" /> : null}
            {hasTrace ? (
              <button
                type="button"
                aria-expanded={open}
                title={open ? t("agent.turn.collapse") : t("agent.turn.expand")}
                onClick={() => setOpen((value) => !value)}
                className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition hover:bg-overlay hover:text-slate-600"
              >
                {/* Settled flows fold into their statistics; a running one has
                    none yet, so it shows its clock instead. */}
                {!running && summary ? (
                  <>
                    <PencilLine size={12} className="shrink-0 text-slate-400" />
                    <ScrollingName text={summary} className="min-w-0 flex-1 text-slate-500" />
                    <span className="shrink-0 tabular-nums text-slate-300">{status}</span>
                  </>
                ) : (
                  <span className="shrink-0 tabular-nums">{status}</span>
                )}
                <ChevronRight
                  size={12}
                  className={clsx("shrink-0 transition-transform", open && "rotate-90")}
                />
              </button>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5 px-1">
                <span className="shrink-0 tabular-nums">{status}</span>
              </span>
            )}
          </div>
        ) : null}
      </div>

      {open && hasTrace ? (
        <div className="flex flex-col gap-2 border-l border-border pl-3">
          {trace.map((entry) => (
            <TraceEntry
              key={entryKey(entry)}
              entry={entry}
              onOpenTrace={
                sessionId
                  ? () =>
                      agentActions.focusTrajectory(sessionId, recordIdOf(entry))
                  : undefined
              }
            />
          ))}
          {answer?.reasoning ? <ReasoningRow text={answer.reasoning} /> : null}
          {liveReasoning ? <ReasoningRow text={liveReasoning} live /> : null}
          {liveTools.map((tool, index) => (
            <ActionRow
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

      {failure ? (
        <div className="flex items-start gap-2 text-ui-xs text-rose-600">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 select-text break-words" title={end?.error}>
            {end?.reason === "blocked" ? t("agent.turn.blocked") : t("agent.turn.failed")}
            {end?.error ? ` · ${end.error}` : ""}
          </span>
          {prompt ? (
            <Button size="sm" loading={retrying} onClick={() => void retry()}>
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      ) : aborted ? (
        <div className="text-ui-xs text-slate-400">{t("agent.turn.aborted")}</div>
      ) : null}
    </div>
  );
}

/** One committed row of the trace: an intermediate note or a tool call. */
function TraceEntry({
  entry,
  onOpenTrace,
}: {
  entry: DshEntry;
  onOpenTrace?: () => void;
}) {
  if (entry.kind === "tool") {
    return (
      <ActionRow
        name={entry.name}
        args={entry.args}
        status={entry.status}
        result={entry.result}
        onOpenTrace={onOpenTrace}
      />
    );
  }
  if (entry.kind === "assistant") {
    return (
      <>
        {entry.reasoning ? <ReasoningRow text={entry.reasoning} /> : null}
        {entry.text ? <AnswerBlock text={entry.text} /> : null}
      </>
    );
  }
  return null;
}
