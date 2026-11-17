import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

import { Button, Spinner } from "../components/ui";
import { t, useLocale } from "../lib/i18n";
import { TodoCard } from "../../../shared/agent/TodoCard";
import { TurnBlock as ChildTurnBlock } from "../../../shared/agent/TurnBlock";
import type { AgentNotice } from "../../../shared/agent/types";
import type { AgentSubagentChild } from "../../../shared/agent/SubagentGroup";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { UserBubble } from "./MessageParts";
import { TurnBlock } from "./TurnBlock";
import { groupTurns } from "./turns";
import { assembleSessionSubagents, isPendingChild } from "./subagents";
import { agentActions, agentStore, isSessionRunning } from "./store";

/**
 * Committed history plus the live attempt on top, grouped per turn. The page
 * remounts this per session (`key`), which also resets the scroll position.
 * `visible` hides the pane for the team board without unmounting it, so the
 * scroll position and the live overlay survive a trip to the board and back.
 *
 * The session todo card sits above the turns (session-level state, no turn),
 * and each turn's `subagent` calls render as the shared sub-agent fold with
 * child transcripts assembled in `subagents.ts`.
 */
export function MessageStream({ visible = true }: { visible?: boolean }) {
  const state = agentStore.use();
  const locale = useLocale();
  const sessionId = state.selectedId;
  const history = sessionId ? state.entries[sessionId] : undefined;
  const live = sessionId ? state.live[sessionId] : undefined;
  const session = sessionId ? state.sessions[sessionId] : undefined;
  const pending = (sessionId ? state.pendingPrompts[sessionId] : undefined) ?? [];
  const approvals = state.approvals.filter((item) => item.sessionId === sessionId);
  const questions = state.questions.filter((item) => item.sessionId === sessionId);
  const items = history?.items ?? [];
  const todos = session?.todos ?? [];

  const committedCalls = new Set(
    items.flatMap((entry) => (entry.kind === "tool" ? [entry.callId] : [])),
  );
  const liveTools = (live?.tools ?? []).filter(
    (tool) => !tool.callId || !committedCalls.has(tool.callId),
  );
  const liveHasContent = Boolean(live?.text || live?.reasoning) || liveTools.length > 0;
  // Only in-flight calls reach the turn: the store already drops a call when
  // its row commits, and this filter also covers deltas that never carried a
  // callId. Passing the raw overlay painted every call twice.
  const liveTrace = live
    ? { text: live.text, reasoning: live.reasoning, tools: liveTools }
    : undefined;

  // Grouping is memoized on the committed rows: the live overlay re-renders
  // per token, and the sub-agent assembly below must not re-group child
  // transcripts per token (the shared assembler caches per transcript
  // identity, but re-splitting the parent stays per render).
  const blocks = useMemo(() => groupTurns(items), [items]);
  const running = isSessionRunning(state, sessionId);

  // The live stream belongs to the turn whose `turn/end` has not landed yet;
  // before its `turn/start` commits, a synthetic block keeps the text visible.
  let activeKey: string | null = null;
  if (running) {
    const last = blocks[blocks.length - 1];
    if (last && last.start && !last.end) {
      activeKey = last.key;
    } else if (liveHasContent) {
      activeKey = "live";
    }
  }
  const assembledBlocks =
    activeKey === "live" ? [...blocks, { key: activeKey, entries: [] }] : blocks;

  const shown = assembledBlocks.filter(
    (block) =>
      block.entries.length > 0 ||
      block.key === activeKey ||
      // A retry has no prompt of its own (the engine records an empty message),
      // so a second failure would otherwise have no row to show its reason on.
      block.end?.reason === "error" ||
      block.end?.reason === "blocked",
  );

  // Sub-agent data per turn: calls paired with settle notices ACROSS the whole
  // transcript (a background child settles in a later turn than its call),
  // transcripts from the child buckets, live calls as running placeholders in
  // the active block only.
  const subagentGroups = useMemo(
    () => assembleSessionSubagents(state, assembledBlocks, liveTools, activeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assembledBlocks, liveTools, activeKey, state.sessions, state.entries],
  );

  // Which child folds are open (controlled, so a toggle can trigger the
  // transcript fetch before the shared group renders the child).
  const [openChildren, setOpenChildren] = useState<ReadonlySet<string>>(new Set());

  const toggleChild = (childSessionId: string) => {
    setOpenChildren((prev) => {
      const next = new Set(prev);
      if (next.has(childSessionId)) next.delete(childSessionId);
      else next.add(childSessionId);
      return next;
    });
    // Opening a child fetches its transcript once; rows that already streamed
    // are merged under the fetched history, and pending placeholders have no
    // session to read at all.
    const opening = !openChildren.has(childSessionId);
    if (opening && !isPendingChild(childSessionId)) {
      agentActions.refreshEntries(childSessionId);
    }
  };

  /** One child's transcript, rendered with the same shared turn block (no
   *  trajectory deep-link: the panel shows the current session only). Nested
   *  sub-agent calls inside a child assemble the same way, so the fold reads
   *  identically at every depth. */
  const renderChildTurns = (child: AgentSubagentChild) => {
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
    const nestedGroups = assembleSessionSubagents(state, childBlocks, [], null);
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
              openIds={openChildren}
              onToggle={toggleChild}
            />
          );
        })}
      </div>
    );
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const signature = [
    items.length,
    live?.text.length ?? 0,
    live?.reasoning.length ?? 0,
    liveTools.length,
    pending.length,
    approvals.length,
    questions.length,
    JSON.stringify(todos),
  ].join(":");

  useEffect(() => {
    if (!visible) return;
    const element = scrollRef.current;
    if (!element || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [signature, visible]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickRef.current = distance < 48;
  };

  if (!sessionId) {
    return (
      <div
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
    questions.length > 0;

  const loading = history ? !history.loaded && items.length === 0 : true;
  const failed = Boolean(history?.error) && items.length === 0;
  const quiet = !hasContent && !loading && !failed;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={clsx(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4",
        !visible && "hidden",
      )}
    >
      <div
        className={clsx(
          "mx-auto flex w-full max-w-3xl flex-col gap-3",
          (quiet || loading || failed) && "min-h-full justify-center",
        )}
      >
        {todos.length > 0 ? <TodoCard todos={todos} locale={locale} /> : null}

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
      </div>
    </div>
  );
}

/**
 * One turn inside a child transcript. Nested `subagent` calls assemble exactly
 * like the top level — the shared turn block routes the rows into the agents
 * group and the caller feeds it the same store-backed data, so the fold reads
 * the same at every depth (companion parity).
 */
function NestedTurnBlock({
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
  subagents?: AgentSubagentChild[];
  orphanNotices?: AgentNotice[];
  renderTurns: (child: AgentSubagentChild) => ReactNode;
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
}
