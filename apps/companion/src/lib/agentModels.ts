/**
 * Sanitized model catalog (`settings_agent_models`) and the small helpers the
 * session page's model picker needs — the phone-side mirror of desktop
 * `lib/agentSettings.ts`, minus everything that would drag API keys or
 * protocol wiring across the paired wire: the desktop never sends them.
 */

export type CatalogModel = {
  id: string;
  /** Context window in tokens. */
  contextWindow: number;
  /** `text` is always present; `image` is opt-in. */
  input: string[];
  /** Declared reasoning levels, low → high; `off` is always available. */
  reasoning: string[];
  enabled: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  models: CatalogModel[];
};

export type DshModelsCatalog = {
  providers: CatalogProvider[];
  activeProviderId: string;
  activeModelId: string;
  /** Last reasoning level per model, keyed by `provider/model`. */
  modelEfforts: Record<string, string>;
};

export type ActiveRoute = { provider: CatalogProvider; model: CatalogModel };

const effortKey = (providerId: string, modelId: string): string =>
  `${providerId}/${modelId}`;

/** The provider/model pair the runtime starts with; both must be enabled. */
export function resolveActive(catalog: DshModelsCatalog | null): ActiveRoute | null {
  if (!catalog) return null;
  const provider = catalog.providers.find(
    (item) => item.id === catalog.activeProviderId && item.enabled,
  );
  if (!provider) return null;
  const model = provider.models.find(
    (item) => item.id === catalog.activeModelId && item.enabled,
  );
  if (!model) return null;
  return { provider, model };
}

/** Provider groups worth listing: reachable, enabled, with models left. */
export function catalogGroups(
  catalog: DshModelsCatalog | null,
): Array<{ provider: CatalogProvider; models: CatalogModel[] }> {
  return (catalog?.providers ?? [])
    .filter((provider) => provider.enabled && provider.baseUrl.trim())
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled),
    }))
    .filter((group) => group.models.length > 0);
}

/** `off` first, then every level the model declares. */
export function effortStops(model: CatalogModel): string[] {
  const declared = model.reasoning.filter((level) => level !== "off");
  return ["off", ...declared];
}

/**
 * The level a model runs at unless the user picks another: the level it last
 * used, or `off`. An undeclared level is ignored — upstream rejects an effort
 * the route does not offer.
 */
export function rememberedEffort(
  catalog: DshModelsCatalog | null,
  providerId: string,
  modelId: string,
): string {
  const model = catalog?.providers
    .find((item) => item.id === providerId)
    ?.models.find((item) => item.id === modelId);
  const level = catalog?.modelEfforts?.[effortKey(providerId, modelId)];
  if (!level || !model) return "off";
  return effortStops(model).includes(level) ? level : "off";
}

/** 12345 → `12K`, 1234567 → `1.2M` — the context-window figure of a row. */
export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
