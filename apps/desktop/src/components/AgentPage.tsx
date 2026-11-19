import { AgentWorkspace } from "../agent/AgentWorkspace";
import { useAgentRuntime } from "../agent/useAgentRuntime";
import type { FileTabTarget } from "../lib/fs";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
  onOpenFile: (target: FileTabTarget) => void;
  onOpenBugById: (workspaceId: string, bugId: string) => void;
  onSelectLocalProject: (projectId: string) => void;
};

/**
 * Host for the Agent page: owns the runtime subscription, everything else lives
 * under `src/agent/`.
 */
export function AgentPage({
  toast,
  onOpenFile,
  onOpenBugById,
  onSelectLocalProject,
}: Props) {
  useAgentRuntime();
  return (
    <AgentWorkspace
      toast={toast}
      onOpenFile={onOpenFile}
      onOpenBugById={onOpenBugById}
      onSelectLocalProject={onSelectLocalProject}
    />
  );
}
