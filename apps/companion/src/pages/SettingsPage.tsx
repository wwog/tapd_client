import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Minus, Plus } from "lucide-react";

import {
  api,
  asApiError,
  type AgentConfig,
  type AgentRuntimeDescriptor,
  type NotificationSettings,
} from "../lib/api";
import { useAgentTasks } from "../lib/agentTasks";
import { useDesktopPresence } from "../lib/heartbeat";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  setPrefs,
  usePrefs,
  type ThemeMode,
} from "../lib/prefs";
import { navigate } from "../lib/router";
import { clearSession } from "../lib/session";

/** Static segmented control: the active segment gets a selected surface. */
function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      className="inline-flex rounded-lg border border-border bg-slate-50 p-0.5"
    >
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(option.value)}
            className={`rounded-md px-3 py-1 text-ui-sm transition ${
              active ? "bg-selected text-slate-900" : "text-slate-500"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="shrink-0 text-ui-caption text-slate-700">{props.label}</span>
      {props.children}
    </div>
  );
}

/** 带说明的开关行（title 承载语义说明）。 */
function SwitchRow(props: {
  label: string;
  title?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingRow label={props.label}>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        title={props.title}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        className={`relative h-6 w-10 shrink-0 rounded-full border transition ${
          props.checked ? "border-sky-300 bg-sky-100" : "border-border bg-slate-100"
        } ${props.disabled ? "opacity-40" : "active:bg-overlay-soft"}`}
      >
        <span
          className={`absolute top-1/2 h-4.5 w-4.5 -translate-y-1/2 rounded-full transition-all ${
            props.checked ? "left-[calc(100%-20px)] bg-sky-500" : "left-0.5 bg-slate-400"
          }`}
        />
      </button>
    </SettingRow>
  );
}

/** 步进器：减号 / 数值 / 加号，移动端触控友好。 */
function Stepper(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const step = props.step ?? 1;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`减小${props.label}`}
        title={`减小${props.label}`}
        disabled={props.disabled || props.value - step < props.min}
        onClick={() => props.onChange(Math.max(props.min, props.value - step))}
        className="rounded-md border border-border bg-surface p-1 text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
      >
        <Minus size={14} />
      </button>
      <span className="w-12 text-center text-ui-caption text-slate-700 tabular-nums">
        {props.value}
        {props.suffix ?? ""}
      </span>
      <button
        type="button"
        aria-label={`增大${props.label}`}
        title={`增大${props.label}`}
        disabled={props.disabled || props.value + step > props.max}
        onClick={() => props.onChange(Math.min(props.max, props.value + step))}
        className="rounded-md border border-border bg-surface p-1 text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

/** 配置区的加载/错误行：失败信息保留在页面上，直到下一次成功。 */
function DeskStatus(props: { error: string | null; loading: boolean }) {
  if (props.error) {
    return (
      <p
        className="border-b border-border py-2.5 text-ui-sm leading-5 text-rose-600 last:border-b-0"
        title="读取桌面端配置失败；改动会回滚并在这里保留错误。"
      >
        {props.error}
      </p>
    );
  }
  if (props.loading) {
    return (
      <p className="border-b border-border py-2.5 text-ui-caption text-slate-400 last:border-b-0">
        正在读取桌面端配置…
      </p>
    );
  }
  return null;
}

const UNITS_MIN = 1;
const UNITS_MAX = 8;
const POLL_MIN = 20;
const POLL_MAX = 600;

/** 不再占据队列的任务状态（Worktree 开关的锁依据，与桌面一致）。 */
const TERMINAL_STATUSES = ["succeeded", "failed", "canceled"];

/** Companion preferences live only on this phone; the desktop is read-write
    through feature commands, every change commits immediately (no save
    button), failures revert and stay on screen. */
export function SettingsPage() {
  const prefs = usePrefs();
  const presence = useDesktopPresence();
  const { state: agentTasksState } = useAgentTasks();

  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [notif, setNotif] = useState<NotificationSettings | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [pendingLoads, setPendingLoads] = useState(3);
  const [deskError, setDeskError] = useState<string | null>(null);

  // 桌面端配置：三项依次读取；任一失败都保留错误，成功项照常渲染。
  useEffect(() => {
    let cancelled = false;
    setDeskError(null);
    void (async () => {
      let failure: string | null = null;
      try {
        const config = await api.agentConfig();
        if (!cancelled) setAgentConfig(config);
      } catch (err) {
        failure = asApiError(err).message;
      }
      try {
        const { settings } = await api.notificationSettings();
        if (!cancelled) setNotif(settings);
      } catch (err) {
        failure = failure ?? asApiError(err).message;
      }
      try {
        const catalog = await api.agentRuntimes();
        if (!cancelled) setRuntimes(catalog);
      } catch (err) {
        failure = failure ?? asApiError(err).message;
      }
      if (cancelled) return;
      if (failure) setDeskError(failure);
      setPendingLoads(0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Agent 配置：乐观更新，失败回滚并保留错误（无 toast，错误留在页面）。
  const patchConfig = async (patch: Partial<AgentConfig>) => {
    if (!agentConfig) return;
    const previous = agentConfig;
    setAgentConfig({ ...agentConfig, ...patch });
    try {
      const saved = await api.agentConfigSet(patch);
      setAgentConfig(saved);
      setDeskError(null);
    } catch (err) {
      setAgentConfig(previous);
      setDeskError(asApiError(err).message);
    }
  };

  // 通知设置：发送合并后的完整对象（桌面同形状），失败回滚。
  const patchNotif = async (patch: Partial<NotificationSettings>) => {
    if (!notif) return;
    const previous = notif;
    const next: NotificationSettings = { ...notif, ...patch };
    setNotif(next);
    try {
      const { settings } = await api.notificationSettingsSet(next);
      setNotif(settings);
      setDeskError(null);
    } catch (err) {
      setNotif(previous);
      setDeskError(asApiError(err).message);
    }
  };

  const patchQuietHours = (patch: Partial<NotificationSettings["quietHours"]>) => {
    if (!notif) return;
    void patchNotif({ quietHours: { ...notif.quietHours, ...patch } });
  };

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/bugs");
  };

  const unpair = () => {
    if (!window.confirm("解除配对后需要重新扫码，确定解除？")) return;
    clearSession();
    navigate("#/pair");
  };

  // 队列里有未结束任务时，桌面端会拒绝切换 Worktree；开关直接锁住。
  const queueBusy = (agentTasksState?.tasks ?? []).some(
    (task) => !TERMINAL_STATUSES.includes(task.status),
  );
  const worktreeEnabled = agentConfig?.worktreeEnabled ?? false;
  const availableRuntimes = runtimes.filter((runtime) => runtime.available);

  return (
    <div className="pb-6">
      <header className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label="返回"
          onClick={back}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-ui-caption text-slate-900">设置</span>
      </header>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <SettingRow label="桌面端">
          <span
            className="flex items-center gap-1.5 text-ui-caption text-slate-700"
            title="手机每 20 秒向桌面端发送一次心跳；连续两次未送达即显示掉线。"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                presence.online ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
            {presence.online ? "在线" : "掉线"}
          </span>
        </SettingRow>
        <SettingRow label="设备">
          <span className="text-ui-caption text-slate-700">
            {presence.deviceName ?? "—"}
          </span>
        </SettingRow>
        <SettingRow label="桌面版本">
          <span className="text-ui-caption text-slate-700">
            {presence.version ? `v${presence.version}` : "—"}
          </span>
        </SettingRow>
        <SettingRow label="最近同步">
          <span className="text-ui-caption tabular-nums text-slate-500">
            {presence.lastSync
              ? new Date(presence.lastSync).toLocaleTimeString("zh-CN")
              : "—"}
          </span>
        </SettingRow>
      </section>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <SettingRow label="主题">
          <Segmented<ThemeMode>
            label="主题"
            value={prefs.theme}
            onChange={(theme) => setPrefs({ theme })}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
          />
        </SettingRow>
        <SettingRow label="字号">
          <Stepper
            label="字号"
            value={prefs.fontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            suffix="px"
            onChange={(value) => setPrefs({ fontSize: value })}
          />
        </SettingRow>
      </section>

      <h2 className="mx-4 mt-4 text-ui-sm text-slate-500">桌面端配置</h2>

      <DeskStatus error={deskError} loading={pendingLoads > 0 && !agentConfig && !notif} />

      <section
        className="mx-3 mt-2 rounded-2xl border border-border bg-surface px-4 py-1"
        title="改动会立即写回桌面端；失败时恢复原值并显示错误。"
      >
        <h3 className="border-b border-border py-2 text-ui-sm text-slate-500">Agent 执行</h3>
        <SwitchRow
          label="Worktree 隔离"
          title={
            queueBusy
              ? "有活跃任务时切换会被桌面端拒绝，等队列清空后再试。"
              : "每个任务在独立 git worktree 中运行，完成后保留提交分支。"
          }
          checked={worktreeEnabled}
          disabled={!agentConfig || queueBusy}
          onChange={(value) => void patchConfig({ worktreeEnabled: value })}
        />
        <SettingRow label="执行单元">
          <Stepper
            label="执行单元"
            value={worktreeEnabled ? agentConfig?.executionUnits ?? 2 : 1}
            min={UNITS_MIN}
            max={UNITS_MAX}
            disabled={!agentConfig || !worktreeEnabled}
            onChange={(value) => void patchConfig({ executionUnits: value })}
          />
        </SettingRow>
        <SwitchRow
          label="启动恢复排队"
          title="桌面端重启后，之前排队的任务自动继续；关闭则保留队列但暂停，等你在桌面端手动继续。"
          checked={agentConfig?.restoreQueuedTasks ?? false}
          disabled={!agentConfig}
          onChange={(value) => void patchConfig({ restoreQueuedTasks: value })}
        />
        <SettingRow label="默认运行时">
          <select
            aria-label="默认运行时"
            title="只列出本机已安装（available）的运行时。"
            value={agentConfig?.runtimeId ?? ""}
            disabled={!agentConfig}
            onChange={(event) => void patchConfig({ runtimeId: event.target.value })}
            className="max-w-[60%] rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-slate-700 focus:outline-2 focus:outline-sky-200 disabled:opacity-40"
          >
            {availableRuntimes.length === 0 ? (
              <option value={agentConfig?.runtimeId ?? ""}>{agentConfig?.runtimeId || "—"}</option>
            ) : null}
            {availableRuntimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.name}
              </option>
            ))}
          </select>
        </SettingRow>
        {queueBusy ? (
          <p className="py-2 text-ui-xs leading-4 text-slate-500" title="与桌面端一致的锁：等队列清空后再切换。">
            队列中有任务，完成后才能切换 Worktree。
          </p>
        ) : null}
      </section>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <h3 className="border-b border-border py-2 text-ui-sm text-slate-500">新缺陷通知</h3>
        <SwitchRow
          label="启用通知"
          title="关闭后桌面端停止轮询与弹窗，已有待处理通知仍保留。"
          checked={notif?.enabled ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ enabled: value })}
        />
        <SettingRow label="轮询间隔">
          <Stepper
            label="轮询间隔"
            value={notif?.pollIntervalSecs ?? 30}
            min={POLL_MIN}
            max={POLL_MAX}
            step={10}
            suffix=" 秒"
            disabled={!notif}
            onChange={(value) => void patchNotif({ pollIntervalSecs: value })}
          />
        </SettingRow>
        <SwitchRow
          label="新分配"
          title="纯新建且分配给我的缺陷。"
          checked={notif?.includeNew ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ includeNew: value })}
        />
        <SwitchRow
          label="转派"
          title="非新建，但处理人刚刚变成我。"
          checked={notif?.includeTransferred ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ includeTransferred: value })}
        />
        <SwitchRow
          label="重新打开"
          title="状态从其它值变为重新打开。"
          checked={notif?.includeReopened ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ includeReopened: value })}
        />
        <SwitchRow
          label="免打扰"
          title="时段内只累计待处理通知，不弹窗；时段结束后自动显示。"
          checked={notif?.quietHours.enabled ?? false}
          disabled={!notif}
          onChange={(value) => void patchQuietHours({ enabled: value })}
        />
        <SettingRow label="时段">
          <span className="flex items-center gap-2">
            <input
              type="time"
              aria-label="免打扰开始"
              value={notif?.quietHours.start ?? "22:00"}
              disabled={!notif || !notif?.quietHours.enabled}
              onChange={(event) => void patchQuietHours({ start: event.target.value })}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200 disabled:opacity-40"
            />
            <span className="text-ui-sm text-slate-400">至</span>
            <input
              type="time"
              aria-label="免打扰结束"
              value={notif?.quietHours.end ?? "09:00"}
              disabled={!notif || !notif?.quietHours.enabled}
              onChange={(event) => void patchQuietHours({ end: event.target.value })}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200 disabled:opacity-40"
            />
          </span>
        </SettingRow>
        <SettingRow label="胶囊最多显示">
          <Stepper
            label="胶囊最多显示"
            value={notif?.maxVisible ?? 3}
            min={1}
            max={5}
            disabled={!notif}
            onChange={(value) => void patchNotif({ maxVisible: value })}
          />
        </SettingRow>
      </section>

      <div className="mx-3 mt-3">
        <button
          type="button"
          onClick={unpair}
          title="清除本机的配对会话，桌面端设备列表仍保留记录。"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption text-rose-600 transition active:bg-overlay-soft"
        >
          解除配对
        </button>
      </div>
    </div>
  );
}
