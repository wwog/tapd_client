import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Bot, ChevronRight, Loader2 } from "lucide-react";

import type {
  AgentEntry,
  AgentLocale,
  AgentNotice,
  AgentTurnBlock,
} from "./types";
import type { AgentSubagentRow } from "./subagents";
import { agentLabel } from "./labels";
import { duration } from "./format";
import { buildFlows, type AgentFlow, type FlowLive } from "./flows";
import { FlowBlock } from "./FlowBlock";
import { SubagentRow } from "./SubagentRow";
import { AnswerBlock, MessageMeta, UserBubble } from "./MessageParts";

/** The live token overlay of the turn currently running. */
export type LiveTrace = FlowLive;

function entryKey(entry: AgentEntry): string {
  if (entry.kind === "tool" && entry.callId) return `tool:${entry.callId}`;
  return `${entry.kind}:${entry.seq}`;
}

/**
 * Elapsed wall time of one turn. A running turn ticks once a second; a settled
 * turn is a fixed difference, so only the live line owns an interval.
 */
function useElapsed(block: AgentTurnBlock, running: boolean): number | null {
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

type RootItem =
  | { kind: "flow"; anchor: number; flow: AgentFlow }
  | { kind: "subagent"; anchor: number; row: AgentSubagentRow }
  | { kind: "notice"; anchor: number; notice: AgentNotice };

const ROOT_RANK = { flow: 0, subagent: 1, notice: 2 } as const;

/**
 * One turn. The turn root is a plain work line — 已工作 once settled, the
 * independent 工作中 line at the bottom while running. Under it sit the root
 * items in event order: flows (steps between two 说明), sub-agent rows (their
 * own fold domains) and orphan settle notices.
 *
 * A flow's 说明 never folds, so the reading of a settled turn keeps every
 * boundary visible; only the groups inside a flow are disclosed.
 */
export function TurnBlock({
  block,
  running,
  live,
  locale,
  onRetry,
  subagents,
  renderTurns,
  openSubagentIds,
  onToggleSubagent,
  orphanNotices,
}: {
  block: AgentTurnBlock;
  running: boolean;
  live?: LiveTrace;
  locale: AgentLocale;
  /** Failure retry is a host action; without one no button is shown. */
  onRetry?: () => void;
  /** Root-level sub-agent rows for this turn. */
  subagents?: AgentSubagentRow[];
  /** Renders one child's transcript (the host re-uses this component). */
  renderTurns?: (child: AgentSubagentRow) => ReactNode;
  /** Controlled child folds, forwarded to the root rows. */
  openSubagentIds?: ReadonlySet<string>;
  /** A root fold toggled; the host lazy-loads the child transcript here. */
  onToggleSubagent?: (sessionId: string) => void;
  /** Settled notices that matched no `subagent` call (old logs, orphans). */
  orphanNotices?: AgentNotice[];
}) {
  const [retrying, setRetrying] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [internalOpen, setInternalOpen] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const users = block.entries.filter((entry) => entry.kind === "user");
  const prompt = users[users.length - 1]?.text ?? "";
  const end = block.end;
  const failure = !running && (end?.reason === "error" || end?.reason === "blocked");
  const aborted = !running && end?.reason === "aborted";

  const flows = buildFlows(block, running ? live : undefined, running);
  const children = subagents ?? [];
  const orphans = orphanNotices ?? [];

  const items: RootItem[] = [
    ...flows.map((flow): RootItem => ({ kind: "flow", anchor: flow.firstSeq, flow })),
    ...children.map(
      (row): RootItem => ({ kind: "subagent", anchor: row.callSeq, row }),
    ),
    ...orphans.map(
      (notice): RootItem => ({ kind: "notice", anchor: notice.seq, notice }),
    ),
  ].sort(
    (left, right) =>
      left.anchor - right.anchor || ROOT_RANK[left.kind] - ROOT_RANK[right.kind],
  );

  // The turn's last committed 说明 is the answer: it stays visible when the
  // process is folded, while its own flow keeps only the summary/groups inside.
  const answerFlow = running
    ? undefined
    : [...flows].reverse().find((flow) => flow.note !== undefined);
  const answer = answerFlow?.note;
  const innerFlows = flows.filter(
    (flow) => flow !== answerFlow || flow.steps.length > 0,
  );
  const hasInner =
    innerFlows.length > 0 || children.length > 0 || orphans.length > 0;

  const openIds = openSubagentIds ?? internalOpen;
  const toggleChild = (sessionId: string) => {
    if (!openSubagentIds) {
      setInternalOpen((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
    }
    onToggleSubagent?.(sessionId);
  };

  const retry = async () => {
    if (retrying || !onRetry) return;
    setRetrying(true);
    // The engine re-runs the turn from its own log: the prompt is not sent
    // again, so it stays a single message in the context.
    await onRetry();
    setRetrying(false);
  };

  const elapsed = useElapsed(block, running);
  const label = elapsed !== null ? duration(elapsed, locale) : null;
  const hasTrace =
    flows.length > 0 || children.length > 0 || orphans.length > 0;
  const showStatus = running || hasTrace || elapsed !== null;

  const renderItem = (item: RootItem, hideAnswerNote: boolean) => {
    if (item.kind === "flow") {
      return (
        <FlowBlock
          key={item.flow.key}
          flow={item.flow}
          running={running}
          live={live}
          locale={locale}
          hideNote={hideAnswerNote && item.flow === answerFlow}
        />
      );
    }
    if (item.kind === "subagent") {
      return (
        <SubagentRow
          key={`subagent:${item.row.sessionId}`}
          row={item.row}
          locale={locale}
          renderTurns={renderTurns}
          open={openIds.has(item.row.sessionId)}
          onToggle={() => toggleChild(item.row.sessionId)}
        />
      );
    }
    return <NoticeRow key={`notice:${item.notice.seq}`} notice={item.notice} locale={locale} />;
  };

  return (
    <div className="flex flex-col gap-2">
      {users.map((entry) => (
        <div key={entryKey(entry)} className="flex flex-col">
          <UserBubble text={entry.text} locale={locale} />
          <MessageMeta at={entry.at} text={entry.text} align="right" locale={locale} />
        </div>
      ))}

      {/* Settled: 已工作 is the process fold. Collapsed it hides every flow,
          sub-agent row and intermediate 说明; the turn's last 说明 stays
          outside, always readable. */}
      {!running && showStatus ? (
        hasInner ? (
          <button
            type="button"
            aria-expanded={processOpen}
            title={
              processOpen
                ? agentLabel("turn.collapse", locale)
                : agentLabel("turn.expand", locale)
            }
            onClick={() => setProcessOpen((value) => !value)}
            className="-ml-1 inline-flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-600"
          >
            <span className="shrink-0 tabular-nums">
              {label
                ? agentLabel("turn.worked", locale, { duration: label })
                : agentLabel("turn.workedPlain", locale)}
            </span>
            <ChevronRight
              size={12}
              className={clsx(
                "shrink-0 text-slate-300 transition-transform",
                processOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5 self-start px-1 text-ui-xs text-slate-400">
            <span className="tabular-nums">
              {label
                ? agentLabel("turn.worked", locale, { duration: label })
                : agentLabel("turn.workedPlain", locale)}
            </span>
          </span>
        )
      ) : null}

      {running
        ? items.map((item) => renderItem(item, false))
        : hasInner && processOpen
          ? (
              <div className="flex flex-col gap-2 border-l border-border pl-3">
                {items.map((item) => renderItem(item, true))}
              </div>
            )
          : null}

      {!running && answer ? (
        <div className="flex flex-col">
          <AnswerBlock text={answer.text} locale={locale} />
          <MessageMeta
            at={answer.at}
            text={answer.text}
            align="left"
            locale={locale}
            usage={answer.usage}
            provider={answer.provider}
            model={answer.model}
          />
        </div>
      ) : null}

      {/* Running: the clock is independent, at the bottom, never a fold. */}
      {running ? (
        <div className="flex items-center gap-1.5 text-ui-xs text-slate-400">
          <Loader2 size={11} className="shrink-0 animate-spin" />
          <span className="shrink-0 tabular-nums">
            {label
              ? agentLabel("turn.working", locale, { duration: label })
              : agentLabel("turn.workingPlain", locale)}
          </span>
        </div>
      ) : null}

      {failure ? (
        <div className="flex items-start gap-2 text-ui-xs text-rose-600">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 select-text break-words" title={end?.error}>
            {end?.reason === "blocked"
              ? agentLabel("turn.blocked", locale)
              : agentLabel("turn.failed", locale)}
            {end?.error ? ` · ${end.error}` : ""}
          </span>
          {prompt && onRetry ? (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption text-slate-700 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {retrying ? <Loader2 size={14} className="animate-spin" /> : null}
              {agentLabel("turn.retry", locale)}
            </button>
          ) : null}
        </div>
      ) : aborted ? (
        <div className="text-ui-xs text-slate-400">{agentLabel("turn.aborted", locale)}</div>
      ) : null}
    </div>
  );
}

/**
 * A settle notice that matched no `subagent` call: one closing message row,
 * because without a call row there is no root fold to attach it to.
 */
function NoticeRow({ notice, locale }: { notice: AgentNotice; locale: AgentLocale }) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 py-0.5 text-ui-xs">
      <Bot size={12} className="mt-0.5 shrink-0 text-slate-400" />
      <span className="shrink-0 text-slate-500">
        {agentLabel("notice.closing", locale)}:
      </span>
      <span className="min-w-0 flex-1 break-words text-slate-500 select-text">
        {notice.text.trim() !== "" ? notice.text : agentLabel("notice.noClosing", locale)}
      </span>
    </div>
  );
}
