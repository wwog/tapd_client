import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { Eye, EyeOff, GripVertical, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { ScrollingName } from "../components/ScrollingName";
import {
  Badge,
  Button,
  Switch,
  cardClass,
  inputClass,
  selectClass,
} from "../components/ui";
import {
  compactTokens,
  firstUsableModel,
  withDefaultSelection,
  type DshModelEntry,
  type DshModelProtocol,
  type DshModelsConfig,
  type DshProvider,
} from "../lib/agentSettings";
import { dshModelApi, type DshDiscoveredModel } from "../lib/dsh";
import { t } from "../lib/i18n";
import { useReorder } from "../hooks/useReorder";
import { ModelEditorDialog } from "./ModelEditorDialog";

const PROTOCOLS: DshModelProtocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

function protocolLabel(protocol: DshModelProtocol): string {
  switch (protocol) {
    case "openai-completions":
      return t("agent.model.protocolCompletions");
    case "openai-responses":
      return t("agent.model.protocolResponses");
    case "anthropic-messages":
      return t("agent.model.protocolAnthropic");
    case "google-generative-ai":
      return t("agent.model.protocolGoogle");
  }
}

/** The profile key of a new provider; renamed names keep their original key. */
function nextProviderId(providers: DshProvider[]): string {
  const used = new Set(providers.map((provider) => provider.id));
  for (let index = 1; index <= providers.length + 1; index += 1) {
    const id = `provider-${index}`;
    if (!used.has(id)) return id;
  }
  return `provider-${Date.now()}`;
}

/**
 * A route is ready when it is enabled, has an address and offers a model.
 * Mirrors the filter the runtime applies before writing the profile.
 */
function providerState(provider: DshProvider): "ready" | "incomplete" | "off" {
  if (!provider.enabled) return "off";
  const ready =
    provider.baseUrl.trim().length > 0 && provider.models.some((model) => model.enabled);
  return ready ? "ready" : "incomplete";
}

/** Catalog entry for a discovered model; existing rows are never overwritten. */
function discoveredEntry(model: DshDiscoveredModel): DshModelEntry {
  return {
    id: model.id,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? null,
    // Most chat endpoints accept images; a listing that states its modalities
    // wins, and the user can still turn the toggle off in the editor.
    input: model.inputModalities
      ? model.inputModalities.includes("image")
        ? ["text", "image"]
        : ["text"]
      : ["text", "image"],
    // Unknown levels would be rejected upstream; the ladder stays undeclared
    // until the user maps one, which means "off" only in the picker.
    reasoning: [],
    enabled: true,
  };
}

type Props = {
  value: DshModelsConfig;
  onChange: (next: DshModelsConfig) => void;
  /** Fills the dialog pane instead of the fixed 380px block. */
  fill?: boolean;
};

/**
 * Providers on the left, the selected route on the right, its catalog below.
 * Edits stay in the caller's draft: the configuration tab owns the one save.
 */
export function ModelSettings({ value, onChange, fill = false }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ providerId: string; index: number | null } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  /** Outcome of the last 获取模型 on the selected provider. */
  const [fetchNote, setFetchNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** Provider whose API key is shown in clear text; clears when switching away. */
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const providers = value.providers;
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null;

  /** Every edit keeps the backend's "first provider/model is the default" rule. */
  const commit = (next: DshModelsConfig) => onChange(withDefaultSelection(next));

  const patchProvider = (id: string, patch: Partial<DshProvider>) =>
    commit({
      ...value,
      providers: providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    });

  const addProvider = () => {
    const provider: DshProvider = {
      id: nextProviderId(providers),
      name: t("agent.model.newProvider"),
      baseUrl: "",
      protocol: "openai-completions",
      apiKey: "",
      enabled: true,
      models: [],
    };
    commit({ ...value, providers: [...providers, provider] });
    selectProvider(provider.id);
  };

  const removeProvider = (id: string) => {
    const remaining = providers.filter((provider) => provider.id !== id);
    const pointer =
      value.activeProviderId === id
        ? firstUsableModel(remaining)
        : {
            providerId: value.activeProviderId,
            modelId: value.activeModelId,
          };
    commit({
      ...value,
      providers: remaining,
      activeProviderId: pointer.providerId,
      activeModelId: pointer.modelId,
    });
    setSelectedId(null);
    setRemoving(null);
  };

  const submitModel = (
    providerId: string,
    index: number | null,
    model: DshModelEntry,
  ) => {
    const provider = providers.find((item) => item.id === providerId);
    const previous = index === null ? null : provider?.models[index] ?? null;
    const nextProviders = providers.map((item) =>
      item.id === providerId
        ? {
            ...item,
            models:
              index === null
                ? [...item.models, model]
                : item.models.map((entry, position) => (position === index ? model : entry)),
          }
        : item,
    );

    let activeProviderId = value.activeProviderId;
    let activeModelId = value.activeModelId;
    // The default follows the order, so a rename in place must not leave the
    // pointer on an id that no longer exists.
    if (
      previous &&
      activeProviderId === providerId &&
      activeModelId === previous.id &&
      model.id !== previous.id
    ) {
      activeModelId = model.id;
    }
    commit({ ...value, providers: nextProviders, activeProviderId, activeModelId });
  };

  const removeModel = (providerId: string, index: number) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider?.models[index]) return;
    const nextProviders = providers.map((item) =>
      item.id === providerId
        ? { ...item, models: item.models.filter((_, position) => position !== index) }
        : item,
    );
    commit({ ...value, providers: nextProviders });
  };

  /** Drag reorder; `commit` then moves the default to the new first entry. */
  const moveProvider = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = providers.findIndex((provider) => provider.id === fromId);
    const to = providers.findIndex((provider) => provider.id === toId);
    if (from < 0 || to < 0) return;
    const next = providers.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit({ ...value, providers: next });
  };

  /** Same rule one level down: the first enabled model is the provider's default. */
  const moveModel = (providerId: string, fromId: string, toId: string) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || fromId === toId) return;
    const from = provider.models.findIndex((model) => model.id === fromId);
    const to = provider.models.findIndex((model) => model.id === toId);
    if (from < 0 || to < 0) return;
    const models = provider.models.slice();
    const [moved] = models.splice(from, 1);
    models.splice(to, 0, moved);
    patchProvider(providerId, { models });
  };

  const providerDrag = useReorder("providers", moveProvider);
  const modelDrag = useReorder("models", (from, to) => {
    if (selected) moveModel(selected.id, from, to);
  });

  const selectProvider = (id: string) => {
    setSelectedId(id);
    setFetchNote(null);
    setRevealedKey(null);
  };

  /**
   * Reads the endpoint's advertised models and appends the ones the catalog
   * does not have yet. Existing rows keep their hand-tuned settings.
   */
  const fetchModels = async () => {
    if (!selected || fetching) return;
    const provider = selected;
    setFetching(true);
    setFetchNote(null);
    try {
      const { models: found } = await dshModelApi.discover({
        provider: provider.id,
        baseUrl: provider.baseUrl,
        api: provider.protocol,
        ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {}),
      });
      const existing = new Set(provider.models.map((model) => model.id));
      const added = found
        .filter((model) => model.id && !existing.has(model.id))
        .map(discoveredEntry);
      if (added.length > 0) {
        patchProvider(provider.id, { models: [...provider.models, ...added] });
      }
      setFetchNote({
        ok: true,
        text:
          added.length > 0
            ? t("agent.model.fetchAdded", { count: added.length })
            : t("agent.model.fetchNone"),
      });
    } catch (error) {
      setFetchNote({ ok: false, text: String(error) });
    } finally {
      setFetching(false);
    }
  };

  const editingProvider = editor
    ? providers.find((provider) => provider.id === editor.providerId) ?? null
    : null;
  const editingModel =
    editor && editingProvider && editor.index !== null
      ? editingProvider.models[editor.index] ?? null
      : null;
  const firstEnabledModel = selected?.models.find((model) => model.enabled)?.id ?? null;

  return (
    <section data-component="ModelSettings" className={clsx(cardClass, fill && "flex h-full min-h-0 flex-col")}>
      <div className="flex shrink-0 items-center gap-3">
        <h2 className="text-ui-base text-slate-900" title={t("agent.config.modelHint")}>
          {t("agent.config.model")}
        </h2>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          icon={<Plus size={13} />}
          onClick={addProvider}
        >
          {t("agent.model.addProvider")}
        </Button>
      </div>

      <div className={clsx("mt-4 flex", fill ? "min-h-0 flex-1" : "h-[380px]")}>
        <nav
          className="w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border pr-3"
          aria-label={t("agent.model.providers")}
          title={t("agent.model.orderHint")}
        >
          {providers.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-caption text-slate-400">
              {t("agent.model.noProviders")}
            </div>
          ) : (
            providers.map((provider) => {
              const active = selected?.id === provider.id;
              return (
                <div
                  key={provider.id}
                  role="button"
                  tabIndex={0}
                  aria-current={active}
                  data-reorder-list="providers"
                  data-reorder-id={provider.id}
                  onClick={() => selectProvider(provider.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    selectProvider(provider.id);
                  }}
                  className={clsx(
                    "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                    active
                      ? "bg-sky-50 text-sky-700"
                      : "text-slate-600 hover:bg-overlay-soft",
                    providerDrag.dragId === provider.id && "opacity-40",
                    providerDrag.overId === provider.id &&
                      providerDrag.dragId !== provider.id &&
                      "bg-sky-50",
                  )}
                >
                  <span
                    className={clsx(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      providerState(provider) === "ready"
                        ? "bg-emerald-500"
                        : providerState(provider) === "incomplete"
                          ? "bg-amber-500"
                          : "bg-slate-300",
                    )}
                  />
                  <ScrollingName
                    text={provider.name || provider.id}
                    className="flex-1 text-ui-caption"
                  />
                  <span
                    role="presentation"
                    title={t("agent.model.reorderHint")}
                    onPointerDown={providerDrag.startDrag(provider.id)}
                    className="shrink-0 cursor-grab touch-none text-slate-300 opacity-40 transition group-hover:opacity-100 active:cursor-grabbing"
                  >
                    <GripVertical size={11} />
                  </span>
                </div>
              );
            })
          )}
        </nav>

        {/* pr keeps the 8px overlay scrollbar off the row toggles. */}
        <div className="min-w-0 flex-1 overflow-y-auto pl-4 pr-2">
          {selected === null ? (
            <div className="grid h-full place-items-center px-4 text-center">
              <div>
                <p className="text-ui-caption text-slate-400">{t("agent.model.noProviders")}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  icon={<Plus size={13} />}
                  onClick={addProvider}
                >
                  {t("agent.model.addProvider")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  value={selected.name}
                  aria-label={t("agent.model.providerName")}
                  placeholder={t("agent.model.providerName")}
                  onChange={(event) =>
                    patchProvider(selected.id, { name: event.target.value })
                  }
                  className={`${inputClass} flex-1`}
                />
                <Switch
                  checked={selected.enabled}
                  onChange={(enabled) => patchProvider(selected.id, { enabled })}
                  label={t("agent.model.enabled")}
                />
                <button
                  type="button"
                  title={t("agent.model.removeProvider")}
                  onClick={() => setRemoving(selected.id)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              <div className="mt-3 space-y-3">
                <Field label={t("agent.config.baseUrl")} hint={t("agent.config.baseUrlHint")}>
                  <input
                    value={selected.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) =>
                      patchProvider(selected.id, { baseUrl: event.target.value })
                    }
                    className={`${inputClass} font-mono`}
                  />
                </Field>
                <Field label={t("agent.model.apiFormat")}>
                  <select
                    value={selected.protocol}
                    onChange={(event) =>
                      patchProvider(selected.id, {
                        protocol: event.target.value as DshModelProtocol,
                      })
                    }
                    className={`${selectClass} w-full`}
                  >
                    {PROTOCOLS.map((protocol) => (
                      <option key={protocol} value={protocol}>
                        {protocolLabel(protocol)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("agent.config.apiKey")} hint={t("agent.config.apiKeyHint")}>
                  <span className="relative block">
                    <input
                      type={revealedKey === selected.id ? "text" : "password"}
                      autoComplete="off"
                      value={selected.apiKey}
                      onChange={(event) =>
                        patchProvider(selected.id, { apiKey: event.target.value })
                      }
                      className={`${inputClass} pr-8 font-mono`}
                    />
                    <button
                      type="button"
                      title={
                        revealedKey === selected.id
                          ? t("agent.config.apiKeyHide")
                          : t("agent.config.apiKeyShow")
                      }
                      aria-label={
                        revealedKey === selected.id
                          ? t("agent.config.apiKeyHide")
                          : t("agent.config.apiKeyShow")
                      }
                      onClick={() =>
                        setRevealedKey((current) =>
                          current === selected.id ? null : selected.id,
                        )
                      }
                      className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-slate-400 transition hover:bg-overlay hover:text-slate-700"
                    >
                      {revealedKey === selected.id ? (
                        <EyeOff size={12} />
                      ) : (
                        <Eye size={12} />
                      )}
                    </button>
                  </span>
                </Field>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <span className="text-ui-sm text-slate-600">{t("agent.model.models")}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RefreshCw size={13} />}
                    loading={fetching}
                    title={
                      selected.baseUrl.trim()
                        ? t("agent.model.fetchHint")
                        : t("agent.config.baseUrlHint")
                    }
                    onClick={() => void fetchModels()}
                  >
                    {fetching ? t("agent.model.fetching") : t("agent.model.fetchModels")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus size={13} />}
                    onClick={() => setEditor({ providerId: selected.id, index: null })}
                  >
                    {t("agent.model.addModel")}
                  </Button>
                </span>
              </div>

              {fetchNote ? (
                <p
                  className={clsx(
                    "mt-2 break-all text-ui-xs",
                    fetchNote.ok ? "text-slate-500" : "text-rose-600",
                  )}
                  title={fetchNote.text}
                >
                  {fetchNote.text}
                </p>
              ) : null}

              {selected.models.length === 0 ? (
                <div
                  className="mt-2 rounded-xl border border-dashed border-border px-3 py-6 text-center text-ui-caption text-slate-400"
                  title={t("agent.model.noModelsHint")}
                >
                  {t("agent.model.noModels")}
                </div>
              ) : (
                <ul className="mt-1 divide-y divide-slate-100">
                  {selected.models.map((model, index) => {
                    // The default is positional, so the badge follows the first
                    // enabled row rather than an independently stored pointer.
                    const isDefault = model.id === firstEnabledModel;
                    return (
                      <li
                        key={model.id}
                        data-reorder-list="models"
                        data-reorder-id={model.id}
                        className={clsx(
                          "flex items-center gap-2 py-1.5 transition",
                          modelDrag.dragId === model.id && "opacity-40",
                          modelDrag.overId === model.id &&
                            modelDrag.dragId !== model.id &&
                            "bg-sky-50",
                        )}
                      >
                        <span
                          role="presentation"
                          title={t("agent.model.reorderHint")}
                          onPointerDown={modelDrag.startDrag(model.id)}
                          className="shrink-0 cursor-grab touch-none text-slate-300 opacity-40 transition hover:opacity-100 active:cursor-grabbing"
                        >
                          <GripVertical size={11} />
                        </span>
                        <ScrollingName
                          text={model.id}
                          className="flex-1 font-mono text-ui-caption text-slate-700"
                        />
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge>{compactTokens(model.contextWindow)}</Badge>
                          {model.input.includes("image") ? (
                            <Badge tone="cyan">{t("agent.model.inputImage")}</Badge>
                          ) : null}
                          {model.reasoning.some((effort) => effort.level !== "off") ? (
                            <Badge tone="blue">{t("agent.model.reasoning")}</Badge>
                          ) : null}
                        </div>
                        {isDefault ? (
                          <Badge tone="blue" className="shrink-0">
                            {t("agent.model.default")}
                          </Badge>
                        ) : null}
                        <button
                          type="button"
                          title={t("agent.model.edit")}
                          onClick={() => setEditor({ providerId: selected.id, index })}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-overlay hover:text-slate-700"
                        >
                          <Pencil size={12} />
                        </button>
                        <Switch
                          checked={model.enabled}
                          onChange={(enabled) =>
                            patchProvider(selected.id, {
                              models: selected.models.map((entry, position) =>
                                position === index ? { ...entry, enabled } : entry,
                              ),
                            })
                          }
                          label={t("agent.model.enabled")}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      {editor && editingProvider ? (
        <ModelEditorDialog
          key={`${editor.providerId}:${editor.index ?? "new"}`}
          model={editingModel}
          existingIds={editingProvider.models.map((model) => model.id)}
          onClose={() => setEditor(null)}
          onSubmit={(model) => submitModel(editor.providerId, editor.index, model)}
          onDelete={
            editor.index === null
              ? undefined
              : () => removeModel(editor.providerId, editor.index as number)
          }
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={t("agent.model.removeProvider")}
          message={t("agent.model.removeProviderHint")}
          onCancel={() => setRemoving(null)}
          onConfirm={() => removeProvider(removing)}
        />
      ) : null}
    </section>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label data-component="Field" className="block min-w-0" title={props.hint}>
      <span className="block text-ui-xs text-slate-400">{props.label}</span>
      <span className="mt-1 block">{props.children}</span>
    </label>
  );
}
