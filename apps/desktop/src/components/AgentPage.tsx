import { AgentWorkspace } from "../agent/AgentWorkspace";
import { useAgentRuntime } from "../agent/useAgentRuntime";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Host for the Agent page: owns the runtime subscription, everything else lives
 * under `src/agent/`.
 */
export function AgentPage({ toast }: Props) {
  useAgentRuntime();
  return <AgentWorkspace toast={toast} />;
}
