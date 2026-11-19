import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import type {
  DshApprovalEvent,
  DshEntryEvent,
  DshErrorEvent,
  DshFocusSessionEvent,
  DshQuestionEvent,
  DshSessionEvent,
  DshSessionsEvent,
  DshSettledEvent,
  DshStatus,
  DshTasksEvent,
  DshTeamEvent,
} from "../lib/dsh";
import { agentActions, agentEvents } from "./store";

/**
 * The runtime channels outlive the page: an approval or question that arrives
 * while the user is on another page must still reach the store, otherwise the
 * turn waits forever with no card to answer. Registered once per app session;
 * the flag also absorbs React StrictMode's double effect.
 */
let listening = false;

function subscribeAgentEvents(): void {
  if (listening) return;
  listening = true;

  const subscribe = <T,>(event: string, handler: (payload: T) => void) => {
    void listen<T>(event, (payload) => handler(payload.payload)).catch(() => {
      listening = false;
    });
  };

  subscribe<DshStatus>("dsh://status", agentEvents.status);
  subscribe<DshEntryEvent>("dsh://entry", agentEvents.entry);
  subscribe<DshSessionEvent>("dsh://stream", agentEvents.stream);
  subscribe<DshApprovalEvent>("dsh://approval", agentEvents.approval);
  subscribe<DshQuestionEvent>("dsh://question", agentEvents.question);
  subscribe<DshSettledEvent>("dsh://request-settled", agentEvents.settled);
  subscribe<DshTasksEvent>("dsh://tasks", agentEvents.tasks);
  subscribe<DshSessionsEvent>("dsh://sessions", agentEvents.sessions);
  subscribe<DshTeamEvent>("dsh://team", agentEvents.team);
  subscribe<DshFocusSessionEvent>("dsh://focus-session", agentEvents.focusSession);
  subscribe<DshErrorEvent>("dsh://error", agentEvents.error);
}

/**
 * Binds the Agent page to the runtime: one bootstrap fetch and the persistent
 * event channels. Mounting the page again refetches status and the selected
 * history, which is also how a missed event gets reconciled.
 */
export function useAgentRuntime(): void {
  useEffect(() => {
    subscribeAgentEvents();
    void agentActions.bootstrap();
  }, []);
}
