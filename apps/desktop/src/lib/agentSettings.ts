import { invoke } from "@tauri-apps/api/core";

/**
 * Settings shared by the built-in agent and the MCP bridge.
 *
 * Only facts that survive the runtime change live here: per-project repository
 * paths, the prompt template, worktree isolation, the enabled coworkers and the
 * model providers rendered into the runtime profile.
 */
export type ProjectAgentConfig = {
  repoPath: string;
  rule: string;
};

/** Wire protocols dsh's `llm-pi-ai` accepts; the order is the form's order. */
export type DshModelProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

/** Reasoning levels, in escalation order. */
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type DshReasoningLevel = (typeof REASONING_LEVELS)[number];

/** One level paired with the value it sends upstream. `off` may stay empty. */
export type ReasoningEffort = {
  level: DshReasoningLevel;
  wire: string;
};

/** One model in a provider's catalog. */
export type DshModelEntry = {
  id: string;
  contextWindow: number;
  /** Per-reply cap; `null` keeps the runtime default. */
  maxTokens: number | null;
  /** `text` is always present; `image` is opt-in. */
  input: Array<"text" | "image">;
  reasoning: ReasoningEffort[];
  enabled: boolean;
};

export type DshProvider = {
  /** Dictionary key in the rendered profile; not shown in the UI. */
  id: string;
  name: string;
  baseUrl: string;
  protocol: DshModelProtocol;
  apiKey: string;
  enabled: boolean;
  models: DshModelEntry[];
};

/** Providers plus the one provider/model pair the runtime starts with. */
export type DshModelsConfig = {
  providers: DshProvider[];
  activeProviderId: string;
  activeModelId: string;
};

/** One session's model route; `reasoningEffort` absent means the adapter default. */
export type ModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export type DshPermissionMode = "auto" | "notify" | "full";

export type AgentConfig = {
  projects: Record<string, ProjectAgentConfig>;
  promptTemplate: string;
  coworkerIds: string[];
  worktreeEnabled: boolean;
  executionUnits: number;
  /** 自定义供应商与模型目录;启动运行时渲染进 profile。 */
  dshModels: DshModelsConfig;
  /** 自主 / 变更前通知 / 完全访问;运行时重启后生效。 */
  permissionMode: DshPermissionMode;
};

/** The provider/model pair the runtime starts with; both must be enabled. */
export function resolveActiveModel(
  models: DshModelsConfig | null | undefined,
): { provider: DshProvider; model: DshModelEntry } | null {
  if (!models) return null;
  const provider = models.providers.find(
    (item) => item.id === models.activeProviderId && item.enabled,
  );
  if (!provider) return null;
  const model = provider.models.find(
    (item) => item.id === models.activeModelId && item.enabled,
  );
  if (!model) return null;
  return { provider, model };
}

/** Whether the runtime has everything it needs to start. */
export function modelsReady(models: DshModelsConfig | null | undefined): boolean {
  const active = resolveActiveModel(models);
  return active !== null && active.provider.baseUrl.trim().length > 0;
}

/**
 * First provider/model worth pointing at, mirroring what the backend picks when
 * the stored pointer no longer resolves.
 */
export function firstUsableModel(
  providers: DshProvider[],
): { providerId: string; modelId: string } {
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const model = provider.models.find((entry) => entry.enabled);
    if (model) return { providerId: provider.id, modelId: model.id };
  }
  return { providerId: "", modelId: "" };
}

/**
 * Mirrors the backend's default rule: the provider list is the priority order,
 * so the first enabled provider with an enabled model supplies the session
 * default. Choosing another provider's model means moving that provider to the
 * front and then calling this.
 */
export function withDefaultSelection(models: DshModelsConfig): DshModelsConfig {
  const provider = models.providers.find(
    (item) => item.enabled && item.models.some((model) => model.enabled),
  );
  if (!provider) return models;
  const keep =
    provider.id === models.activeProviderId &&
    provider.models.some((model) => model.id === models.activeModelId && model.enabled);
  if (keep) return models;
  const model = provider.models.find((entry) => entry.enabled);
  return {
    ...models,
    activeProviderId: provider.id,
    activeModelId: model?.id ?? "",
  };
}

/** `128K` / `1M`: catalog labels stay short enough to sit on one row. */
export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export const agentSettingsApi = {
  get: () => invoke<AgentConfig>("agent_settings_get"),
  set: (config: AgentConfig) => invoke<AgentConfig>("agent_settings_set", { config }),
};
