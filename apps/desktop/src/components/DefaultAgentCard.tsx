import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, TriangleAlert } from "lucide-react";

import { agentApi, type AgentConfig, type AgentRuntimeDescriptor } from "../lib/agent";
import { useAgentScan } from "../lib/agentScan";
import { formatDateTime } from "../lib/format";
import type { ToastFn } from "../lib/feature";
import { AgentPicker } from "./AgentPicker";
import { Button, Spinner, cardClass } from "./ui";

type Props = {
  toast: ToastFn;
  /** 打开完整的运行时管理面板，查看全部运行时与参数。 */
  onManageAgents: () => void;
};

/**
 * 设置页的「默认 Agent」条目。
 *
 * 这里只放一个运行时选择器和检测信息；全部运行时、参数与互通说明都在
 * 「管理全部运行时」面板里维护。
 */
export function DefaultAgentCard({ toast, onManageAgents }: Props) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [saving, setSaving] = useState(false);
  const { snapshot, byRuntime, loading: scanning, error: scanError, refresh } = useAgentScan();

  useEffect(() => {
    void Promise.all([agentApi.configGet(), agentApi.runtimes()])
      .then(([configResult, runtimeResult]) => {
        setConfig(configResult.config);
        setRuntimes(runtimeResult.runtimes);
      })
      .catch((cause) => toast("error", String(cause)));
  }, [toast]);

  const selected = config?.runtimeId ?? "";
  const selectedRuntime = runtimes.find((runtime) => runtime.id === selected) ?? null;
  const selectedScan = selected ? byRuntime.get(selected) : undefined;

  const select = useCallback(
    async (runtimeId: string) => {
      const runtime = runtimes.find((item) => item.id === runtimeId);
      if (!config || !runtime || saving || runtimeId === config.runtimeId) return;
      setSaving(true);
      // 可执行路径只有一个：切换默认运行时同时回填该运行时的默认命令。
      const next = { ...config, runtimeId, binaryPath: runtime.binary };
      setConfig(next);
      try {
        const { config: saved } = await agentApi.configSet({
          runtimeId,
          binaryPath: runtime.binary,
        });
        setConfig(saved);
        // 缺陷列表 / 详情里的「用 X 修复」立即跟着变。
        window.dispatchEvent(new Event("agent:runtime-changed"));
      } catch (cause) {
        setConfig(config);
        toast("error", String(cause));
      } finally {
        setSaving(false);
      }
    },
    [config, runtimes, saving, toast],
  );

  return (
    <section className={cardClass}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
            <Bot size={15} className="text-slate-400" />
            默认 Agent
          </h2>
          <p className="mt-1 text-ui-caption leading-5 text-slate-500">
            缺陷详情的「用 Agent 修复」和 Agent 队列默认使用该运行时。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={13} />}
            loading={scanning}
            onClick={() => void refresh(true)}
          >
            刷新检测
          </Button>
          <Button size="sm" variant="ghost" onClick={onManageAgents}>
            管理全部运行时
          </Button>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!config || !selectedRuntime ? (
          <span className="flex items-center gap-2 text-ui-caption text-slate-400">
            <Spinner />
            正在读取运行时…
          </span>
        ) : (
          <AgentPicker
            className="w-full max-w-md"
            runtimes={runtimes}
            value={selected}
            byRuntime={byRuntime}
            hasScan={Boolean(snapshot)}
            disabled={saving}
            onChange={(runtimeId) => void select(runtimeId)}
          />
        )}
        {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
        <span className="text-ui-xs text-slate-400">
          {snapshot?.checkedAt
            ? `上次检测 ${formatDateTime(snapshot.checkedAt)}`
            : "尚未检测本机 Agent"}
        </span>
      </div>

      {scanError ? (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-ui-sm text-rose-600">
          检测失败：{scanError}
        </p>
      ) : null}

      {selectedRuntime && snapshot && !selectedScan?.found && selectedRuntime.id !== "custom" ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-ui-sm leading-5 text-amber-800">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-600" />
          该 Agent 未在本机 PATH 中检测到。安装后点「刷新检测」，或到「管理全部运行时」里填写绝对路径。
        </p>
      ) : null}
    </section>
  );
}
