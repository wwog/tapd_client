import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { AlertTriangle, Bot, ChevronRight, Loader2, Terminal } from "lucide-react";

import type {
  AgentCommand,
  AgentEntry,
  AgentLocale,
  AgentNotice,
  AgentTurnBlock,
} from "./types";
import type { AgentSubagentRow } from "./subagents";
import { agentLabel } from "./labels";
import { duration } from "./format";
import { buildFlows, isClosed, type AgentFlow, type FlowLive } from "./flows";
import { Collapse } from "./Collapse";
import { FlowBlock } from "./FlowBlock";
import { SubagentRow } from "./SubagentRow";
import { AnswerBlock, MessageMeta, UserBubble } from "./MessageParts";

/** The live token overlay of the turn currently running. */
export type LiveTrace = FlowLive;

const EMPTY_SUBAGENTS: AgentSubagentRow[] = [];
const EMPTY_NOTICES: AgentNotice[] = [];

function entryKey(entry: AgentEntry): string {
  if (entry.kind === "tool" && entry.callId) return `tool:${entry.callId}`;
  return `${entry.kind}:${entry.seq}`;
}

/**
 * Elapsed wall time of one turn. A running turn ticks once a second; a settled
 * turn is a fixed difference, so only the live line owns an interval.
 */
function useElapsed(block: AgentTurnBlock, running: boolean): number | null {
  const { start, end } = useMemo(
    () => ({
      start: block.start ? Date.parse(block.start.at) : Number.NaN,
      end: block.end ? Date.parse(block.end.at) : Number.NaN,
    }),
    [block.start, block.end],
  );
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

export type TurnBlockProps = {
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
};

/**
 * One turn. The turn root is a plain work line — 已工作 once settled, the
 * independent 工作中 line at the bottom while running. Under it sit the root
 * items in event order: flows (steps between two 说明), sub-agent rows (their
 * own fold domains) and orphan settle notices.
 *
 * A flow's 说明 never folds, so the reading of a settled turn keeps every
 * boundary visible; only the groups inside a flow are disclosed.
 *
 * Memoized: streaming only re-renders the active turn (its `live` prop changes);
 * every settled turn keeps the same block, rows and callbacks and bails out.
 */
function TurnBlockImpl({
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
}: TurnBlockProps) {
  const [retrying, setRetrying] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [internalOpen, setInternalOpen] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const users = useMemo(
    () => block.entries.filter((entry) => entry.kind === "user"),
    [block.entries],
  );
  // Slash commands are lifecycle rows, not work: they stay visible next to the
  // prompt instead of folding under 已工作, so a `/compact` result is readable
  // after the turn that framed it settled.
  const commands = useMemo(
    () => block.entries.filter((entry) => entry.kind === "command"),
    [block.entries],
  );
  const prompt = users[users.length - 1]?.text ?? "";
  const end = block.end;
  const failure = !running && (end?.reason === "error" || end?.reason === "blocked");
  const aborted = !running && end?.reason === "aborted";

  const flows = useMemo(
    () => buildFlows(block, running ? live : undefined, running),
    [block, running, live],
  );
  const children = subagents ?? EMPTY_SUBAGENTS;
  const orphans = orphanNotices ?? EMPTY_NOTICES;

  const items = useMemo<RootItem[]>(
    () =>
      [
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
      ),
    [children, flows, orphans],
  );

  // The turn's last committed 说明 is the answer: it stays visible when the
  // process is folded, while its own flow keeps only the summary/groups inside.
  const answerFlow = useMemo(
    () =>
      running
        ? undefined
        : [...flows].reverse().find((flow) => flow.note !== undefined),
    [flows, running],
  );
  const answer = answerFlow?.note;
  const innerFlows = useMemo(
    () => flows.filter((flow) => flow !== answerFlow || flow.steps.length > 0),
    [answerFlow, flows],
  );
  const hasInner =
    innerFlows.length > 0 || children.length > 0 || orphans.length > 0;

  // Abnormal endings and turns without a final 说明 have no readable answer
  // outside the fold; open the process once so the failure/partial output is
  // not hidden behind 已工作. A later manual collapse still wins.
  useEffect(() => {
    if (!running && hasInner && (!answer || failure || aborted)) {
      setProcessOpen(true);
    }
  }, [answer, aborted, failure, hasInner, running]);

  // Only the open flow of a running turn consumes the token overlay; closed
  // flows stay on their committed identity and never re-render per delta.
  const openFlow = useMemo(() => {
    if (!running) return undefined;
    const last = flows[flows.length - 1];
    return last && !isClosed(last) ? last : undefined;
  }, [flows, running]);

  const openIds = openSubagentIds ?? internalOpen;
  const toggleChild = useCallback(
    (sessionId: string) => {
      if (!openSubagentIds) {
        setInternalOpen((prev) => {
          const next = new Set(prev);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        });
      }
      onToggleSubagent?.(sessionId);
    },
    [openSubagentIds, onToggleSubagent],
  );

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
          live={item.flow === openFlow ? live : undefined}
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
          onToggle={toggleChild}
        />
      );
    }
    return <NoticeRow key={`notice:${item.notice.seq}`} notice={item.notice} locale={locale} />;
  };

  return (
    <div data-component="TurnBlock" className="flex flex-col gap-3" data-agent-turn={block.key}>
      {users.map((entry) => (
        <div
          key={entryKey(entry)}
          className="flex scroll-mt-4 flex-col"
          data-agent-user={entry.seq}
        >
          <UserBubble text={entry.text} locale={locale} />
          <MessageMeta at={entry.at} text={entry.text} align="right" locale={locale} />
        </div>
      ))}

      {commands.map((entry) => (
        <CommandRow key={`command:${entry.commandId || entry.seq}`} entry={entry} />
      ))}

      {/* Settled: 已工作 is the process fold. Collapsed it hides every flow,
          sub-agent row and intermediate 说明; the turn's last 说明 stays
          outside, always readable.
          The status and the fold share one wrapper: the Collapse is not a
          direct sibling of the answer, so unmounting it after the close
          animation cannot remove a flex gap and make the answer jump. */}
      {!running && showStatus ? (
        <div className="flex flex-col">
          {hasInner ? (
            <button
              type="button"
              aria-expanded={processOpen}
              title={
                processOpen
                  ? agentLabel("turn.collapse", locale)
                  : agentLabel("turn.expand", locale)
              }
              onClick={() => setProcessOpen((value) => !value)}
              className="group/fold flex w-full min-w-0 items-center gap-1.5 self-start border-b border-border pb-1.5 text-left text-ui-caption text-slate-500 transition-colors hover:text-slate-700"
            >
              <span className="min-w-0 truncate tabular-nums">
                {label
                  ? agentLabel("turn.worked", locale, { duration: label })
                  : agentLabel("turn.workedPlain", locale)}
              </span>
              <ChevronRight
                size={12}
                className={clsx(
                  "shrink-0 text-slate-300 opacity-40 transition-[opacity,transform] group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100",
                  processOpen && "rotate-90 opacity-100",
                )}
              />
            </button>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5 self-start text-ui-caption text-slate-400">
              <span className="truncate tabular-nums">
                {label
                  ? agentLabel("turn.worked", locale, { duration: label })
                  : agentLabel("turn.workedPlain", locale)}
              </span>
            </span>
          )}

          {hasInner ? (
            <Collapse open={processOpen}>
              <div className="flex flex-col gap-3 pt-3">
                {items.map((item) => renderItem(item, true))}
              </div>
            </Collapse>
          ) : null}
        </div>
      ) : running ? (
        items.map((item) => renderItem(item, false))
      ) : null}

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
        <div className="flex items-center gap-2 text-ui-caption text-slate-500">
          <WorkingOrb />
          <span className="shrink-0 tabular-nums">
            {label
              ? agentLabel("turn.working", locale, { duration: label })
              : agentLabel("turn.workingPlain", locale)}
          </span>
        </div>
      ) : null}

      {failure ? (
        <div className="flex items-start gap-2 text-ui-caption text-rose-600">
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
        <div className="text-ui-caption text-slate-400">{agentLabel("turn.aborted", locale)}</div>
      ) : null}
    </div>
  );
}

