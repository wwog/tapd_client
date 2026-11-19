import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { ArrowDown } from "lucide-react";

import { Button, Spinner } from "../components/ui";
import { t, useLocale } from "../lib/i18n";
import { isSubagentTool } from "../../../shared/agent/actions";
import { TurnBlock as ChildTurnBlock } from "../../../shared/agent/TurnBlock";
import type { AgentNotice, AgentTurnBlock } from "../../../shared/agent/types";
import type { AgentSubagentRow } from "../../../shared/agent/subagents";
import type { DshEntry } from "../lib/dsh";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { TaskDoneCard } from "./TaskDoneCard";
import { UserBubble } from "./MessageParts";
import { PromptNavigator } from "./PromptNavigator";
import { buildPromptItems, type PromptNavItem } from "./promptNav";
import { TurnBlock } from "./TurnBlock";
import { groupTurns } from "./turns";
import { assembleSessionSubagents, isPendingChild } from "./subagents";
import { AGENT_COLUMN } from "./layout";
import { agentActions, agentStore, isSessionRunning } from "./store";

const EMPTY_ITEMS: DshEntry[] = [];

/**
 * Committed history plus the live attempt on top, grouped per turn. The page
 * remounts this per session (`key`), which also resets the scroll position.
 * `visible` hides the pane for the team board without unmounting it, so the
 * scroll position and the live overlay survive a trip to the board and back.
 *
 * Streaming re-renders this component per delta, but every projection below is
 * memoized on its real input and every settled turn gets the same props, so
 * the per-token cost is the live tail instead of the whole transcript.
 *
 * Each turn's `subagent` calls render as the shared sub-agent fold with child
 * transcripts assembled in `subagents.ts`. The session todo card is not here:
 * it floats in the tab row's attention corner (`AgentWorkspace` → `StreamHud`).
 */
