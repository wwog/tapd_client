import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { Circle, Pencil, Plus, Trash2 } from "lucide-react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { ScrollingName } from "../components/ScrollingName";
import { Badge, Button, Switch, cardClass, inputClass, selectClass } from "../components/ui";
import {
  firstUsableModel,
  type DshModelEntry,
  type DshModelProtocol,
  type DshModelsConfig,
  type DshProvider,
} from "../lib/agentSettings";
import { t } from "../lib/i18n";
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

/** `128K` / `1M`: catalog badges stay short enough to sit on one row. */
function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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

type Props = {
  value: DshModelsConfig;
  onChange: (next: DshModelsConfig) => void;
};

/**
 * Providers on the left, the selected route on the right, its catalog below.
 * Edits stay in the caller's draft: the configuration tab owns the one save.
 */
export function ModelSettings({ value, onChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ providerId: string; index: number | null } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);

  const providers = value.providers;
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null;

  const patchProvider = (id: string, patch: Partial<DshProvider>) =>
    onChange({
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
    onChange({ ...value, providers: [...providers, provider] });
    setSelectedId(provider.id);
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
    onChange({
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
    if (!activeModelId) {
      // Nothing is selected yet: the first model added becomes the default.
      activeProviderId = providerId;
      activeModelId = model.id;
    } else if (
      previous &&
      activeProviderId === providerId &&
      activeModelId === previous.id &&
      model.id !== previous.id
    ) {
      // The default model was renamed in place.
      activeModelId = model.id;
    }
    onChange({ providers: nextProviders, activeProviderId, activeModelId });
  };

  const removeModel = (providerId: string, index: number) => {
    const provider = providers.find((item) => item.id === providerId);
    const removed = provider?.models[index];
    if (!removed) return;
    const nextProviders = providers.map((item) =>
      item.id === providerId
        ? { ...item, models: item.models.filter((_, position) => position !== index) }
        : item,
    );
    const dropActive = value.activeProviderId === providerId && value.activeModelId === removed.id;
    const pointer = dropActive
      ? firstUsableModel(nextProviders)
      : { providerId: value.activeProviderId, modelId: value.activeModelId };
    onChange({
      providers: nextProviders,
      activeProviderId: pointer.providerId,
      activeModelId: pointer.modelId,
    });
  };

  const editingProvider = editor
    ? providers.find((provider) => provider.id === editor.providerId) ?? null
    : null;
  const editingModel =
    editor && editingProvider && editor.index !== null
      ? editingProvider.models[editor.index] ?? null
      : null;

  return (
    <section className={cardClass}>
      <div className="flex items-center gap-3">
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

      <div className="mt-4 flex h-[520px]">
        <nav
          className="w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border pr-3"
          aria-label={t("agent.model.providers")}
        >
          {providers.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-caption text-slate-400">
              {t("agent.model.noProviders")}
            </div>
          ) : (
            providers.map((provider) => {
              const active = selected?.id === provider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-current={active}
                  onClick={() => setSelectedId(provider.id)}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                    active
                      ? "bg-sky-50 text-sky-700"
                      : "text-slate-600 hover:bg-overlay-soft",
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
                </button>
              );
            })
          )}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto pl-4">
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
                  <input
                    type="password"
                    autoComplete="off"
                    value={selected.apiKey}
                    onChange={(event) =>
                      patchProvider(selected.id, { apiKey: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <span className="text-ui-sm text-slate-600">{t("agent.model.models")}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  icon={<Plus size={13} />}
                  onClick={() => setEditor({ providerId: selected.id, index: null })}
                >
                  {t("agent.model.addModel")}
                </Button>
              </div>

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
                    // The badge states what the runtime will use, so it follows
                    // the saved pointer rather than guessing a first row.
                    const isDefault =
                      value.activeProviderId === selected.id &&
                      value.activeModelId === model.id;
                    return (
                      <li key={model.id} className="flex items-center gap-2 py-1.5">
                        <ScrollingName
                          text={model.id}
                          className="flex-1 font-mono text-ui-caption text-slate-700"
                        />
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge>{compactTokens(model.contextWindow)}</Badge>
                          {model.input.includes("image") ? (
                            <Badge tone="cyan">{t("agent.model.inputImage")}</Badge>
                          ) : null}
                          {model.reasoning.length > 0 ? (
                            <Badge tone="blue">{t("agent.model.reasoning")}</Badge>
                          ) : null}
                        </div>
                        {isDefault ? (
                          <Badge tone="blue" className="shrink-0">
                            {t("agent.model.default")}
                          </Badge>
                        ) : (
                          <button
                            type="button"
                            title={t("agent.model.setDefault")}
                            onClick={() =>
                              onChange({
                                ...value,
                                activeProviderId: selected.id,
                                activeModelId: model.id,
                              })
                            }
                            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-300 transition hover:bg-overlay hover:text-sky-600"
                          >
                            <Circle size={11} />
                          </button>
                        )}
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
    <label className="block min-w-0" title={props.hint}>
      <span className="block text-ui-xs text-slate-400">{props.label}</span>
      <span className="mt-1 block">{props.children}</span>
    </label>
  );
}
