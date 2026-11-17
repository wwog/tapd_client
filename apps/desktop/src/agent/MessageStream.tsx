import { useEffect, useRef } from "react";
import clsx from "clsx";

import { Button, Spinner } from "../components/ui";
import { t } from "../lib/i18n";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { UserBubble } from "./MessageParts";
import { TurnBlock } from "./TurnBlock";
import { groupTurns } from "./turns";
import { agentActions, agentStore, isSessionRunning } from "./store";

/**
 * Committed history plus the live attempt on top, grouped per turn. The page
 * remounts this per session (`key`), which also resets the scroll position.
 * `visible` hides the pane for the team board without unmounting it, so the
 * scroll position and the live overlay survive a trip to the board and back.
 */
export function MessageStream({ visible = true }: { visible?: boolean }) {
  const state = agentStore.use();
  const sessionId = state.selectedId;
  const history = sessionId ? state.entries[sessionId] : undefined;
  const live = sessionId ? state.live[sessionId] : undefined;
  const pending = (sessionId ? state.pendingPrompts[sessionId] : undefined) ?? [];
  const approvals = state.approvals.filter((item) => item.sessionId === sessionId);
  const questions = state.questions.filter((item) => item.sessionId === sessionId);
  const items = history?.items ?? [];

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

  const blocks = groupTurns(items);
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
      blocks.push({ key: activeKey, entries: [] });
    }
  }

  const shown = blocks.filter(
    (block) => block.entries.length > 0 || block.key === activeKey,
  );

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
          return (
            <TurnBlock
              key={block.key}
              block={block}
              running={active}
              live={active ? liveTrace : undefined}
            />
          );
        })}

        {pending.map((text, index) => (
          <UserBubble key={`pending-${index}-${text.length}`} text={text} />
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
