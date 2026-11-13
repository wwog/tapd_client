import { useEffect, useState } from "react";
import {
  AlertTriangle,
  // Bot,
  Check,
  CircleSlash,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  Workflow,
} from "lucide-react";

import {
  agentApi,
  type AgentConfig,
  type AgentRuntimeDescriptor,
  type AgentRuntimeOptions,
} from "../lib/agent";
import { useAgentScan } from "../lib/agentScan";
import { formatDateTime } from "../lib/format";
import type { SettingsSectionProps } from "../lib/feature";
import { AgentExecutionCard } from "./AgentExecutionCard";
import { AgentPicker } from "./AgentPicker";
import { AgentSettings } from "./AgentSettings";
import { Badge, Button, Spinner, cardClass } from "./ui";

type Props = {
  toast: SettingsSectionProps["toast"];
};

/**
 * Agent 页 →「配置」：默认 Agent 选择 + 该运行时的参数与互通说明。
 *
 * 默认运行时用下拉选择器（带检测状态与版本），不再用左侧长列表，避免 40+
 * 个运行时挤在窄栏里、选中状态也不明显。
 */
export function AgentConfigPane({ toast }: Props) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [saving, setSaving] = useState(false);
  /** 本机安装检测；设置页与本页共享同一份缓存。 */
  const { byRuntime, snapshot, loading: scanning, refresh } = useAgentScan();

  useEffect(() => {
    void Promise.all([agentApi.configGet(), agentApi.runtimes()])
      .then(([configResult, runtimeResult]) => {
        setConfig(configResult.config);
        setRuntimes(runtimeResult.runtimes);
      })
      .catch((error) => toast("error", String(error)));
  }, [toast]);

  const selectedRuntime =
    runtimes.find((runtime) => runtime.id === config?.runtimeId) ??
    runtimes[0] ??
    null;
  const selectedScan = selectedRuntime
    ? byRuntime.get(selectedRuntime.id)
    : undefined;
  /** 模型输入是草稿，失焦 / 回车才落盘，避免每敲一个字符都写配置。 */
  const [modelDraft, setModelDraft] = useState("");

  const optionsFor = (runtimeId: string | undefined): AgentRuntimeOptions => {
    const saved = runtimeId ? config?.runtimeOptions?.[runtimeId] : undefined;
    const fallback = runtimes.find((runtime) => runtime.id === runtimeId)?.permissions[0]?.id;
    return {
      model: saved?.model ?? "",
      permissionMode: saved?.permissionMode || fallback || "default",
    };
  };

  useEffect(() => {
    setModelDraft(optionsFor(selectedRuntime?.id).model);
    // 切换运行时时同步草稿；配置变化（保存成功）时也以保存值为准。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRuntime?.id, config?.runtimeOptions]);

  const patchConfig = (patch: Partial<AgentConfig>) => {
    setConfig((current) => (current ? { ...current, ...patch } : current));
  };

  /** Persists the whole config; called on blur / runtime switch. */
  const commit = async (patch?: Partial<AgentConfig>) => {
    const base = config;
    if (!base) return;
    const next = { ...base, ...(patch ?? {}) };
    setConfig(next);
    try {
      const { config: saved } = await agentApi.configSet({
        runtimeId: next.runtimeId,
        binaryPath: next.binaryPath,
        promptTemplate: next.promptTemplate,
        readyQuietMs: finiteOr(next.readyQuietMs, 900),
        readyTimeoutMs: finiteOr(next.readyTimeoutMs, 15_000),
        idleCompleteMs: finiteOr(next.idleCompleteMs, 180_000),
        runtimeOptions: next.runtimeOptions,
      });
      setConfig(saved);
      // Keep the "current agent" labels in the bug list / drawer in sync.
      window.dispatchEvent(new Event("agent:runtime-changed"));
    } catch (error) {
      toast("error", String(error));
    }
  };

  const selectRuntime = async (runtimeId: string) => {
    const runtime = runtimes.find((item) => item.id === runtimeId);
    if (
      !config ||
      !runtime ||
      !runtime.available ||
      runtime.id === config.runtimeId
    )
      return;
    setSaving(true);
    // 可执行路径只有一个，切换运行时同时切回该运行时的默认命令。
    patchConfig({ runtimeId: runtime.id, binaryPath: runtime.binary });
    try {
      await commit({ runtimeId: runtime.id, binaryPath: runtime.binary });
    } finally {
      setSaving(false);
    }
  };

  /** 保存当前运行时的默认模型 / 权限；任务提交时仍可单独覆盖。 */
  const storeRuntimeOptions = async (patch: Partial<AgentRuntimeOptions>) => {
    if (!config || !selectedRuntime) return;
    const nextOptions = { ...optionsFor(selectedRuntime.id), ...patch };
    const runtimeOptions = {
      ...(config.runtimeOptions ?? {}),
      [selectedRuntime.id]: nextOptions,
    };
    patchConfig({ runtimeOptions });
    await commit({ runtimeOptions });
  };

  const commitModel = () => {
    if (!selectedRuntime) return;
    const next = modelDraft.trim();
    if (next === optionsFor(selectedRuntime.id).model) return;
    setModelDraft(next);
    void storeRuntimeOptions({ model: next });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-4xl space-y-4 pb-2">
        <section className={cardClass}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-ui-caption font-normal text-slate-800">
                默认 Agent
              </h3>
              <p className="mt-0.5 text-ui-xs leading-4 text-slate-400">
                缺陷详情的「用 Agent 修复」与修复队列默认使用这个运行时。
              </p>
            </div>
            <span className="text-ui-xs text-slate-400">
              {snapshot?.checkedAt
                ? `上次检测 ${formatDateTime(snapshot.checkedAt)}`
                : "尚未检测本机 Agent"}
              <span>&nbsp;&nbsp;</span>
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={13} />}
                loading={scanning}
                onClick={() => void refresh(true)}
              >
                检测
              </Button>
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!config || !selectedRuntime ? (
              <span className="flex items-center gap-2 text-ui-caption text-slate-400">
                <Spinner />
                正在读取运行时…
              </span>
            ) : (
              <AgentPicker
                className="w-full max-w-lg"
                runtimes={runtimes}
                value={config.runtimeId}
                byRuntime={byRuntime}
                hasScan={Boolean(snapshot)}
                disabled={saving}
                onChange={(runtimeId) => void selectRuntime(runtimeId)}
              />
            )}
            {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          </div>

          {selectedRuntime &&
          snapshot &&
          !selectedScan?.found &&
          selectedRuntime.id !== "custom" ? (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-ui-sm leading-5 text-amber-800">
              <TriangleAlert
                size={13}
                className="mt-0.5 shrink-0 text-amber-600"
              />
              该 Agent 未在本机 PATH
              中检测到。安装后点「刷新检测」，或把下方的可执行路径改成绝对路径。
            </p>
          ) : null}
        </section>

        <AgentExecutionCard toast={toast} />

        {config && selectedRuntime ? (
          <section className={cardClass}>
            <h3 className="text-ui-caption font-normal text-slate-800">运行参数</h3>
            <p className="mt-0.5 text-ui-xs leading-4 text-slate-400">
              默认模型与访问权限；提交任务时仍可按任务覆盖，留空表示用 CLI 默认值。
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="min-w-[240px] flex-1">
                <span className="mb-1 block text-ui-xs text-slate-500">默认模型</span>
                <input
                  value={modelDraft}
                  list={`settings-agent-model-${selectedRuntime.id}`}
                  onChange={(event) => setModelDraft(event.target.value)}
                  onBlur={commitModel}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  placeholder="留空使用运行时的默认模型"
                  spellCheck={false}
                  className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-ui-caption text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
                />
                <datalist id={`settings-agent-model-${selectedRuntime.id}`}>
                  {selectedRuntime.models.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </label>
              {selectedRuntime.permissions.length > 1 ? (
                <label className="min-w-[190px]">
                  <span className="mb-1 block text-ui-xs text-slate-500">访问权限</span>
                  <select
                    value={optionsFor(selectedRuntime.id).permissionMode}
                    onChange={(event) =>
                      void storeRuntimeOptions({ permissionMode: event.target.value })
                    }
                    className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-ui-caption text-slate-700 transition focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
                  >
                    {selectedRuntime.permissions.map((option) => (
                      <option key={option.id} value={option.id} title={option.description}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {selectedRuntime.permissions.length > 1 ? (
              <p className="mt-2 text-ui-xs leading-4 text-slate-400">
                {selectedRuntime.permissions.find(
                  (option) => option.id === optionsFor(selectedRuntime.id).permissionMode,
                )?.description ?? ""}
              </p>
            ) : null}
          </section>
        ) : null}

        {!config || !selectedRuntime ? (
          <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
            <Spinner />
            读取 Agent 运行时…
          </div>
        ) : (
          <>
            <section className={cardClass}>
              <AgentSettings
                key={selectedRuntime.id}
                config={config}
                runtime={selectedRuntime}
                onChange={patchConfig}
                onCommit={commit}
                toast={toast}
              />
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className={cardClass}>
                <Lifecycle stages={selectedRuntime.lifecycle} />
              </section>
              <section className={cardClass}>
                <Capabilities runtime={selectedRuntime} />
              </section>
            </div>

            <section className={cardClass}>
              <Limitations runtime={selectedRuntime} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Lifecycle({
  stages,
}: {
  stages: AgentRuntimeDescriptor["lifecycle"];
}) {
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-ui-caption font-normal text-slate-800">
        <Workflow size={13} className="text-slate-400" />
        生命周期
      </h3>
      <ol className="mt-2 space-y-1.5">
        {stages.map((stage, index) => (
          <li
            key={stage.key}
            className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-2"
          >
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface font-mono text-ui-xs text-slate-500 border border-border">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1" title={stage.description}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-ui-sm text-slate-700">{stage.label}</span>
                {stage.needsHuman ? <Badge tone="amber">需人工</Badge> : null}
                {stage.terminal ? <Badge tone="neutral">终态</Badge> : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Capabilities({ runtime }: { runtime: AgentRuntimeDescriptor }) {
  const items: Array<[string, boolean, string]> = [
    [
      "终端交互",
      runtime.capabilities.interactiveTerminal,
      "PTY 输出与键盘输入",
    ],
    ["权限请求", runtime.capabilities.permissionPrompt, "运行时可暂停等待授权"],
    [
      "桌面回执",
      runtime.capabilities.externalDecision,
      "桌面/通知窗口的确认能被运行时接受",
    ],
    ["提交前审核", runtime.capabilities.commitReview, "复杂改动可暂停等待审核"],
  ];

  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-ui-caption font-normal text-slate-800">
        <Check size={13} className="text-slate-400" />
        能力声明
      </h3>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {items.map(([label, supported, hint]) => (
          <div
            key={label}
            className="flex items-start gap-2 rounded-lg border border-slate-100 px-2.5 py-2"
            title={hint}
          >
            {supported ? (
              <Check size={12} className="mt-0.5 shrink-0 text-emerald-500" />
            ) : (
              <CircleSlash
                size={12}
                className="mt-0.5 shrink-0 text-slate-400"
              />
            )}
            <div className="text-ui-sm text-slate-700">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Limitations({ runtime }: { runtime: AgentRuntimeDescriptor }) {
  return (
    <section>
      <h3 className="flex items-center gap-1.5 text-ui-caption font-normal text-slate-800">
        <AlertTriangle size={13} className="text-amber-500" />
        互通限制
      </h3>
      <ul className="mt-2 space-y-1.5">
        {runtime.limitations.map((limitation) => (
          <li
            key={limitation}
            className="flex items-start gap-1.5 text-ui-sm leading-5 text-slate-600"
          >
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
            <span className="min-w-0">{limitation}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-ui-sm font-normal text-amber-900">
          <ShieldAlert size={13} className="text-amber-600" />
          无法互操作时
        </div>
        <p className="mt-1 text-ui-sm leading-5 text-amber-800">
          {runtime.fallback}
        </p>
      </div>
    </section>
  );
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
