import { useEffect, useState, useSyncExternalStore } from "react";

import { agentStore } from "../agent/store";
import { api } from "../lib/api";
import { dshTaskApi } from "../lib/dsh";
import { OpenWithButton } from "./OpenWithButton";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * "打开" for the Agent tab: the focused session's working directory, resolved by
 * the host (worktree → project repo → chat scratch dir). Hidden while no session
 * is selected or the directory is gone, so the strip never offers a dead path.
 */
export function AgentOpenButton({ toast }: Props) {
  // Two primitives keep the button out of the per-token churn: the agent state
  // changes on every stream frame, but only these two values matter here.
  const sessionId = useSyncExternalStore(
    agentStore.subscribe,
    () => agentStore.get().selectedId,
  );
  const worktreePath = useSyncExternalStore(
    agentStore.subscribe,
    () =>
      agentStore
        .get()
        .tasks?.find((task) => task.id === sessionId)?.worktreePath ?? "",
  );
  const [dir, setDir] = useState<{ path: string; exists: boolean } | null>(null);

  useEffect(() => {
    setDir(null);
    if (!sessionId) return;
    let cancelled = false;
    void dshTaskApi
      .sessionDir(sessionId)
      .then((next) => {
        if (!cancelled) setDir(next);
      })
      .catch(() => {
        // A directory we cannot resolve is simply not offered.
      });
    return () => {
      cancelled = true;
    };
    // A worktree toggled on/off changes the answer without changing sessions.
  }, [sessionId, worktreePath]);

  if (!dir?.exists) return null;

  return (
    <OpenWithButton
      kind="directory"
      path={dir.path}
      onOpen={(target) => api.openDirectory(dir.path, target)}
      onError={(message) => toast("error", message)}
    />
  );
}