export const TurnBlock = memo(TurnBlockImpl);

/**
 * Three dots on a rotating ring. A quieter "working" signal than a spinner:
 * the row's text carries the state, the glyph only breathes. Pure CSS so both
 * webviews get it, and it stops under reduced motion.
 */
function WorkingOrb() {
  return (
    <span data-component="WorkingOrb" aria-hidden className="relative size-3 shrink-0">
      <span
        className="absolute inset-0 animate-spin motion-reduce:animate-none"
        style={{ animationDuration: "1.8s" }}
      >
        <span className="absolute left-1/2 top-0 size-1 -translate-x-1/2 rounded-full bg-sky-500/80" />
        <span className="absolute bottom-0 left-0 size-1 rounded-full bg-sky-500/45" />
        <span className="absolute bottom-0 right-0 size-1 rounded-full bg-sky-500/25" />
      </span>
    </span>
  );
}

/**
 * One human slash command and its result. The engine writes `command/run` and
 * `command/done` log-only (no turn, no message), so this is a quiet status row:
 * `/name args`, then the engine's own success or failure text.
 */
const CommandRow = memo(function CommandRow({ entry }: { entry: AgentCommand }) {
  const running = entry.status === "running";
  const failed = entry.status === "error";
  return (
    <div
      data-component="CommandRow"
      data-status={entry.status}
      className="flex min-w-0 items-start gap-1.5 py-0.5 text-ui-caption"
    >
      {running ? (
        <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-slate-400" />
      ) : (
        <Terminal
          size={12}
          className={clsx("mt-0.5 shrink-0", failed ? "text-rose-500" : "text-slate-400")}
        />
      )}
      <span
        className={clsx(
          "shrink-0 select-text font-mono text-ui-xs",
          failed ? "text-rose-600" : "text-slate-600",
        )}
      >
        {`/${entry.name}${entry.args ? ` ${entry.args}` : ""}`}
      </span>
      {entry.text ? (
        <span
          className={clsx(
            "min-w-0 flex-1 whitespace-pre-wrap break-words select-text",
            failed ? "text-rose-600" : "text-slate-500",
          )}
        >
          {entry.text}
        </span>
      ) : null}
    </div>
  );
});

/**
 * A settle notice that matched no `subagent` call: one closing message row,
 * because without a call row there is no root fold to attach it to.
 */
const NoticeRow = memo(function NoticeRow({
  notice,
  locale,
}: {
  notice: AgentNotice;
  locale: AgentLocale;
}) {
  return (
    <div data-component="NoticeRow" className="flex min-w-0 items-start gap-1.5 py-0.5 text-ui-caption">
      <Bot size={12} className="mt-0.5 shrink-0 text-slate-400" />
      <span className="shrink-0 text-slate-500">
        {agentLabel("notice.closing", locale)}:
      </span>
      <span className="min-w-0 flex-1 break-words text-slate-500 select-text">
        {notice.text.trim() !== "" ? notice.text : agentLabel("notice.noClosing", locale)}
      </span>
    </div>
  );
});
