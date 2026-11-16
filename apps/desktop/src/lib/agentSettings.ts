import { invoke } from "@tauri-apps/api/core";

/**
 * Settings shared by the built-in agent and the MCP bridge.
 *
 * Only facts that survive the runtime change live here: per-project repository
 * paths, the prompt template, worktree isolation and the enabled coworkers.
 * Model, permission and runtime selection belong to the dsh profile.
 */
export type ProjectAgentConfig = {
  repoPath: string;
  rule: string;
};

export type AgentConfig = {
  projects: Record<string, ProjectAgentConfig>;
  promptTemplate: string;
  coworkerIds: string[];
  worktreeEnabled: boolean;
  executionUnits: number;
};

export const agentSettingsApi = {
  get: () => invoke<AgentConfig>("agent_settings_get"),
  set: (config: AgentConfig) => invoke<AgentConfig>("agent_settings_set", { config }),
};
