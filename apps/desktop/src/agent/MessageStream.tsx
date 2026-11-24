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
import { sticksAfterScroll } from "../../../shared/agent/scrollFollow";
import { TurnBlock } from "./TurnBlock";
import { groupTurns } from "./turns";
import { assembleSessionSubagents, isPendingChild } from "./subagents";
import { AGENT_COLUMN } from "./layout";
import { agentActions, agentStore, isSessionRunning } from "./store";

const EMPTY_ITEMS: DshEntry[] = [];

/** Within this many pixels of the end, the tail stays pinned. */
const STICK_DISTANCE = 48;

/**
 * How long a fold the reader toggled owns the scroll position. The height
 * animation adds rows over ~200ms; pinning to the bottom on every frame of it
 * dragged the view off what was just opened, and the next token kept it there.
 */
const FOLD_HOLD_MS = 420;

/** How far up the reader has to be before the arrow is worth showing. */
const AWAY_DISTANCE = 24;

/**
 * Where each session's transcript was left. The pane remounts per session, so
 * the DOM scroll offset cannot survive the switch by itself; remembering the
 * stick state and offset makes "switch away and back" land where the reader
 * was — at the bottom for a followed session, at the same place otherwise.
 */
const scrollMemory = new Map<string, { stick: boolean; top: number }>();

