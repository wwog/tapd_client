import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  Boxes,
  Check,
  HelpCircle,
  Plug,
  Puzzle,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react";

import { Dialog } from "../components/Dialog";
import { ScrollingName } from "../components/ScrollingName";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button, Spinner, Switch, cardClass, inputClass } from "../components/ui";
import { t, type MessageKey } from "../lib/i18n";
import type { DshAgentConfig, DshPermissionMode } from "../lib/dsh";
import { ModelSettings } from "./ModelSettings";
import { CoworkerSettings } from "./CoworkerSettings";
import { PluginInventory } from "./PluginInventory";
import { ToolInventory } from "./ToolInventory";
import { UsagePopover } from "./usage/Popover";
import {
  agentActions,
  agentStore,
  type AgentConfigSection,
} from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
  onClose: () => void;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/** Edit → pause before writing, so typing does not write the file per key. */
const SAVE_DELAY_MS = 500;

/** The three settings groups, in the dialog's left column. */
type Section = AgentConfigSection;

const NAV: Array<{ id: Section; label: MessageKey; icon: LucideIcon }> = [
  { id: "general", label: "agent.config.nav.general", icon: SlidersHorizontal },
  { id: "models", label: "agent.config.nav.models", icon: Boxes },
  { id: "rules", label: "agent.config.nav.rules", icon: ScrollText },
  { id: "coworkers", label: "agent.config.nav.coworkers", icon: Users },
  { id: "integrations", label: "agent.config.nav.integrations", icon: Plug },
  { id: "plugins", label: "agent.config.nav.plugins", icon: Puzzle },
];

/**
 * Global mount for the configuration dialog. The Agent page used to own this,
 * but the entry point lives in Settings now: from a non-Agent page the store
 * flag had no dialog listening to it.
 */
export function AgentConfigHost({ toast }: Pick<Props, "toast">) {
  const state = agentStore.use();
  const open = state.configOpen;
  useEffect(() => {
    if (!open) return;
    // Settings can be the first page opened in this app run, so the Agent
    // page's bootstrap may never have run; load what the dialog renders.
    if (!state.config) void agentActions.loadConfig();
    if (!state.status) void agentActions.refreshStatus();
  }, [open, state.config, state.status]);
  if (!open) return null;
  return <AgentConfigTab toast={toast} onClose={agentActions.closeConfig} />;
}

/**
 * All agent settings, in a dialog opened from Settings (or a runtime notice). The
 * left column groups them: 模型 (providers and catalog), 规则 (prompt and
 * permission policy), 同事 (who joins the prompt), 集成 (the tools a session
 * inherits), 内置插件 and 常规 (execution, team collaboration, runtime). Every
 * control applies on its own: edits are written back after a short pause instead
 * of behind a save button. Projects are edited on the projects page and merged
 * by the same command.
 */
