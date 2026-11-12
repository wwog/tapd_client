import { useCallback, useEffect, useState } from "react";
import { GitBranch } from "lucide-react";

import { agentApi, type AgentConfig, type AgentTaskStatus } from "../lib/agent";
import { acquireAgentTasksStore, useAgentTasksStore } from "../lib/agentStore";
import type { ToastFn } from "../lib/feature";
import { Button, Spinner, Switch, cardClass, inputClass } from "./ui";

const MIN_UNITS = 1;
const MAX_UNITS = 8;

/** Task statuses that no longer hold the queue open. */
const TERMINAL_STATUSES: AgentTaskStatus[] = ["succeeded", "failed", "canceled"];

type Props = {
  toast: ToastFn;
};

/**
 * 设置页的「Agent 执行」条目：worktree 隔离开关与执行单元数量。
 *
 * 关闭 worktree 时后端固定单任务执行，所以这里显示 1 并禁用输入。队列里还有
 * 未结束任务时，后端拒绝切换 worktree（会改变已有任务的回写方式），因此开关
 * 在看板上锁并说明原因；执行单元仍可调整。
 *
 * 开关和数字都立即落库，成功后界面已更新，无需额外提示。
 */
export function AgentExecutionCard({ toast }: Props) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  // Draft of the number input: only written back to config after a successful
  // save, so a failed request cannot leave the UI showing an unpersisted value.
  const [units, setUnits] = useState("2");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const tasksState = useAgentTasksStore();
  useEffect(() => acquireAgentTasksStore(), []);
  // Any non-terminal task locks the worktree switch; the backend enforces it.
  const queueBusy = (tasksState?.tasks ?? []).some(
    (task) => !TERMINAL_STATUSES.includes(task.status),
  );

  const load = useCallback(() => {
    setLoadError(null);
    void agentApi
      .configGet()
      .then(({ config: loaded }) => {
        setConfig(loaded);
        setUnits(String(loaded.executionUnits ?? 2));
      })
      .catch((cause) => {
        setLoadError(String(cause));
        toast("error", String(cause));
      });
  }, [toast]);

  useEffect(() => load(), [load]);

  const save = useCallback(
    async (patch: Partial<AgentConfig>) => {
      if (!config || saving) return;
      const previous = config;
      setConfig({ ...config, ...patch });
      setSaving(true);
      try {
        const { config: saved } = await agentApi.configSet(patch);
        setConfig(saved);
        setUnits(String(saved.executionUnits ?? 2));
      } catch (cause) {
        setConfig(previous);
        setUnits(String(previous.executionUnits ?? 2));
        toast("error", String(cause));
      } finally {
        setSaving(false);
      }
    },
    [config, saving, toast],
  );

  const worktreeEnabled = config?.worktreeEnabled ?? false;
  const displayedUnits = worktreeEnabled ? units : "1";

  const commitUnits = () => {
    if (!config || !worktreeEnabled) return;
    const parsed = Number(units);
    if (!Number.isFinite(parsed)) {
      setUnits(String(config.executionUnits ?? 2));
      return;
    }
    const next = Math.min(MAX_UNITS, Math.max(MIN_UNITS, Math.round(parsed)));
    setUnits(String(next));
    if (next === config.executionUnits) return;
    void save({ executionUnits: next });
  };

  return (
    <section className={cardClass}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
            <GitBranch size={15} className="text-slate-400" />
            Agent 执行
          </h2>
          <p className="mt-1 text-ui-caption leading-5 text-slate-500">
            控制本地 Agent 任务的并行方式与代码隔离。
          </p>
        </div>
        {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
      </header>

      {loadError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm text-rose-700">
          <span className="min-w-0 flex-1 truncate" title={loadError}>
            {loadError}
          </span>
          <Button size="sm" variant="secondary" onClick={load}>
            重试
          </Button>
        </div>
      ) : !config ? (
        <span className="mt-4 flex items-center gap-2 text-ui-caption text-slate-400">
          <Spinner />
          正在读取配置…
        </span>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
            title={
              queueBusy
                ? undefined
                : "每个任务在独立 git worktree 中运行，完成后保留提交分支。"
            }
          >
            <span className="text-ui-sm text-slate-600">Worktree 隔离</span>
            <Switch
              checked={worktreeEnabled}
              label="Worktree 隔离"
              disabled={saving || queueBusy}
              onChange={(value) => {
                if (value) setUnits(String(config.executionUnits ?? 2));
                void save({ worktreeEnabled: value });
              }}
            />
          </div>

          <label
            className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
            title={worktreeEnabled ? "允许 1–8 个任务并行，默认 2。" : "关闭 Worktree 时固定为 1。"}
          >
            <span className="flex items-center gap-1.5 text-ui-sm text-slate-600">
              执行单元
            </span>
            <input
              type="number"
              min={MIN_UNITS}
              max={MAX_UNITS}
              step={1}
              value={displayedUnits}
              disabled={!worktreeEnabled || saving}
              onChange={(event) => setUnits(event.target.value)}
              onBlur={commitUnits}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className={`${inputClass} mt-1.5 font-mono disabled:cursor-not-allowed disabled:opacity-50`}
            />
          </label>
        </div>
      )}

      {config && queueBusy ? (
        <p className="mt-2 text-ui-xs leading-4 text-slate-500">
          队列中有任务，完成后才能切换 Worktree。
        </p>
      ) : null}
    </section>
  );
}