/**
 * Committed history plus the live attempt on top, grouped per turn. The page
 * remounts this per session (`key`), and the module-level memory restores the
 * scroll position the session was left at.
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
  const contentRef = useRef<HTMLDivElement>(null);
  // Restored on mount for a session that was left scrolled away from the tail.
  const savedScrollRef = useRef(
    sessionId ? scrollMemory.get(sessionId) : undefined,
  );
  const stickRef = useRef(savedScrollRef.current?.stick ?? true);
  /** Offset to re-apply while the remount's content is still growing. */
  const restoreTopRef = useRef<number | null>(
    savedScrollRef.current && !savedScrollRef.current.stick
      ? savedScrollRef.current.top
      : null,
  );
  /**
   * Whether the current scroll events come from the reader (wheel, touch,
   * scrollbar, keys) rather than from layout growth or our own positioning.
   * Only reader-driven events may change `stick` by their own position; the
   * fold hold below is the one deliberate exception.
   */
  const userScrollRef = useRef(false);
  /** The reader left the tail on purpose; only the end re-attaches them. */
  const releasedRef = useRef(false);
  const userScrollTimer = useRef<number | undefined>(undefined);
  const markUserScroll = useCallback((ms = 200) => {
    userScrollRef.current = true;
    window.clearTimeout(userScrollTimer.current);
    userScrollTimer.current = window.setTimeout(() => {
      userScrollRef.current = false;
    }, ms);
  }, []);
  useEffect(() => () => window.clearTimeout(userScrollTimer.current), []);

  /** Reader input wins over a pending restore from the session switch. */
  const noteUserScroll = (ms?: number) => {
    restoreTopRef.current = null;
    markUserScroll(ms);
  };

  /**
   * Last offset and height seen, to tell a reader's scroll from the browser
   * clamping the offset because content shrank. Seeded from the live DOM so the
   * first scroll event is not compared against a fake zero-height page.
   */
  const metricsRef = useRef({ top: 0, height: 0 });
  const sampleMetrics = (element: HTMLDivElement) => {
    metricsRef.current = {
      top: element.scrollTop,
      height: element.scrollHeight,
    };
  };
  /** Previous touch Y, so a downward finger drag releases the tail. */
  const touchYRef = useRef<number | null>(null);
  /** Deadline until which a reader-toggled fold owns the scroll position. */
  const foldHoldRef = useRef(0);
  const foldHoldTimer = useRef<number | undefined>(undefined);

  /** Assigns a clamped scroll offset. */
  const positionScroll = (element: HTMLDivElement, top: number) => {
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const target = Math.min(Math.max(0, top), max);
    element.scrollTop = target;
    sampleMetrics(element);
    return target;
  };
  // Floating "jump to latest" affordance: only while the reader is away from
  // the bottom, so the tail can keep streaming without dragging them down.
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  /**
   * Leaves the tail at once, on any upward input.
   *
   * Waiting for the 48px "at the end" threshold meant a small nudge up was
   * still treated as following, so the next token pinned the view back to the
   * bottom and only a large drag escaped. Following resumes when the reader
   * lands back within the threshold or asks for it.
   */
  const releaseTail = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Nothing to leave: the whole transcript fits, so every scroll input is
    // already looking at the tail.
    if (element.scrollTop <= 0 && element.scrollHeight <= element.clientHeight) {
      return;
    }
    stickRef.current = false;
    releasedRef.current = true;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    // A few pixels up is not yet worth an arrow; the scroll handler refines it.
    setAwayFromBottom(distance > AWAY_DISTANCE);
  }, []);

  /** Re-attaches the tail explicitly: a new prompt, or the reader asking. */
  const attachTail = useCallback(() => {
    stickRef.current = true;
    releasedRef.current = false;
    foldHoldRef.current = 0;
    window.clearTimeout(foldHoldTimer.current);
    setAwayFromBottom(false);
  }, []);

  /**
   * Whether a wheel/touch inside the transcript belongs to a nested scroller
   * (tool output, a long diff). That gesture is not about the transcript, so it
   * must not stop the tail-follow.
   */
  const nestedScrollerOwns = (target: EventTarget | null): boolean => {
    const root = scrollRef.current;
    if (!(target instanceof Element) || !root) return false;
    for (
      let node: Element | null = target;
      node && node !== root;
      node = node.parentElement
    ) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight
      ) {
        return true;
      }
    }
    return false;
  };

  /**
   * A fold the reader clicked is a reading action: the tail stands down while
   * its rows land, then follows again only if the fold did not push the bottom
   * away. Collapsing a fold counts too — the clamp must not be mistaken for a
   * reason to jump.
   */
  const holdTailForFold = useCallback(() => {
    foldHoldRef.current = performance.now() + FOLD_HOLD_MS;
    window.clearTimeout(foldHoldTimer.current);
    foldHoldTimer.current = window.setTimeout(() => {
      foldHoldRef.current = 0;
      const element = scrollRef.current;
      if (!element || !stickRef.current) return;
      const distance =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      // The fold settled at the tail: keep following. It pushed the bottom
      // away: leave the reader where the fold opened.
      if (distance < STICK_DISTANCE) return;
      stickRef.current = false;
      releasedRef.current = true;
      setAwayFromBottom(true);
    }, FOLD_HOLD_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(foldHoldTimer.current), []);

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
    if (userStarted || pendingStarted) {
      // A prompt the reader just sent outranks a fold they were reading.
      restoreTopRef.current = null;
      attachTail();
    }

    if (!visible) return;
    const element = scrollRef.current;
    if (!element) return;
    if (stickRef.current) {
      // Let a fold the reader just toggled land before following again.
      if (performance.now() < foldHoldRef.current) return;
      positionScroll(element, element.scrollHeight);
      setAwayFromBottom(false);
      return;
    }
    const top = restoreTopRef.current;
    if (top === null) return;
    const target = positionScroll(element, top);
    if (element.scrollHeight - element.clientHeight >= target - 1) {
      restoreTopRef.current = null;
    }
    setAwayFromBottom(
      element.scrollHeight - target - element.clientHeight > AWAY_DISTANCE,
    );
  }, [lastUserSeq, pending.length, signature, visible]);

  // A remount renders the committed blocks first and their deferred markdown
  // (and images) afterwards, so the height keeps growing after the layout
  // effect above. Follow that growth while the tail is pinned; for a restored
  // offset, re-apply it until the content is tall enough to hold it.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !visible) return;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current;
      if (!element) return;
      if (stickRef.current) {
        // A fold's animation is shaping the height; let it land first.
        if (performance.now() < foldHoldRef.current) return;
        positionScroll(element, element.scrollHeight);
        return;
      }
      // Not following: the growth only changes whether the arrow is worth it.
      const grown = element.scrollHeight - element.scrollTop - element.clientHeight;
      setAwayFromBottom(grown > AWAY_DISTANCE);
      sampleMetrics(element);
      const top = restoreTopRef.current;
      if (top === null) return;
      const target = positionScroll(element, top);
      if (element.scrollHeight - element.clientHeight >= target - 1) {
        restoreTopRef.current = null;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [visible]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!userScrollRef.current) {
      // Layout growth (or our own positioning) moved the offset. Keep following
      // the tail when it was pinned, and keep re-applying a pending restore.
      if (stickRef.current) {
        // A fold's animation owns the offset until it lands.
        if (performance.now() < foldHoldRef.current) return;
        positionScroll(element, element.scrollHeight);
        return;
      }
      const top = restoreTopRef.current;
      if (top === null) {
        sampleMetrics(element);
        return;
      }
      const target = positionScroll(element, top);
      if (element.scrollHeight - element.clientHeight >= target - 1) {
        restoreTopRef.current = null;
      }
      return;
    }
    const top = element.scrollTop;
    const height = element.scrollHeight;
    const previous = metricsRef.current;
    metricsRef.current = { top, height };
    const stuck = sticksAfterScroll(
      previous,
      { top, height },
      element.clientHeight,
      STICK_DISTANCE,
      releasedRef.current,
    );
    stickRef.current = stuck;
    // Landing back at the end is what re-attaches a released reader.
    if (stuck) releasedRef.current = false;
    if (sessionId) {
      scrollMemory.set(sessionId, { stick: stuck, top });
    }
    const distance = height - top - element.clientHeight;
    setAwayFromBottom(!stuck && distance > AWAY_DISTANCE);
  }, [sessionId]);

  // The last position can move without a reader scroll (a prompt jump, a
  // layout clamp), so the definitive copy is taken when the pane unmounts for
  // the next session. A layout-effect cleanup still sees the live DOM.
  useLayoutEffect(() => {
    if (!sessionId) return;
    return () => {
      const element = scrollRef.current;
      if (!element) return;
      scrollMemory.set(sessionId, {
        stick: stickRef.current,
        top: element.scrollTop,
      });
    };
  }, [sessionId]);

  // Seed the follow rule's sample from the live DOM: a switch restores an
  // offset before any scroll event, and comparing against a zero-height page
  // would read the first growth as a clamp (or a reader move).
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) sampleMetrics(element);
  }, [sessionId]);

  // A prompt jump is a positioning action: stop following the tail first so
  // the next streaming delta cannot drag the reader back down.
  const jumpToPrompt = useCallback((item: PromptNavItem) => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = false;
    releasedRef.current = true;
    setAwayFromBottom(true);
    const target =
      element.querySelector<HTMLElement>(`[data-agent-user="${item.seq}"]`) ??
      element.querySelector<HTMLElement>(`[data-agent-turn="${item.key}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // An instant jump, not a smooth one: the bottom-follow pins the tail on the
  // next delta anyway, and a long animation would leave the arrow visible
  // mid-flight. Attaching clears a pending fold hold too, so the reader who
  // asked for the tail is not detached by a timer they never saw.
  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    attachTail();
    positionScroll(element, element.scrollHeight);
  }, [attachTail]);

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
        // Reader input marks the scroll events that follow as intentional; a
        // layout clamp or our own positioning must not flip the tail-follow.
        onWheel={(event) => {
          noteUserScroll();
          // Release at the input, not at the scroll event: a token landing in
          // between used to pin the view back before the nudge was seen.
          if (event.deltaY < 0 && !nestedScrollerOwns(event.target)) {
            releaseTail();
          }
        }}
        onTouchStart={(event) => {
          noteUserScroll(400);
          touchYRef.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          noteUserScroll();
          const y = event.touches[0]?.clientY;
          const last = touchYRef.current;
          if (y === undefined) return;
          // A finger moving down scrolls back through the transcript.
          if (last !== null && y > last + 1 && !nestedScrollerOwns(event.target)) {
            releaseTail();
          }
          touchYRef.current = y;
        }}
        onPointerDown={() => noteUserScroll(400)}
        onPointerMove={(event) => {
          if (event.buttons) noteUserScroll();
        }}
        onKeyDown={(event) => {
          const target = event.target;
          // A caret key inside a card's field is not a scroll: the transcript
          // must keep following while the reader edits an answer.
          if (
            target instanceof HTMLElement &&
            (target.isContentEditable ||
              target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.tagName === "SELECT")
          ) {
            return;
          }
          noteUserScroll(300);
          if (
            (event.key === "ArrowUp" ||
              event.key === "PageUp" ||
              event.key === "Home") &&
            !nestedScrollerOwns(target)
          ) {
            releaseTail();
          }
          // A fold's chevron turns Enter/Space into a click, which the capture
          // handler below turns into the hold; no second entry point here.
        }}
        // Every fold in the transcript is an `aria-expanded` control. Toggling
        // one is the reader choosing what to look at, so the tail stands down
        // for the length of the height animation instead of pinning the view.
        onClickCapture={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest("[aria-expanded]")) {
            holdTailForFold();
          }
        }}
        // The transcript owns its own bottom-follow. Leaving the browser's
        // scroll anchoring on made a fold's height animation drag the scroll
        // position with it, which reads as a stutter/jump under the pointer.
        style={{ overflowAnchor: "none" }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4"
      >
        <div
          ref={contentRef}
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

          {pending.map((item, index) => (
            <div
              key={`pending-${index}-${item.text.length}-${item.images?.length ?? 0}`}
              className="flex flex-col items-end gap-1"
            >
              <UserBubble
                text={item.text}
                images={item.images?.map((image) => ({
                  mediaType: image.mediaType,
                  ...(image.name ? { name: image.name } : {}),
                  src: image.src,
                }))}
                locale={locale}
              />
              {/* 「立即」 waits for the running turn's next step; behind a long
                  tool call that is not instant, so the bubble says so. */}
              {item.steer ? (
                <span className="pr-1 text-ui-2xs text-slate-400">
                  {t("agent.queue.steeringPending")}
                </span>
              ) : null}
            </div>
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
