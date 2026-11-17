import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquare,
  PencilLine,
  Terminal,
} from "lucide-react";

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

/** One folded group inside a turn's trace. */
type TraceGroup = {
  key: "reasoning" | "notes" | "reads" | "commands" | "files";
  /** Header text with its own count (`查阅 9 项`). */
  label: string;
  entries: DshEntry[];
  live?: LiveToolCall[];
  /** Committed reasoning that is not attached to a row (`answer.reasoning`). */
  texts?: string[];
  /** The reasoning group is the one that can still be streaming. */
  liveReasoning?: boolean;
};

/**
 * The trace folded into what the turn *did*, not the order it did it in: one
 * group each for reasoning, intermediate notes, reads, commands and edits.
 * Opening the turn shows these folded rows; opening one shows its log rows.
 */
function traceGroups(
  entries: DshEntry[],
  liveTools: LiveToolCall[],
  liveReasoning: string,
  answerReasoning: string,
): TraceGroup[] {
  const buckets = new Map<TraceGroup["key"], TraceGroup>();

  const bucket = (key: TraceGroup["key"], label: string): TraceGroup => {
    let group = buckets.get(key);
    if (!group) {
      group = { key, label, entries: [] };
      buckets.set(key, group);
    }
    return group;
  };

  for (const entry of entries) {
    if (entry.kind === "tool") {
      const kind = describeTool(entry.name, entry.args).kind;
      if (kind === "read" || kind === "image") bucket("reads", "").entries.push(entry);
      else if (kind === "write" || kind === "edit") bucket("files", "").entries.push(entry);
      else if (kind === "search" || kind === "web") bucket("reads", "").entries.push(entry);
      else bucket("commands", "").entries.push(entry);
    } else if (entry.kind === "assistant") {
      if (entry.reasoning) bucket("reasoning", "").entries.push(entry);
      if (entry.text) bucket("notes", "").entries.push(entry);
    }
  }

  for (const tool of liveTools) {
    const kind = describeTool(tool.name, tool.args).kind;
    if (kind === "read" || kind === "image" || kind === "search" || kind === "web") {
      const group = bucket("reads", "");
      group.live = [...(group.live ?? []), tool];
    } else if (kind === "write" || kind === "edit") {
      const group = bucket("files", "");
      group.live = [...(group.live ?? []), tool];
    } else {
      const group = bucket("commands", "");
      group.live = [...(group.live ?? []), tool];
    }
  }

  if (liveReasoning) {
    const group = bucket("reasoning", "");
    group.liveReasoning = true;
  }
  if (answerReasoning) {
    const group = bucket("reasoning", "");
    group.texts = [...(group.texts ?? []), answerReasoning];
  }

  const order: TraceGroup["key"][] = ["reasoning", "notes", "reads", "commands", "files"];
  const files = new Set<string>();
  for (const entry of buckets.get("files")?.entries ?? []) {
    if (entry.kind === "tool") files.add(describeTool(entry.name, entry.args).target);
  }
  for (const tool of buckets.get("files")?.live ?? []) files.add(describeTool(tool.name, tool.args).target);

  return order
    .map((key) => buckets.get(key))
    .filter((group): group is TraceGroup => group !== undefined)
    .map((group) => {
      const count =
        group.key === "files"
          ? files.size
          : group.entries.length +
            (group.live?.length ?? 0) +
            (group.texts?.length ?? 0) +
            (group.liveReasoning ? 1 : 0);
      let label: string;
      switch (group.key) {
        case "reasoning":
          label = t("agent.turn.reasoning", { count });
          break;
        case "notes":
          label = t("agent.turn.notes", { count });
          break;
        case "reads":
          label = t("agent.turn.reads", { count });
          break;
        case "commands":
          label = t("agent.turn.commands", { count });
          break;
        case "files":
          label = t("agent.turn.files", { count });
          break;
      }
      return { ...group, label };
    });
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
  // Folded by default in both states: while running the block is one line of
  // "what is happening now" plus the clock; once settled it is the elapsed line.
  // Opening it is what reveals the grouped flow.
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
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
  // The timer is always its own line, never mixed into the counts: while the
  // turn runs it sits at the bottom of the block, and once it settles it
  // becomes the block's parent line.
  const timing = label
    ? t(running ? "agent.turn.working" : "agent.turn.worked", { duration: label })
    : t(running ? "agent.turn.workingPlain" : "agent.turn.trace");
  const groups = traceGroups(trace, liveTools, liveReasoning, answer?.reasoning ?? "");
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

  return (
    <div className="flex flex-col gap-2">
      {users.map((entry) => (
        <div key={entryKey(entry)} className="flex flex-col">
          <UserBubble text={entry.text} />
          <MessageMeta at={entry.at} text={entry.text} align="right" />
        </div>
      ))}

      <div className="flex flex-col gap-1">
        {/* Settled: the elapsed time is the block's parent line and the flow
            folds underneath it. Running: the timer lives at the bottom (below),
            because what matters is what is happening right now. */}
        {!running && showStatus ? (
          hasTrace ? (
            <button
              type="button"
              aria-expanded={open}
              title={open ? t("agent.turn.collapse") : t("agent.turn.expand")}
              onClick={() => setOpen((value) => !value)}
              className="-ml-1 flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-600"
            >
              <span className="shrink-0 tabular-nums">{timing}</span>
              <ChevronRight
                size={12}
                className={clsx("shrink-0 transition-transform", open && "rotate-90")}
              />
            </button>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5 px-1 text-ui-xs text-slate-400">
              <span className="shrink-0 tabular-nums">{timing}</span>
            </span>
          )
        ) : null}

        {/* Running and folded: only the newest item, one line. */}
        {running && !open && thinking ? (
          <div className="flex min-w-0 items-center gap-2 text-ui-xs text-slate-400">
            <Brain size={12} className="shrink-0" />
            <span className="shrink-0">{t("agent.action.thinking")}</span>
            <ScrollingName text={thinking} className="min-w-0 flex-1 text-slate-300" />
          </div>
        ) : null}

        {running && !open && action ? (
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
      </div>

      {open && hasTrace ? (
        <div className="flex flex-col gap-1 border-l border-border pl-3">
          {groups.map((group) => (
            <TraceGroupRow
              key={group.key}
              group={group}
              liveReasoning={group.liveReasoning ? liveReasoning : ""}
              onOpenTrace={
                sessionId
                  ? (entry) => agentActions.focusTrajectory(sessionId, recordIdOf(entry))
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}

      {/* Running: the clock is its own line at the bottom of the block. */}
      {running && showStatus ? (
        <div className="flex items-center gap-1.5 text-ui-xs text-slate-400">
          <Loader2 size={11} className="shrink-0 animate-spin" />
          {hasTrace ? (
            <button
              type="button"
              aria-expanded={open}
              title={open ? t("agent.turn.collapse") : t("agent.turn.expand")}
              onClick={() => setOpen((value) => !value)}
              className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition hover:bg-overlay hover:text-slate-600"
            >
              <span className="shrink-0 tabular-nums">{timing}</span>
              <ChevronRight
                size={12}
                className={clsx("shrink-0 transition-transform", open && "rotate-90")}
              />
            </button>
          ) : (
            <span className="shrink-0 tabular-nums">{timing}</span>
          )}
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

/** Glyph per group, so a folded flow still reads as what it did. */
function GroupIcon({ kind }: { kind: TraceGroup["key"] }) {
  const Icon = {
    reasoning: Brain,
    notes: MessageSquare,
    reads: FileText,
    commands: Terminal,
    files: PencilLine,
  }[kind];
  return <Icon size={12} className="shrink-0 text-slate-400" />;
}

/**
 * One folded group of the flow (`查阅 9 项`). Opening it is the second level:
 * the group's own rows, each a tool call or a reasoning block.
 */
function TraceGroupRow({
  group,
  liveReasoning,
  onOpenTrace,
}: {
  group: TraceGroup;
  liveReasoning: string;
  onOpenTrace?: (entry: DshEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-ml-1 flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-xs text-slate-500 transition hover:bg-overlay hover:text-slate-700"
      >
        <GroupIcon kind={group.key} />
        <span className="shrink-0">{group.label}</span>
        <ChevronRight
          size={12}
          className={clsx("shrink-0 text-slate-300 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3">
          {group.entries.map((entry) =>
            group.key === "reasoning" ? (
              <ReasoningRow
                key={entryKey(entry)}
                text={entry.kind === "assistant" ? (entry.reasoning ?? "") : ""}
              />
            ) : group.key === "notes" ? (
              <AnswerBlock
                key={entryKey(entry)}
                text={entry.kind === "assistant" ? entry.text : ""}
              />
            ) : (
              <ActionRow
                key={entryKey(entry)}
                name={entry.kind === "tool" ? entry.name : ""}
                args={entry.kind === "tool" ? entry.args : "{}"}
                status={entry.kind === "tool" ? entry.status : "ok"}
                result={entry.kind === "tool" ? entry.result : undefined}
                onOpenTrace={onOpenTrace ? () => onOpenTrace(entry) : undefined}
              />
            ),
          )}
          {(group.texts ?? []).map((text, index) => (
            <ReasoningRow key={`text-${index}`} text={text} />
          ))}
          {liveReasoning ? <ReasoningRow text={liveReasoning} live /> : null}
          {(group.live ?? []).map((tool, index) => (
            <ActionRow
              key={`live-${tool.callId || index}`}
              name={tool.name}
              args={tool.args}
              status="running"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
