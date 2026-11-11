import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Bot,
  Check,
  CircleSlash,
  Settings2,
  ShieldAlert,
  Workflow,
} from "lucide-react";

import {
  agentApi,
  type AgentConfig,
  type AgentRuntimeDescriptor,
} from "../lib/agent";
import type { SettingsSectionProps } from "../lib/feature";
import { AgentSettings } from "./AgentSettings";
import { Dialog } from "./Dialog";
import { Badge, Button, Spinner, cardClass } from "./ui";

type Props = {
  toast: SettingsSectionProps["toast"];
};

/**
 * Settings entry for the agent runtime: a single row card with a "管理" action
 * that opens the runtime picker, config form, declared lifecycle and
 * interoperability limits. Only opencode is in the catalog today.
 */
export function AgentManagement({ toast }: Props) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void Promise.all([agentApi.configGet(), agentApi.runtimes()])
      .then(([configResult, runtimeResult]) => {
        setConfig(configResult.config);
        setRuntimes(runtimeResult.runtimes);
      })
      .catch((error) => toast("error", String(error)));
  }, [toast]);

  const selectedRuntime =
    runtimes.find((runtime) => runtime.id === config?.runtimeId) ?? runtimes[0] ?? null;

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
      });
      setConfig(saved);
      // Keep the "current agent" labels in the bug list / drawer in sync.
      window.dispatchEvent(new Event("agent:runtime-changed"));
    } catch (error) {
      toast("error", String(error));
    }
  };

  const selectRuntime = (runtime: AgentRuntimeDescriptor) => {
    if (!config || !runtime.available || runtime.id === config.runtimeId) return;
    // 可执行路径只有一个，切换运行时同时切回该运行时的默认命令。
    patchConfig({ runtimeId: runtime.id, binaryPath: runtime.binary });
    void commit({ runtimeId: runtime.id, binaryPath: runtime.binary });
  };

  const summary = config && selectedRuntime
    ? `${selectedRuntime.name} · ${config.binaryPath || selectedRuntime.binary} · 串行队列`
    : "正在读取 Agent 运行时…";

  return (
    <>
      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <Bot size={15} className="text-slate-400" />
              Agent 管理
            </h2>
            <p className="mt-1 truncate text-ui-caption text-slate-500" title={summary}>
              {summary}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Settings2 size={13} />}
            onClick={() => setOpen(true)}
            disabled={!config}
          >
            管理
          </Button>
        </div>
      </section>

      {open ? (
        <Dialog
          title="Agent 管理"
          icon={<Bot size={15} className="text-slate-400" />}
          onClose={() => setOpen(false)}
          size="wide"
          bodyScroll={false}
          action={
            selectedRuntime ? (
              <Badge tone="blue">当前：{selectedRuntime.name}</Badge>
            ) : null
          }
        >
          {!config || !selectedRuntime ? (
            <div className="flex items-center gap-2 py-10 text-ui-caption text-slate-400">
              <Spinner />
              读取 Agent 运行时…
            </div>
          ) : (
            <div className="flex h-full min-h-0 gap-4">
              <aside className="w-[232px] shrink-0 overflow-y-auto overscroll-contain">
                <div className="text-ui-xs font-normal text-slate-400">
                  运行时
                </div>
                <div className="mt-2 space-y-1.5">
                  {runtimes.map((runtime) => (
                    <button
                      key={runtime.id}
                      type="button"
                      disabled={!runtime.available}
                      onClick={() => selectRuntime(runtime)}
                      title={runtime.description}
                      className={clsx(
                        "w-full rounded-xl border px-3 py-2.5 text-left transition",
                        runtime.id === config.runtimeId
                          ? "border-sky-400 bg-sky-50"
                          : "border-border bg-surface hover:border-slate-300 hover:bg-slate-50",
                        !runtime.available && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-ui-caption font-normal text-slate-800">
                          {runtime.name}
                        </span>
                        <Badge tone={runtime.available ? "green" : "neutral"}>
                          {runtime.available ? "已支持" : "即将支持"}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-ui-xs text-slate-400">
                        {runtime.vendor} · {runtime.binary}
                      </div>
                    </button>
                  ))}
                </div>
              </aside>

              <div className="min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain border-l border-slate-100 pl-4">
                <AgentSettings
                  key={selectedRuntime.id}
                  config={config}
                  runtime={selectedRuntime}
                  onChange={patchConfig}
                  onCommit={commit}
                  toast={toast}
                />

                <Lifecycle stages={selectedRuntime.lifecycle} />
                <Capabilities runtime={selectedRuntime} />
                <Limitations runtime={selectedRuntime} />
              </div>
            </div>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

function Lifecycle({ stages }: { stages: AgentRuntimeDescriptor["lifecycle"] }) {
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
                <span className="text-ui-sm text-slate-700">
                  {stage.label}
                </span>
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
    ["终端交互", runtime.capabilities.interactiveTerminal, "PTY 输出与键盘输入"],
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
              <CircleSlash size={12} className="mt-0.5 shrink-0 text-slate-400" />
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
        <p className="mt-1 text-ui-sm leading-5 text-amber-800">{runtime.fallback}</p>
      </div>
    </section>
  );
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
