import { useState } from "react";
import {
  Copy,
  FileJson,
  FolderOpen,
  Info,
  PackageOpen,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";

import { api, type AppInfo } from "../lib/api";
import { pickExportDir } from "../lib/exportDir";
import type { SettingsSectionProps } from "../lib/feature";
import { AgentExecutionCard } from "./AgentExecutionCard";
import { AppearanceCard } from "./AppearanceCard";
import { CapturesPage } from "./CapturesPage";
import { DefaultAgentCard } from "./DefaultAgentCard";
import { Dialog } from "./Dialog";
import { NotificationSettings } from "./NotificationSettings";
import { Button, cardClass } from "./ui";

type Props = {
  info: AppInfo | null;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
  onShowOnboarding: () => void;
  /** 跳到 Agent 页 →「配置」，查看全部运行时。 */
  onManageAgents: () => void;
  toast: SettingsSectionProps["toast"];
};

export function SettingsPage(props: Props) {
  const { info, onOpenPath, onCopy, onShowOnboarding, onManageAgents, toast } = props;
  const [capturesOpen, setCapturesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearLocalData = async () => {
    setClearing(true);
    try {
      await api.clearAppData();
    } catch (error) {
      setClearing(false);
      toast("error", String(error));
    }
  };

  const exportDiagnostics = async () => {
    setDiagnosing(true);
    try {
      const dir = await pickExportDir(info?.paths.exportsDir);
      if (!dir) return;
      const result = await api.exportDiagnostics(dir);
      // Opening the destination is the success signal; toasts stay reserved
      // for failures.
      onOpenPath(result.folder);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setDiagnosing(false);
    }
  };

  const paths: Array<[string, string]> = info
    ? [
        ["数据目录", info.paths.dataDir],
        ["日志目录", info.paths.logsDir],
        ["抓包目录", info.paths.capturesDir],
        ["导出目录", info.paths.exportsDir],
        ["配置文件", info.paths.configFile],
        ["runtime.json", info.paths.runtimeFile],
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <AppearanceCard />

      <DefaultAgentCard toast={toast} onManageAgents={onManageAgents} />

      <AgentExecutionCard toast={toast} />

      <NotificationSettings toast={toast} />

      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <ShieldCheck size={15} className="text-slate-400" />
              运行信息
            </h2>
            <p className="mt-1 truncate text-ui-caption text-slate-500">
              {info
                ? `v${info.version} · MCP ${
                    info.runtimePort ? `127.0.0.1:${info.runtimePort}` : "未启动"
                  }`
                : "正在读取运行信息…"}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDetailsOpen(true)}
            icon={<Info size={13} />}
          >
            查看详情
          </Button>
        </div>
      </section>

      {detailsOpen ? (
        <Dialog
          title="运行信息"
          icon={<ShieldCheck size={15} className="text-slate-400" />}
          onClose={() => setDetailsOpen(false)}
          action={
            <Button
              size="sm"
              onClick={() => void exportDiagnostics()}
              loading={diagnosing}
              icon={<PackageOpen size={13} />}
            >
              导出诊断包
            </Button>
          }
        >
          <dl className="mt-3 space-y-1 text-ui-caption">
            <PlainRow label="版本" value={info?.version ?? "—"} onCopy={onCopy} />
            <PlainRow
              label="MCP 本地端口"
              value={info?.runtimePort ? `127.0.0.1:${info.runtimePort}` : "未启动"}
              onCopy={onCopy}
            />
          </dl>

          <div className="mt-4 divide-y divide-slate-100">
            {paths.map(([label, value]) => (
              <div key={label} className="flex items-center gap-3 py-2 text-ui-caption">
                <span className="w-24 shrink-0 text-slate-400">{label}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-ui-sm text-slate-600"
                  title={value}
                >
                  {value}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenPath(value)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
                >
                  <FolderOpen size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onCopy(value)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
                >
                  <Copy size={11} />
                </button>
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}

      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="flex items-center gap-2 text-ui-base text-slate-900"
              title="删除应用数据目录下的全部配置、离线缓存、日志、抓包与 Agent 任务记录，然后自动重启应用。导出目录不受影响。"
            >
              <Trash2 size={15} className="text-slate-400" />
              本地数据
            </h2>
            {info ? (
              <p
                className="mt-1 truncate font-mono text-ui-sm text-slate-400"
                title={info.paths.dataDir}
              >
                {info.paths.dataDir}
              </p>
            ) : null}
          </div>
          {confirmClear ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={clearing}
                onClick={() => setConfirmClear(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={clearing}
                onClick={() => void clearLocalData()}
              >
                确认清理
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={13} />}
              onClick={() => setConfirmClear(true)}
            >
              清理缓存
            </Button>
          )}
        </div>
        {confirmClear ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-600">
            操作不可撤销：引导进度、MCP 策略、Agent 任务与离线缓存都会被清除。TAPD Cookie
            保存在 WebView 会话中，如需退出登录请使用账户页。
          </p>
        ) : null}
      </section>

      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <FileJson size={15} className="text-slate-400" />
              接口历史
            </h2>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCapturesOpen(true)}
            icon={<FileJson size={13} />}
          >
            打开历史
          </Button>
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <Sparkles size={15} className="text-slate-400" />
              新手引导
            </h2>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onShowOnboarding}
            icon={<Sparkles size={13} />}
          >
            查看引导
          </Button>
        </div>
      </section>

      {capturesOpen ? (
        <Dialog
          title="接口历史"
          icon={<FileJson size={15} className="text-slate-400" />}
          onClose={() => setCapturesOpen(false)}
          size="wide"
        >
          <CapturesPage toast={toast} onOpenPath={onOpenPath} />
        </Dialog>
      ) : null}
    </div>
  );
}

function PlainRow(props: { label: string; value: string; onCopy: (text: string) => void }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <dt className="w-24 shrink-0 text-slate-400">{props.label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-ui-sm text-slate-600">{props.value}</dd>
      <button
        type="button"
        onClick={() => props.onCopy(props.value)}
        className="text-slate-300 transition hover:text-slate-500"
      >
        <Copy size={11} />
      </button>
    </div>
  );
}