export function AgentConfigTab({ toast, onClose }: Props) {
  const state = agentStore.use();
  const config = state.config;
  // The dialog mounts per open, so the entry point's group is the initial one.
  const [section, setSection] = useState<Section>(state.configSection);
  const [draft, setDraft] = useState<DshAgentConfig | null>(null);
  /** The permission mode saves on click, not with the form. */
  const [policySaving, setPolicySaving] = useState(false);
  /** Restarting kills running turns; ask first when that would hurt. */
  const [confirmRestart, setConfirmRestart] = useState(false);

  // The draft is the local source of truth while editing; the stored config
  // only seeds it, so a save echo never fights the caret.
  const draftRef = useRef<DshAgentConfig | null>(null);
  const pending = useRef<DshAgentConfig | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (config && !draftRef.current) {
      draftRef.current = config;
      setDraft(config);
    }
  }, [config]);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    void agentActions
      .saveConfig({
        promptTemplate: next.promptTemplate,
        teamEnabled: next.teamEnabled,
        executionUnits: clamp(next.executionUnits, 1, 8),
        dshModels: next.dshModels,
      })
      .catch((error) => toast("error", String(error)));
  }, [toast]);

  // Write the last edit even if the dialog unmounts right after it.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const patchDraft = (patch: Partial<DshAgentConfig>) => {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setDraft(next);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  if (!config || !draft) {
    return (
      <ConfigDialog onClose={onClose}>
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
      </ConfigDialog>
    );
  }

  const permissionModes: Array<{
    value: DshPermissionMode;
    label: string;
    hint: string;
  }> = [
    {
      value: "auto",
      label: t("agent.config.permissionAuto"),
      hint: t("agent.config.permissionAutoHint"),
    },
    {
      value: "notify",
      label: t("agent.config.permissionNotify"),
      hint: t("agent.config.permissionNotifyHint"),
    },
    {
      value: "full",
      label: t("agent.config.permissionFull"),
      hint: t("agent.config.permissionFullHint"),
    },
  ];

  const choosePermission = async (mode: DshPermissionMode) => {
    if (policySaving || config.permissionMode === mode) return;
    setPolicySaving(true);
    try {
      await agentActions.setPermissionMode(mode);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setPolicySaving(false);
    }
  };

  const restartRunning = Object.values(state.sessions).some(
    (session) => session.status === "running",
  );
  const restart = () => {
    if (restartRunning) setConfirmRestart(true);
    else void agentActions.restartRuntime();
  };

  return (
    <ConfigDialog onClose={onClose}>
      <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-border">
        <nav
          className="w-40 shrink-0 space-y-0.5 border-r border-border p-2"
          aria-label={t("agent.tab.config")}
        >
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active}
                onClick={() => setSection(item.id)}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-caption transition",
                  active
                    ? "bg-sky-50 text-sky-700"
                    : "text-slate-600 hover:bg-overlay-soft",
                )}
              >
                <Icon
                  size={13}
                  className={clsx(
                    "shrink-0",
                    active ? "text-sky-600" : "text-slate-400",
                  )}
                />
                {t(item.label)}
              </button>
            );
          })}
        </nav>

        <div
          className={clsx(
            "min-h-0 flex-1 p-4",
            section === "models" ? "" : "overflow-y-auto overscroll-contain",
          )}
        >
          {section === "models" ? (
            <ModelSettings
              fill
              value={draft.dshModels}
              onChange={(dshModels) => patchDraft({ dshModels })}
            />
          ) : section === "integrations" ? (
            <div className="mx-auto max-w-3xl pb-2">
              <ToolInventory />
            </div>
          ) : section === "coworkers" ? (
            <div className="mx-auto max-w-3xl pb-2">
              <CoworkerSettings toast={toast} />
            </div>
          ) : section === "plugins" ? (
            <div className="mx-auto max-w-3xl pb-2">
              <PluginInventory />
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-3 pb-2">
              {section === "rules" ? (
                <section className={cardClass}>
                  <h2
                    className="text-ui-base text-slate-900"
                    title={t("agent.config.promptHint")}
                  >
                    {t("agent.config.prompt")}
                  </h2>
                  <textarea
                    rows={10}
                    value={draft.promptTemplate}
                    onChange={(event) => patchDraft({ promptTemplate: event.target.value })}
                    className={`${inputClass} mt-3 resize-y font-mono leading-5`}
                  />
                </section>
              ) : null}

            {section === "general" ? (
              <>
                <section className={cardClass}>
                  <h2 className="text-ui-base text-slate-900">
                    {t("agent.config.execution")}
                  </h2>
                  <div
                    className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
                    title={t("agent.config.unitsHint")}
                  >
                    <span className="text-ui-sm text-slate-600">
                      {t("agent.config.units")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={draft.executionUnits}
                      onChange={(event) =>
                        patchDraft({
                          executionUnits: clamp(
                            Number.parseInt(event.target.value, 10) || 1,
                            1,
                            8,
                          ),
                        })
                      }
                      className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-right text-ui-caption tabular-nums text-slate-700 transition"
                    />
                  </div>
                </section>

                <section className={cardClass}>
                  <h2
                    className="text-ui-base text-slate-900"
                    title={t("agent.config.permissionHint")}
                  >
                    {t("agent.config.permission")}
                  </h2>
                  <div className="mt-3 flex flex-col gap-1">
                    {permissionModes.map((mode) => {
                      const selected = config.permissionMode === mode.value;
                      return (
                        <button
                          key={mode.value}
                          type="button"
                          aria-pressed={selected}
                          title={mode.hint}
                          disabled={policySaving}
                          onClick={() => void choosePermission(mode.value)}
                          className={clsx(
                            "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition disabled:cursor-default disabled:opacity-60",
                            selected
                              ? "border-sky-200 bg-sky-50"
                              : "border-border bg-surface hover:border-slate-300",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-700">
                            {mode.label}
                          </span>
                          {selected ? (
                            <Check size={13} className="shrink-0 text-sky-600" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className={cardClass}>
                  <div className="flex items-center gap-3">
                    <div className="flex min-w-0 items-center gap-1">
                      <h2 className="text-ui-base text-slate-900">
                        {t("agent.config.team")}
                      </h2>
                      <UsagePopover
                        trigger={<HelpCircle size={12} />}
                        title={t("agent.config.team")}
                        minWidth={280}
                        fullHeight={160}
                      >
                        <p className="mt-2 text-ui-xs leading-5 text-slate-500">
                          {t("agent.config.teamHint")}
                        </p>
                      </UsagePopover>
                    </div>
                    <Switch
                      className="ml-auto"
                      checked={draft.teamEnabled}
                      onChange={(teamEnabled) => patchDraft({ teamEnabled })}
                      label={t("agent.config.team")}
                    />
                  </div>
                </section>

                <section className={cardClass}>
                  <h2
                    className="text-ui-base text-slate-900"
                    title={t("agent.config.runtimeHint")}
                  >
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
                      <div className="text-ui-caption text-slate-400">
                        {t("agent.runtime.stopped")}
                      </div>
                    ) : state.status.phase === "starting" ? (
                      <div className="flex items-center gap-2 text-ui-caption text-slate-400">
                        <Spinner />
                        {t("agent.runtime.starting")}
                      </div>
                    ) : state.status.phase === "failed" ? (
                      state.status.errorCode === "model_missing" ? (
                        <div className="flex items-center gap-3 text-ui-caption text-slate-500">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                          <span className="min-w-0 flex-1 truncate">
                            {t("agent.runtime.modelMissing")}
                          </span>
                          <Button
                            size="sm"
                            onClick={() => agentActions.openConfig("models")}
                          >
                            {t("agent.runtime.config")}
                          </Button>
                        </div>
                      ) : (
                        <div
                          className="break-all text-ui-caption text-rose-600"
                          title={state.status.errorCode}
                        >
                          {state.status.error ?? t("agent.runtime.failed")}
                        </div>
                      )
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {state.status.payloadVersion ? (
                          <Fact
                            label={t("agent.config.payloadVersion")}
                            value={state.status.payloadVersion}
                          />
                        ) : null}
                        {state.status.nodeVersion ? (
                          <Fact
                            label={t("agent.config.node")}
                            value={state.status.nodeVersion}
                            mono
                          />
                        ) : null}
                        {state.status.nodePath ? (
                          <Fact
                            label={t("agent.config.nodePath")}
                            value={state.status.nodePath}
                            mono
                          />
                        ) : null}
                        {state.status.provider ? (
                          <Fact
                            label={t("agent.config.provider")}
                            value={state.status.provider}
                          />
                        ) : null}
                        {state.status.model ? (
                          <Fact
                            label={t("agent.config.currentModel")}
                            value={state.status.model}
                          />
                        ) : null}
                      </div>
                    )}
                  </div>
                  {state.status?.phase === "failed" ? (
                    state.status.errorCode === "model_missing" ? null : (
                      <div className="mt-3 flex justify-end">
                        <Button size="sm" onClick={() => void agentActions.startRuntime()}>
                          {t("common.retry")}
                        </Button>
                      </div>
                    )
                  ) : state.status?.phase === "ready" ? (
                    <div className="mt-3 flex items-center justify-end gap-3">
                      {state.status.restartRequired ? (
                        <span className="min-w-0 flex-1 text-ui-xs text-amber-700">
                          {t("agent.config.restartRequired")}
                        </span>
                      ) : null}
                      <Button size="sm" loading={state.starting} onClick={restart}>
                        {t("agent.config.restartRuntime")}
                      </Button>
                    </div>
                  ) : null}
                </section>
              </>
            ) : null}
            </div>
          )}
        </div>
      </div>
      {confirmRestart ? (
        <ConfirmDialog
          title={t("agent.config.restartRuntime")}
          message={t("agent.config.restartBusy")}
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            void agentActions.restartRuntime();
          }}
        />
      ) : null}
    </ConfigDialog>
  );
}

/** The dialog shell shared by the loaded and the still-reading state. */
function ConfigDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={t("agent.tab.config")}
      icon={<Settings2 size={16} className="text-slate-400" />}
      size="wide"
      bodyScroll={false}
      onClose={onClose}
    >
      {children}
    </Dialog>
  );
}

function Fact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div data-component="Fact" className="flex items-baseline gap-3">
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
