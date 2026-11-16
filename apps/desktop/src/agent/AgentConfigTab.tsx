import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Check } from "lucide-react";

import { ScrollingName } from "../components/ScrollingName";
import { useCoworkers } from "../components/CoworkerPicker";
import { Button, Spinner, Switch, cardClass, inputClass, selectClass } from "../components/ui";
import { t } from "../lib/i18n";
import type { DshAgentConfig, DshModelConfig, DshModelProtocol } from "../lib/dsh";
import type { AgentConfigDraft } from "./store";
import { agentActions, agentStore } from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

const PROTOCOLS: DshModelProtocol[] = ["openai-completions", "anthropic", "gemini"];

function protocolLabel(protocol: DshModelProtocol): string {
  switch (protocol) {
    case "openai-completions":
      return t("agent.config.protocolOpenai");
    case "anthropic":
      return t("agent.config.protocolAnthropic");
    case "gemini":
      return t("agent.config.protocolGemini");
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/** One model id per line or comma; duplicates and blanks are dropped. */
function splitModels(value: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const part of value.split(/[,，\n]/)) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return models;
}

function draftSlice(config: DshAgentConfig): AgentConfigDraft {
  return {
    promptTemplate: config.promptTemplate,
    worktreeEnabled: config.worktreeEnabled,
    executionUnits: config.executionUnits,
    dshModel: config.dshModel,
  };
}

/**
 * All agent settings, inside the Agent page. Coworkers save immediately through
 * their own API; the form's save writes model, prompt and execution settings,
 * merging the projects edited on the projects page.
 */
export function AgentConfigTab({ toast }: Props) {
  const state = agentStore.use();
  const config = state.config;
  const [draft, setDraft] = useState<DshAgentConfig | null>(null);
  const [modelsText, setModelsText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selection = useCoworkers(toast);

  useEffect(() => {
    if (config && !draft) setDraft(config);
  }, [config, draft]);

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return JSON.stringify(draftSlice(draft)) !== JSON.stringify(draftSlice(config));
  }, [config, draft]);

  if (!config || !draft) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-3xl">
          {state.configError ? (
            <div className="rounded-xl border border-rose-100 bg-rose-50 p-4 text-ui-caption text-rose-700">
              <div className="break-all" title={state.configError}>
                {t("agent.config.loadFailed")}
              </div>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => void agentActions.loadConfig()}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-ui-caption text-slate-400">
              <Spinner />
              {t("common.reading")}
            </div>
          )}
        </div>
      </div>
    );
  }

  const model = draft.dshModel;
  // Start uses the stored profile, not an unsaved draft.
  const modelReady = Boolean(config.dshModel.baseUrl.trim() && config.dshModel.model.trim());
  const modelList = modelsText ?? model.models.join("\n");

  const patchDraft = (patch: Partial<DshAgentConfig>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const patchModel = (patch: Partial<DshModelConfig>) =>
    setDraft((current) =>
      current ? { ...current, dshModel: { ...current.dshModel, ...patch } } : current,
    );

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await agentActions.saveConfig({
        promptTemplate: draft.promptTemplate,
        worktreeEnabled: draft.worktreeEnabled,
        executionUnits: clamp(draft.executionUnits, 1, 8),
        dshModel: {
          ...model,
          baseUrl: model.baseUrl.trim(),
          model: model.model.trim(),
          apiKey: model.apiKey.trim(),
          contextWindow: clamp(model.contextWindow || 128_000, 1_024, 4_000_000),
          models: model.models,
        },
      });
      setDraft(saved);
      setModelsText(null);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
        <div className="mx-auto max-w-3xl space-y-4 pb-2">
          <section className={cardClass}>
            <h2 className="text-ui-base text-slate-900" title={t("agent.config.modelHint")}>
              {t("agent.config.model")}
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label={t("agent.config.providerId")} hint={t("agent.config.providerIdHint")}>
                <input
                  value={model.providerId}
                  onChange={(event) => patchModel({ providerId: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label={t("agent.config.displayName")}>
                <input
                  value={model.displayName}
                  onChange={(event) => patchModel({ displayName: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field
                label={t("agent.config.baseUrl")}
                hint={t("agent.config.baseUrlHint")}
                wide
              >
                <input
                  value={model.baseUrl}
                  onChange={(event) => patchModel({ baseUrl: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label={t("agent.config.protocol")}>
                <select
                  value={model.protocol}
                  onChange={(event) =>
                    patchModel({ protocol: event.target.value as DshModelProtocol })
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
                  value={model.apiKey}
                  onChange={(event) => patchModel({ apiKey: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label={t("agent.config.modelId")}>
                <input
                  value={model.model}
                  onChange={(event) => patchModel({ model: event.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label={t("agent.config.contextWindow")}>
                <input
                  type="number"
                  min={1_024}
                  max={4_000_000}
                  value={model.contextWindow || ""}
                  onChange={(event) =>
                    patchModel({ contextWindow: Number.parseInt(event.target.value, 10) || 0 })
                  }
                  className={`${inputClass} tabular-nums`}
                />
              </Field>
              <Field
                label={t("agent.config.modelList")}
                hint={t("agent.config.modelListHint")}
                wide
              >
                <textarea
                  rows={2}
                  value={modelList}
                  onChange={(event) => {
                    setModelsText(event.target.value);
                    patchModel({ models: splitModels(event.target.value) });
                  }}
                  className={`${inputClass} resize-none font-mono`}
                />
              </Field>
            </div>
          </section>

          <section className={cardClass}>
            <h2 className="text-ui-base text-slate-900" title={t("agent.config.promptHint")}>
              {t("agent.config.prompt")}
            </h2>
            <textarea
              rows={8}
              value={draft.promptTemplate}
              onChange={(event) => patchDraft({ promptTemplate: event.target.value })}
              className={`${inputClass} mt-3 resize-y font-mono leading-5`}
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
                title={t("agent.config.worktreeHint")}
              >
                <span className="text-ui-sm text-slate-600">{t("agent.config.worktree")}</span>
                <Switch
                  checked={draft.worktreeEnabled}
                  onChange={(value) => patchDraft({ worktreeEnabled: value })}
                />
              </div>
              <div
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
                title={t("agent.config.unitsHint")}
              >
                <span className="text-ui-sm text-slate-600">{t("agent.config.units")}</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  disabled={!draft.worktreeEnabled}
                  value={draft.worktreeEnabled ? draft.executionUnits : 1}
                  onChange={(event) =>
                    patchDraft({
                      executionUnits: clamp(
                        Number.parseInt(event.target.value, 10) || 1,
                        1,
                        8,
                      ),
                    })
                  }
                  className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-right text-ui-caption tabular-nums text-slate-700 transition focus:border-sky-300 focus:outline-2 focus:outline-sky-200 disabled:text-slate-400"
                />
              </div>
            </div>
          </section>

          <section className={cardClass}>
            <h2 className="text-ui-base text-slate-900" title={t("agent.config.coworkersHint")}>
              {t("agent.config.coworkers")}
            </h2>
            <div className="mt-3">
              {selection.loadError ? (
                <div className="flex items-center gap-3 text-ui-caption text-rose-600">
                  <span className="min-w-0 flex-1 truncate" title={selection.loadError}>
                    {selection.loadError}
                  </span>
                  <Button size="sm" onClick={() => void selection.reload()}>
                    {t("common.retry")}
                  </Button>
                </div>
              ) : selection.coworkers === null ? (
                <div className="flex items-center gap-2 text-ui-caption text-slate-400">
                  <Spinner />
                  {t("common.loading")}
                </div>
              ) : selection.coworkers.length === 0 ? (
                <div className="text-ui-caption text-slate-400">
                  {t("agent.config.coworkersEmpty")}
                </div>
              ) : (
                <div className="flex max-h-60 flex-col gap-1 overflow-y-auto overscroll-contain">
                  {selection.coworkers.map((coworker) => {
                    const selected = selection.selectedIds.includes(coworker.id);
                    return (
                      <button
                        key={coworker.id}
                        type="button"
                        disabled={selection.busy}
                        aria-pressed={selected}
                        onClick={() => selection.toggle(coworker.id)}
                        className={clsx(
                          "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-default disabled:opacity-60",
                          selected
                            ? "border-sky-200 bg-sky-50"
                            : "border-border bg-surface hover:border-slate-300",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-700">
                          {coworker.name}
                        </span>
                        <span className="shrink-0 text-ui-xs text-slate-400">{coworker.role}</span>
                        {selected ? (
                          <Check size={13} className="shrink-0 text-sky-600" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className={cardClass}>
            <h2 className="text-ui-base text-slate-900" title={t("agent.config.runtimeHint")}>
              {t("agent.config.runtime")}
            </h2>
            <div className="mt-3">
              {state.status === null ? (
                state.statusError ? (
                  <div className="flex items-center gap-3 text-ui-caption text-rose-600">
                    <span className="min-w-0 flex-1 truncate" title={state.statusError}>
                      {t("agent.runtime.stateFailed")}
                    </span>
                    <Button size="sm" onClick={() => void agentActions.refreshStatus()}>
                      {t("common.retry")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-ui-caption text-slate-400">
                    <Spinner />
                    {t("common.loading")}
                  </div>
                )
              ) : state.status.phase === "stopped" ? (
                <div className="text-ui-caption text-slate-400">{t("agent.runtime.stopped")}</div>
              ) : state.status.phase === "starting" ? (
                <div className="flex items-center gap-2 text-ui-caption text-slate-400">
                  <Spinner />
                  {t("agent.runtime.starting")}
                </div>
              ) : state.status.phase === "failed" ? (
                <div className="break-all text-ui-caption text-rose-600" title={state.status.errorCode}>
                  {state.status.error ?? t("agent.runtime.failed")}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {state.status.payloadVersion ? (
                    <Fact label={t("agent.config.payloadVersion")} value={state.status.payloadVersion} />
                  ) : null}
                  {state.status.nodeVersion ? (
                    <Fact label={t("agent.config.node")} value={state.status.nodeVersion} mono />
                  ) : null}
                  {state.status.nodePath ? (
                    <Fact label={t("agent.config.nodePath")} value={state.status.nodePath} mono />
                  ) : null}
                  {state.status.provider ? (
                    <Fact label={t("agent.config.provider")} value={state.status.provider} />
                  ) : null}
                  {state.status.model ? (
                    <Fact label={t("agent.config.currentModel")} value={state.status.model} />
                  ) : null}
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              {state.status?.phase === "ready" ? (
                <Button
                  size="sm"
                  loading={state.stopping}
                  onClick={() => void agentActions.stopRuntime()}
                >
                  {t("agent.runtime.stop")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={state.starting}
                  disabled={!modelReady || state.preparingSince !== null}
                  title={modelReady ? undefined : t("agent.runtime.modelMissingHint")}
                  onClick={() => void agentActions.startRuntime()}
                >
                  {t("agent.runtime.start")}
                </Button>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="flex shrink-0 justify-end border-t border-border px-5 py-2">
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={clsx("block min-w-0", props.wide && "sm:col-span-2")} title={props.hint}>
      <span className="block text-ui-sm text-slate-600">{props.label}</span>
      <span className="mt-1 block">{props.children}</span>
    </label>
  );
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 shrink-0 text-ui-xs text-slate-400">{props.label}</span>
      {props.mono ? (
        <ScrollingName
          text={props.value}
          className="min-w-0 flex-1 font-mono text-ui-xs text-slate-600"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-ui-xs text-slate-600">{props.value}</span>
      )}
    </div>
  );
}
