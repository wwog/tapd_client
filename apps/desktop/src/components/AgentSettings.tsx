import { useState } from "react";
import { Terminal } from "lucide-react";

import { agentApi, type AgentConfig, type AgentRuntimeDescriptor } from "../lib/agent";
import type { SettingsSectionProps } from "../lib/feature";
import { Badge, Button, inputClass } from "./ui";

const PROMPT_VARIABLES = [
  "{{title}}",
  "{{md_path}}",
  "{{repo_path}}",
  "{{workspace_name}}",
  "{{bug_id}}",
  "{{task_id}}",
  "{{severity}}",
  "{{priority}}",
  "{{project_rule}}",
  "{{coworker}}",
];

type Props = {
  config: AgentConfig;
  runtime: AgentRuntimeDescriptor;
  onChange: (patch: Partial<AgentConfig>) => void;
  onCommit: (patch?: Partial<AgentConfig>) => void;
  toast: SettingsSectionProps["toast"];
};

/**
 * Runtime configuration form. Owned by the Agent page's 配置 pane: it edits
 * the selected runtime (binary path, prompt template, timing) and auto-saves
 * on blur.
 */
export function AgentSettings({ config, runtime, onChange, onCommit, toast }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const result = await agentApi.detect(config.binaryPath || runtime.binary);
      setVersion(result.version);
    } catch (error) {
      setVersion(null);
      toast("error", String(error));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            className="text-ui-caption text-slate-800"
            title={`${runtime.name} · 修改后自动保存`}
          >
            运行时参数
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {version ? <Badge tone="green">{version}</Badge> : null}
          <Button
            size="sm"
            onClick={() => void handleDetect()}
            loading={detecting}
            icon={<Terminal size={13} />}
          >
            检测版本
          </Button>
        </div>
      </div>

      <div className="mt-3 space-y-4">
        <div>
          <label className="text-ui-sm font-normal text-slate-600">
            {runtime.name} 可执行路径
          </label>
          <input
            value={config.binaryPath}
            onChange={(event) => onChange({ binaryPath: event.target.value })}
            onBlur={() => onCommit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder={runtime.binary}
            className={`${inputClass} mt-1.5 font-mono`}
          />
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
          <div className="text-ui-xs text-slate-400">启动方式</div>
          <div className="mt-1 break-all font-mono text-ui-caption text-slate-700">
            {[config.binaryPath || runtime.binary, ...runtime.args].join(" ")}
            {runtime.promptInjection === "argv"
              ? " <提示词>"
              : runtime.promptInjection === "flag"
                ? ` ${runtime.promptFlag ?? "-i"} <提示词>`
                : "（启动后注入提示词）"}
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className="text-ui-sm text-slate-600"
              title="变量会替换为缺陷信息；{{project_rule}} 来自项目设置，{{coworker}} 来自同事页启用的同事（没有插槽时自动追加）。"
            >
              提示词模板
            </span>
            <span className="text-ui-xs text-slate-400">
              支持变量：{PROMPT_VARIABLES.join(" ")}
            </span>
          </div>
          <textarea
            value={config.promptTemplate}
            onChange={(event) => onChange({ promptTemplate: event.target.value })}
            onBlur={() => onCommit()}
            rows={10}
            className={`${inputClass} mt-1.5 resize-y leading-5`}
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {PROMPT_VARIABLES.map((variable) => (
              <span
                key={variable}
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-ui-xs text-slate-500"
              >
                {variable}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-ui-xs text-slate-400">
            当前启用 {config.coworkerIds?.length ?? 0} 位同事，任务开始时填入{" "}
            <span className="font-mono">{"{{coworker}}"}</span>；模板没有该变量时自动追加。
          </p>
        </div>

        <details className="rounded-xl border border-slate-100 bg-slate-50/50">
          <summary className="cursor-pointer select-none px-3 py-2 text-ui-sm text-slate-500">
            高级
          </summary>
          <div className="grid gap-3 p-3 pt-0 sm:grid-cols-2">
            <NumberField
              label="就绪静默（ms）"
              hint="输出静默达到该时长后注入任务"
              value={config.readyQuietMs}
              onChange={(value) => onChange({ readyQuietMs: value })}
              onCommit={() => onCommit()}
            />
            <NumberField
              label="就绪超时（ms）"
              hint="超时后强制注入"
              value={config.readyTimeoutMs}
              onChange={(value) => onChange({ readyTimeoutMs: value })}
              onCommit={() => onCommit()}
            />
            <NumberField
              label="静默完成（ms）"
              hint="通用 TUI 未调用 agent_task_report 时，输出静默多久视为本轮结束；0 表示关闭"
              value={config.idleCompleteMs}
              onChange={(value) => onChange({ idleCompleteMs: value })}
              onCommit={() => onCommit()}
            />
          </div>
        </details>
      </div>
    </section>
  );
}

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-slate-100 bg-slate-50/70 p-3"
      title={props.hint}
    >
      <div className="text-ui-xs text-slate-400">
        {props.label}
      </div>
      <input
        type="number"
        min={0}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(event) => props.onChange(Number(event.target.value))}
        onBlur={props.onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${inputClass} mt-1.5 font-mono`}
      />
      <div className="mt-1 text-ui-xs leading-4 text-slate-400">{props.hint}</div>
    </div>
  );
}
