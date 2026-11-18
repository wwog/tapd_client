/**
 * Desktop wrapper around the shared turn block
 * (`apps/shared/agent/TurnBlock.tsx`): injects the desktop locale and the
 * failed-turn retry action. MessageStream keeps passing `sessionId`; the child
 * agent rows (`subagents` / `renderTurns`) are assembled in `MessageStream`
 * and forwarded here.
 */
import type { ReactNode } from "react";

import { useLocale } from "../lib/i18n";
import { TurnBlock as SharedTurnBlock, type LiveTrace } from "../../../shared/agent/TurnBlock";
import type { AgentSubagentRow } from "../../../shared/agent/subagents";
import type { AgentNotice } from "../../../shared/agent/types";
import type { TurnBlock as TurnBlockModel } from "./turns";
import { agentActions } from "./store";

export type { LiveTrace } from "../../../shared/agent/TurnBlock";

type Props = {
  block: TurnBlockModel;
  running: boolean;
  live?: LiveTrace;
  /** The session this turn belongs to; retry is addressed to it. */
  sessionId?: string;
  /** Root-level sub-agent rows for this turn. */
  subagents?: AgentSubagentRow[];
  /** Settled notices that matched no `subagent` call (old logs, orphans). */
  orphanNotices?: AgentNotice[];
  /** Renders one child's transcript (recursion through the shared block). */
  renderTurns?: (child: AgentSubagentRow) => ReactNode;
  /** Controlled child folds, forwarded to the root rows. */
  openSubagentIds?: ReadonlySet<string>;
  /** A root fold toggled; the host lazy-loads the child transcript here. */
  onToggleSubagent?: (sessionId: string) => void;
};

export function TurnBlock({
  block,
  running,
  live,
  sessionId,
  subagents,
  orphanNotices,
  renderTurns,
  openSubagentIds,
  onToggleSubagent,
}: Props) {
  const locale = useLocale();
  return (
    <SharedTurnBlock
      block={block}
      running={running}
      live={live}
      locale={locale}
      subagents={subagents}
      orphanNotices={orphanNotices}
      renderTurns={renderTurns}
      openSubagentIds={openSubagentIds}
      onToggleSubagent={onToggleSubagent}
      onRetry={sessionId ? () => agentActions.retryTurn(sessionId) : undefined}
    />
  );
}
