import { useState } from "react";
import { Square } from "lucide-react";

import { Button } from "../components/ui";
import { t } from "../lib/i18n";
import { agentActions, agentStore, isSessionRunning } from "./store";

/**
 * The one entry point that stops a running turn. It reads the session's live
 * status, not the task workflow: a task's workflow leaves `running` after its
 * first turn, while later turns can still be running. Placed above the
 * transcript so free chats (which have no task action bar) are covered too.
 */
export function TurnStop() {
  const state = agentStore.use();
  const sessionId = state.selectedId;
  const [busy, setBusy] = useState(false);

  if (!sessionId || !isSessionRunning(state, sessionId)) return null;

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    await agentActions.cancelTurn(sessionId);
    setBusy(false);
  };

  return (
    <div
      data-testid="agent-turn-stop"
      className="flex shrink-0 items-center justify-end px-5 pt-2"
    >
      <Button
        size="sm"
        icon={<Square size={11} />}
        loading={busy}
        onClick={() => void stop()}
      >
        {t("agent.task.stop")}
      </Button>
    </div>
  );
}