export function MessageStream({ visible = true }: { visible?: boolean }) {
  const state = agentStore.use();
  const locale = useLocale();
  const sessionId = state.selectedId;
  const history = sessionId ? state.entries[sessionId] : undefined;
  const live = sessionId ? state.live[sessionId] : undefined;
  const pending = (sessionId ? state.pendingPrompts[sessionId] : undefined) ?? [];
  const approvals = state.approvals.filter((item) => item.sessionId === sessionId);
  const questions = state.questions.filter((item) => item.sessionId === sessionId);
  const items = history?.items ?? EMPTY_ITEMS;

  const committedCalls = useMemo(
    () =>
      new Set(
        items.flatMap((entry) =>
          entry.kind === "tool" && entry.callId ? [entry.callId] : [],
        ),
      ),
    [items],
  );
  const rawLiveTools = live?.tools;
  // Only in-flight calls reach the turn: the store already drops a call when
  // its row commits, and this filter also covers deltas that never carried a
  // callId. Passing the raw overlay painted every call twice.
  const liveTools = useMemo(
    () =>
      rawLiveTools
        ? rawLiveTools.filter(
            (tool) => !tool.callId || !committedCalls.has(tool.callId),
          )
        : [],
    [rawLiveTools, committedCalls],
  );
  const liveText = live?.text ?? "";
  const liveReasoning = live?.reasoning ?? "";
  const hasLive = live !== undefined;
  const liveHasContent = Boolean(liveText || liveReasoning) || liveTools.length > 0;
  // Sub-agent assembly only cares about live `subagent` calls, but a shell
  // tool streams its arguments per delta. Keep the previous array when those
  // arguments did not change, so the O(transcript) assembly below is not
  // re-run for every command character.
  const liveSubagentToolsRef = useRef<typeof liveTools>([]);
  const liveSubagentTools = useMemo(() => {
    const next = liveTools.filter((tool) => isSubagentTool(tool.name));
    const previous = liveSubagentToolsRef.current;
    const unchanged =
      next.length === previous.length &&
      next.every((tool, index) => {
        const before = previous[index];
        return (
          before !== undefined &&
          before.callId === tool.callId &&
          before.args === tool.args
        );
      });
    if (unchanged) return previous;
    liveSubagentToolsRef.current = next;
    return next;
  }, [liveTools]);
  // Rebuilt when text/reasoning or the tool list changes. The tool list keeps
  // its reference while only text grows, so sub-agent assembly is not
  // invalidated by every token.
  const liveTrace = useMemo(
    () =>
      hasLive
        ? { text: liveText, reasoning: liveReasoning, tools: liveTools }
        : undefined,
    [hasLive, liveReasoning, liveText, liveTools],
  );

  // Grouping is memoized on the committed rows: the live overlay re-renders
  // per token and must not re-split the transcript.
  const blocks = useMemo(() => groupTurns(items), [items]);
  const promptItems = useMemo(() => buildPromptItems(blocks, locale), [blocks, locale]);
  const running = isSessionRunning(state, sessionId);

  // The finished round's receipt, appended after the last turn: only a task
  // that actually produced a commit or a merge has something to receipt.
  const task = sessionId
    ? (state.tasks?.find((item) => item.id === sessionId) ?? null)
    : null;
  const receipt =
    task &&
    task.kind !== "chat" &&
    task.workflow === "done" &&
    !running &&
    (task.git.commit || task.git.merge)
      ? task
      : null;

  // The live stream belongs to the turn whose `turn/end` has not landed yet;
  // before its `turn/start` commits, a synthetic block keeps the text visible.
  const activeKey = useMemo(() => {
    if (!running) return null;
    const last = blocks[blocks.length - 1];
    if (last && last.start && !last.end) return last.key;
    return liveHasContent ? "live" : null;
  }, [blocks, liveHasContent, running]);
  const assembledBlocks: AgentTurnBlock[] = useMemo(
    () => (activeKey === "live" ? [...blocks, { key: activeKey, entries: [] }] : blocks),
    [activeKey, blocks],
  );
  const shown = useMemo(
    () =>
      assembledBlocks.filter(
        (block) =>
          block.entries.length > 0 ||
          block.key === activeKey ||
          // A retry has no prompt of its own (the engine records an empty
          // message), so a second failure would otherwise have no row to show
          // its reason on.
          block.end?.reason === "error" ||
          block.end?.reason === "blocked",
      ),
    [activeKey, assembledBlocks],
  );

  // Sub-agent data per turn: calls paired with settle notices ACROSS the whole
  // transcript (a background child settles in a later turn than its call),
  // transcripts from the child buckets, live calls as running placeholders in
  // the active block only.
  const subagentGroups = useMemo(
    () => assembleSessionSubagents(state, assembledBlocks, liveSubagentTools, activeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assembledBlocks, liveSubagentTools, activeKey, state.sessions, state.entries],
  );

  // Which child folds are open (controlled, so a toggle can trigger the
  // transcript fetch before the shared group renders the child).
  const [openChildren, setOpenChildren] = useState<ReadonlySet<string>>(new Set());

  // Ref cells keep the callbacks below identity-stable while they still read
  // the latest render's data. A stable callback is what lets every settled
  // `TurnBlock` memo-bail during streaming.
  const stateRef = useRef(state);
  stateRef.current = state;
  const openChildrenRef = useRef(openChildren);
  openChildrenRef.current = openChildren;

  const toggleChild = useCallback((childSessionId: string) => {
    const opening = !openChildrenRef.current.has(childSessionId);
    setOpenChildren((prev) => {
      const next = new Set(prev);
      if (next.has(childSessionId)) next.delete(childSessionId);
      else next.add(childSessionId);
      return next;
    });
    // Opening a child fetches its transcript once; rows that already streamed
    // are merged under the fetched history, and pending placeholders have no
    // session to read at all.
    if (opening && !isPendingChild(childSessionId)) {
      agentActions.refreshEntries(childSessionId);
    }
  }, []);

  // An open child has no token stream of its own: while it is still running,
  // pull its log so the fold grows instead of freezing on the first fetch.
  const openRunningKey = useMemo(() => {
    const ids = new Set<string>();
    for (const group of subagentGroups.values()) {
      for (const child of group.children) {
        if (
          child.running &&
          !isPendingChild(child.sessionId) &&
          openChildren.has(child.sessionId)
        ) {
          ids.add(child.sessionId);
        }
      }
    }
    return [...ids].join(",");
  }, [openChildren, subagentGroups]);
  useEffect(() => {
    if (!openRunningKey) return;
    const ids = openRunningKey.split(",");
    const timer = window.setInterval(() => {
      for (const id of ids) void agentActions.refreshEntries(id);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [openRunningKey]);

  /** One child's transcript, rendered with the same shared turn block (no
   *  trajectory deep-link: the panel shows the current session only). Nested
   *  sub-agent calls inside a child assemble the same way, so the fold reads
   *  identically at every depth. */
  const renderChildTurnsRef = useRef<(child: AgentSubagentRow) => ReactNode>(() => null);
  const renderChildTurns = useCallback(
    (child: AgentSubagentRow) => renderChildTurnsRef.current(child),
    [],
  );
  renderChildTurnsRef.current = (child: AgentSubagentRow) => {
    if (isPendingChild(child.sessionId)) return null;
    const childBlocks = child.turns.filter(
      (block) =>
        block.entries.length > 0 ||
        block.end?.reason === "error" ||
        block.end?.reason === "blocked",
    );
    let childActiveKey: string | null = null;
    if (child.running) {
      const last = childBlocks[childBlocks.length - 1];
      if (last && last.start && !last.end) childActiveKey = last.key;
    }
    // Same cross-turn pairing as the top level. Live calls of a nested child
    // are not tracked (children have no token-level stream); committed rows
    // assemble fine, which is all a settled child shows.
    const nestedGroups = assembleSessionSubagents(stateRef.current, childBlocks, [], null);
    return (
      <div className="flex flex-col gap-3">
        {childBlocks.map((block) => {
          const nested = nestedGroups.get(block.key) ?? { children: [], orphans: [] };
          return (
            <NestedTurnBlock
              key={block.key}
              block={block}
              running={block.key === childActiveKey}
              locale={locale}
              subagents={nested.children}
              orphanNotices={nested.orphans}
              renderTurns={renderChildTurns}
              openIds={openChildrenRef.current}
              onToggle={toggleChild}
            />
          );
        })}
      </div>
    );
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Floating "jump to latest" affordance: only while the reader is away from
  // the bottom, so the tail can keep streaming without dragging them down.
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  const lastUserSeq = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const entry = items[index];
      if (entry?.kind === "user") return entry.seq;
    }
    return -1;
  }, [items]);
  // A newly sent prompt always brings the reader back to the live tail, even
  // if they had scrolled up: the reply they just asked for must be visible.
  const lastUserSeqRef = useRef<number | null>(null);
  const pendingLengthRef = useRef(pending.length);

  const receiptKey = receipt
    ? `${receipt.updatedAt}:${receipt.git.merge ?? receipt.git.commit ?? ""}`
    : "";

  const signature = useMemo(
    () =>
      [
        items.length,
        lastUserSeq,
        liveText.length,
        liveReasoning.length,
        liveTools.length,
        pending.length,
        approvals.length,
        questions.length,
        receiptKey,
      ].join(":"),
    [
      approvals.length,
      items.length,
      lastUserSeq,
      liveReasoning.length,
      liveText.length,
      liveTools.length,
      pending.length,
      questions.length,
      receiptKey,
    ],
  );

  // Layout effect: the viewport is at its new bottom before the frame paints,
  // so streaming does not show a one-frame jump. The scroll position never
  // overrides a reader who scrolled away, except when they send a new prompt.
  useLayoutEffect(() => {
    const userStarted =
      lastUserSeqRef.current !== null && lastUserSeq !== lastUserSeqRef.current;
    const pendingStarted = pending.length > pendingLengthRef.current;
    lastUserSeqRef.current = lastUserSeq;
    pendingLengthRef.current = pending.length;
    if (userStarted || pendingStarted) stickRef.current = true;

    if (!visible) return;
    const element = scrollRef.current;
    if (!element || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
    setAwayFromBottom(false);
  }, [lastUserSeq, pending.length, signature, visible]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const stuck = distance < 48;
    stickRef.current = stuck;
    setAwayFromBottom(!stuck);
  }, []);

  // A prompt jump is a positioning action: stop following the tail first so
  // the next streaming delta cannot drag the reader back down.
  const jumpToPrompt = useCallback((item: PromptNavItem) => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = false;
    setAwayFromBottom(true);
    const target =
      element.querySelector<HTMLElement>(`[data-agent-user="${item.seq}"]`) ??
      element.querySelector<HTMLElement>(`[data-agent-turn="${item.key}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // An instant jump, not a smooth one: the bottom-follow pins the tail on the
  // next delta anyway, and a long animation would leave the arrow visible
  // mid-flight.
  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = true;
    setAwayFromBottom(false);
    element.scrollTop = element.scrollHeight;
  }, []);

  if (!sessionId) {
    return (
      <div
        data-component="MessageStream"
        className={clsx(
          "grid min-h-0 flex-1 place-items-center px-6 text-ui-caption text-slate-400",
          !visible && "hidden",
        )}
        title={t("agent.stream.noSessionHint")}
      >
        {t("agent.stream.noSession")}
      </div>
    );
  }

  const hasContent =
    items.length > 0 ||
    pending.length > 0 ||
    liveHasContent ||
    approvals.length > 0 ||
    questions.length > 0 ||
    receipt !== null;

  const loading = history ? !history.loaded && items.length === 0 : true;
  const failed = Boolean(history?.error) && items.length === 0;
  const quiet = !hasContent && !loading && !failed;

  return (
    <div
      data-component="MessageStream"
      className={clsx(
        "@container relative flex min-h-0 flex-1 flex-col",
        !visible && "hidden",
      )}
    >
      <PromptNavigator
        items={promptItems}
        currentKey={promptItems[0]?.key}
        onJump={jumpToPrompt}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // The transcript owns its own bottom-follow. Leaving the browser's
        // scroll anchoring on made a fold's height animation drag the scroll
        // position with it, which reads as a stutter/jump under the pointer.
        style={{ overflowAnchor: "none" }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4"
      >
        <div
          className={clsx(
            "flex flex-col gap-5",
            AGENT_COLUMN,
            (quiet || loading || failed) && "min-h-full justify-center",
          )}
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-ui-caption text-slate-400">
              <Spinner />
              {t("common.loading")}
            </div>
          ) : failed ? (
            <div className="flex items-center justify-center gap-3 py-8 text-ui-caption text-slate-400">
              <span className="min-w-0 truncate" title={history?.error ?? undefined}>
                {t("agent.stream.loadFailed")}
              </span>
              <Button size="sm" onClick={() => agentActions.refreshEntries(sessionId)}>
                {t("common.retry")}
              </Button>
            </div>
          ) : !hasContent ? (
            <div
              className="grid place-items-center py-8 text-ui-caption text-slate-400"
              title={t("agent.stream.emptyHint")}
            >
              {t("agent.stream.empty")}
            </div>
          ) : null}

          {shown.map((block) => {
            const active = block.key === activeKey;
            const subagents = subagentGroups.get(block.key);
            return (
              <TurnBlock
                key={block.key}
                block={block}
                running={active}
                live={active ? liveTrace : undefined}
                sessionId={sessionId ?? undefined}
                subagents={subagents?.children}
                orphanNotices={subagents?.orphans}
                renderTurns={renderChildTurns}
                openSubagentIds={openChildren}
                onToggleSubagent={toggleChild}
              />
            );
          })}

          {pending.map((text, index) => (
            <UserBubble key={`pending-${index}-${text.length}`} text={text} locale={locale} />
          ))}

          {approvals.map((approval) => (
            <ApprovalCard key={approval.rpcId} approval={approval} />
          ))}

          {questions.map((question) => (
            <QuestionCard key={question.rpcId} pending={question} />
          ))}

          {receipt ? <TaskDoneCard key={`done:${receipt.id}`} task={receipt} /> : null}
        </div>
      </div>

      {awayFromBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={jumpToLatest}
            title={t("agent.stream.jumpToLatest")}
            aria-label={t("agent.stream.jumpToLatest")}
            className="pointer-events-auto grid h-8 w-8 place-items-center rounded-full border border-border bg-surface text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-sky-200"
          >
            <ArrowDown size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One turn inside a child transcript. Nested `subagent` calls assemble exactly
 * like the top level — the shared turn block routes the rows into the agents
 * group and the caller feeds it the same store-backed data, so the fold reads
 * the same at every depth (companion parity).
 */
const NestedTurnBlock = memo(function NestedTurnBlock({
  block,
  running,
  locale,
  subagents,
  orphanNotices,
  renderTurns,
  openIds,
  onToggle,
}: {
  block: ReturnType<typeof groupTurns>[number];
  running: boolean;
  locale: ReturnType<typeof useLocale>;
  /** Store-backed nested assembly for this child turn. */
  subagents?: AgentSubagentRow[];
  orphanNotices?: AgentNotice[];
  renderTurns: (child: AgentSubagentRow) => ReactNode;
  openIds: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
}) {
  return (
    <ChildTurnBlock
      block={block}
      running={running}
      locale={locale}
      subagents={subagents}
      orphanNotices={orphanNotices}
      renderTurns={renderTurns}
      openSubagentIds={openIds}
      onToggleSubagent={onToggle}
    />
  );
});
