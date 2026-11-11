import { useEffect, useMemo, useState } from "react";

import {
  agentBugKey,
  externalClaimMap,
  inFlightAgentTasks,
} from "../lib/agent";
import { DEV_SIM, devSimClaim, devSimTask, useDevSim } from "../lib/devSim";
import {
  acquireAgentTasksStore,
  useAgentTasksStore,
} from "../lib/agentStore";

/**
 * Agent queue snapshot shared across the app: the pending-review badge, the
 * in-flight map used to disable/redirect enqueue actions, external AI claims,
 * and the raw state.
 */
export function useAgentQueue() {
  const agentState = useAgentTasksStore();
  const devSim = useDevSim();

  useEffect(() => acquireAgentTasksStore(), []);

  const pendingReviews =
    agentState?.awaitingApprovalCount ??
    agentState?.tasks.filter((task) => task.status === "awaiting_approval").length ??
    0;

  const agentTasks = useMemo(() => agentState?.tasks ?? [], [agentState]);

  // Claims expire 15 minutes after the last heartbeat. The backend only emits
  // state on changes, so re-evaluate freshness on a slow tick as well.
  const storedClaims = useMemo(
    () => agentState?.externalClaims ?? [],
    [agentState],
  );
  const hasClaims = storedClaims.length > 0;
  const [claimNow, setClaimNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasClaims) return;
    setClaimNow(Date.now());
    const timer = window.setInterval(() => setClaimNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasClaims]);
  const agentInFlight = useMemo(() => {
    const map = inFlightAgentTasks(agentTasks);
    if (!DEV_SIM) return map;

    // Development-only overlay from the bug row's context menu.
    for (const entry of Object.values(devSim)) {
      const key = agentBugKey(entry.workspaceId, entry.bugId);
      if (entry.kind === "agent-queued") {
        map.set(key, { task: devSimTask(entry), position: 1 });
      } else if (entry.kind === "agent-running") {
        map.set(key, { task: devSimTask(entry), position: null });
      } else {
        map.delete(key);
      }
    }
    return map;
  }, [agentTasks, devSim]);

  const externalClaims = useMemo(() => {
    const map = externalClaimMap(storedClaims, claimNow);
    if (!DEV_SIM) return map;

    for (const entry of Object.values(devSim)) {
      const key = agentBugKey(entry.workspaceId, entry.bugId);
      if (entry.kind === "external-queued" || entry.kind === "external-running") {
        map.set(key, devSimClaim(entry));
      } else {
        map.delete(key);
      }
    }
    return map;
  }, [storedClaims, claimNow, devSim]);

  return { agentState, pendingReviews, agentInFlight, externalClaims };
}
