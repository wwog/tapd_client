import { useEffect, useMemo } from "react";

import { agentBugKey, inFlightAgentTasks } from "../lib/agent";
import { DEV_SIM, devSimTask, useDevSim } from "../lib/devSim";
import {
  acquireAgentTasksStore,
  useAgentTasksStore,
} from "../lib/agentStore";

/**
 * Agent queue snapshot shared across the app: the pending-review badge, the
 * in-flight map used to disable/redirect enqueue actions, and the raw state.
 */
export function useAgentQueue() {
  const agentState = useAgentTasksStore();
  const devSim = useDevSim();

  useEffect(() => acquireAgentTasksStore(), []);

  // 待审核与待合并都等用户决定，共用一个入口标记。
  const pendingReviews =
    (agentState?.awaitingApprovalCount ??
      agentState?.tasks.filter((task) => task.status === "awaiting_approval")
        .length ??
      0) +
    (agentState?.awaitingMergeCount ??
      agentState?.tasks.filter((task) => task.status === "awaiting_merge").length ??
      0);

  const agentTasks = useMemo(() => agentState?.tasks ?? [], [agentState]);

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

  return { agentState, pendingReviews, agentInFlight };
}
