import { AgentWorkspace } from "../agent/AgentWorkspace";
import { useAgentRuntime } from "../agent/useAgentRuntime";
import type { FileTabTarget } from "../lib/fs";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
  onOpenFile: (target: FileTabTarget) => void;
};

/**
 * Host for the Agent page: owns the runtime subscription, everything else lives
 * under `src/agent/`.
 */
export function AgentPage({ toast, onOpenFile }: Props) {
  useAgentRuntime();
  return <AgentWorkspace toast={toast} onOpenFile={onOpenFile} />;
}
