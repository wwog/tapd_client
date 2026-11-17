/**
 * Desktop wrapper around the shared turn block
 * (`apps/shared/agent/TurnBlock.tsx`): injects the desktop locale, the
 * trajectory deep-link and the failed-turn retry action. MessageStream keeps
 * passing `sessionId`; the child-agent data (`subagents` / `renderTurns` /
 * orphan notices) is assembled in `MessageStream` and forwarded here.
 */
import type { ReactNode } from "react";

import { useLocale } from "../lib/i18n";
import { TurnBlock as SharedTurnBlock, type LiveTrace } from "../../../shared/agent/TurnBlock";
import type { AgentSubagentChild } from "../../../shared/agent/SubagentGroup";
import type { AgentNotice } from "../../../shared/agent/types";
import type { TurnBlock as TurnBlockModel } from "./turns";
import { agentActions } from "./store";
import { recordIdOf } from "./trajectory/model";

export type { LiveTrace } from "../../../shared/agent/TurnBlock";

type Props = {
  block: TurnBlockModel;
  running: boolean;
  live?: LiveTrace;
  /** The session this turn belongs to; trace links and retry are addressed to it. */
  sessionId?: string;
  /** Host-assembled children for this turn's `subagent` calls. */
  subagents?: AgentSubagentChild[];
  /** Settled notices that matched no `subagent` call (old logs, orphans). */
  orphanNotices?: AgentNotice[];
  /** Renders one child's transcript (recursion through the shared block). */
  renderTurns?: (child: AgentSubagentChild) => ReactNode;
  /** Controlled child folds, forwarded to the shared group. */
  openSubagentIds?: ReadonlySet<string>;
  /** A child fold toggled; the host lazy-loads the child transcript here. */
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
      onOpenTrace={
        sessionId
          ? (entry) => agentActions.focusTrajectory(sessionId, recordIdOf(entry))
          : undefined
      }
      onRetry={sessionId ? () => agentActions.retryTurn(sessionId) : undefined}
    />
  );
}
