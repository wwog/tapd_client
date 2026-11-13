import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Minus, Plus, Star } from "lucide-react";

import {
  api,
  asApiError,
  type AgentConfig,
  type AgentRuntimeDescriptor,
  type NotificationSettings,
} from "../lib/api";
import { useAgentTasks } from "../lib/agentTasks";
import { useDesktopPresence } from "../lib/heartbeat";
import { localeTag, t, type LocaleMode } from "../lib/i18n";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  setPrefs,
  usePrefs,
  type ThemeMode,
} from "../lib/prefs";
import { navigate } from "../lib/router";
import { clearSession } from "../lib/session";

const PROJECT_URL = "https://github.com/wwog/tapd_client";

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
        aria-label={t("mobile.settings.decrease", { label: props.label })}
        title={t("mobile.settings.decrease", { label: props.label })}
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
        aria-label={t("mobile.settings.increase", { label: props.label })}
        title={t("mobile.settings.increase", { label: props.label })}
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
        title={t("mobile.settings.loadErrorHint")}
      >
        {props.error}
      </p>
    );
  }
  if (props.loading) {
    return (
      <p className="border-b border-border py-2.5 text-ui-caption text-slate-400 last:border-b-0">
        {t("mobile.settings.loadingDesktop")}
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

type SettingsCache = {
  agentConfig: AgentConfig | null;
  notif: NotificationSettings | null;
  runtimes: AgentRuntimeDescriptor[];
};

/** Last values from the previous Settings visit. Re-entering renders these
    immediately and refreshes from the desktop silently. */
let settingsCache: SettingsCache | null = null;

const rememberSettings = (patch: Partial<SettingsCache>): void => {
  settingsCache = {
    agentConfig:
      patch.agentConfig !== undefined
        ? patch.agentConfig
        : (settingsCache?.agentConfig ?? null),
    notif:
      patch.notif !== undefined ? patch.notif : (settingsCache?.notif ?? null),
    runtimes:
      patch.runtimes !== undefined
        ? patch.runtimes
        : (settingsCache?.runtimes ?? []),
  };
};

/** Companion preferences live only on this phone; the desktop is read-write
    through feature commands, every change commits immediately (no save
    button), failures revert and stay on screen. */
export function SettingsPage() {
  const prefs = usePrefs();
  const presence = useDesktopPresence();
  const { state: agentTasksState } = useAgentTasks();

  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(
    () => settingsCache?.agentConfig ?? null,
  );
  const [notif, setNotif] = useState<NotificationSettings | null>(
    () => settingsCache?.notif ?? null,
  );
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>(
    () => settingsCache?.runtimes ?? [],
  );
  const [pendingLoads, setPendingLoads] = useState(() => (settingsCache ? 0 : 3));
  const [deskError, setDeskError] = useState<string | null>(null);

  // 桌面端配置：三项依次读取；任一失败都保留错误，成功项照常渲染。
  useEffect(() => {
    let cancelled = false;
    setDeskError(null);
    void (async () => {
      let failure: string | null = null;
      try {
        const config = await api.agentConfig();
        if (!cancelled) {
          setAgentConfig(config);
          rememberSettings({ agentConfig: config });
        }
      } catch (err) {
        failure = asApiError(err).message;
      }
      try {
        const { settings } = await api.notificationSettings();
        if (!cancelled) {
          setNotif(settings);
          rememberSettings({ notif: settings });
        }
      } catch (err) {
        failure = failure ?? asApiError(err).message;
      }
      try {
        const catalog = await api.agentRuntimes();
        if (!cancelled) {
          setRuntimes(catalog);
          rememberSettings({ runtimes: catalog });
        }
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
    const optimistic = { ...agentConfig, ...patch };
    setAgentConfig(optimistic);
    rememberSettings({ agentConfig: optimistic });
    try {
      const saved = await api.agentConfigSet(patch);
      setAgentConfig(saved);
      rememberSettings({ agentConfig: saved });
      setDeskError(null);
    } catch (err) {
      setAgentConfig(previous);
      rememberSettings({ agentConfig: previous });
      setDeskError(asApiError(err).message);
    }
  };

  // 通知设置：发送合并后的完整对象（桌面同形状），失败回滚。
  const patchNotif = async (patch: Partial<NotificationSettings>) => {
    if (!notif) return;
    const previous = notif;
    const next: NotificationSettings = { ...notif, ...patch };
    setNotif(next);
    rememberSettings({ notif: next });
    try {
      const { settings } = await api.notificationSettingsSet(next);
      setNotif(settings);
      rememberSettings({ notif: settings });
      setDeskError(null);
    } catch (err) {
      setNotif(previous);
      rememberSettings({ notif: previous });
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
    if (!window.confirm(t("mobile.settings.unpairConfirm"))) return;
    settingsCache = null;
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
          aria-label={t("mobile.nav.back")}
          onClick={back}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-ui-caption text-slate-900">{t("common.settings")}</span>
      </header>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <SettingRow label={t("mobile.settings.desktop")}>
          <span
            className="flex items-center gap-1.5 text-ui-caption text-slate-700"
            title={t("mobile.settings.heartbeatHint")}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                presence.online ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
            {presence.online
              ? t("mobile.settings.presenceOnline")
              : t("mobile.settings.presenceOffline")}
          </span>
        </SettingRow>
        <SettingRow label={t("mobile.settings.device")}>
          <span className="text-ui-caption text-slate-700">
            {presence.deviceName ?? "—"}
          </span>
        </SettingRow>
        <SettingRow label={t("mobile.settings.desktopVersion")}>
          <span className="text-ui-caption text-slate-700">
            {presence.version ? `v${presence.version}` : "—"}
          </span>
        </SettingRow>
        <SettingRow label={t("mobile.settings.lastSync")}>
          <span className="text-ui-caption tabular-nums text-slate-500">
            {presence.lastSync
              ? new Date(presence.lastSync).toLocaleTimeString(localeTag())
              : "—"}
          </span>
        </SettingRow>
      </section>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <SettingRow label={t("common.language")}>
          <Segmented<LocaleMode>
            label={t("common.language")}
            value={prefs.locale}
            onChange={(locale) => setPrefs({ locale })}
            options={[
              { value: "system", label: t("common.system") },
              { value: "zh", label: "中文" }, // i18n-exempt: language endonym
              { value: "en", label: "English" }, // i18n-exempt: language endonym
            ]}
          />
        </SettingRow>
        <SettingRow label={t("common.theme")}>
          <Segmented<ThemeMode>
            label={t("common.theme")}
            value={prefs.theme}
            onChange={(theme) => setPrefs({ theme })}
            options={[
              { value: "system", label: t("common.system") },
              { value: "light", label: t("common.light") },
              { value: "dark", label: t("common.dark") },
            ]}
          />
        </SettingRow>
        <SettingRow label={t("common.fontSize")}>
          <Stepper
            label={t("common.fontSize")}
            value={prefs.fontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            suffix="px"
            onChange={(value) => setPrefs({ fontSize: value })}
          />
        </SettingRow>
      </section>

      <h2 className="mx-4 mt-4 text-ui-sm text-slate-500">{t("mobile.settings.desktopSettings")}</h2>

      <DeskStatus error={deskError} loading={pendingLoads > 0 && !agentConfig && !notif} />

      <section
        className="mx-3 mt-2 rounded-2xl border border-border bg-surface px-4 py-1"
        title={t("mobile.settings.writeBackHint")}
      >
        <h3 className="border-b border-border py-2 text-ui-sm text-slate-500">{t("mobile.settings.agentExecution")}</h3>
        <SwitchRow
          label={t("mobile.settings.worktreeIsolation")}
          title={
            queueBusy
              ? t("mobile.settings.worktreeBusyHint")
              : t("mobile.settings.worktreeHint")
          }
          checked={worktreeEnabled}
          disabled={!agentConfig || queueBusy}
          onChange={(value) => void patchConfig({ worktreeEnabled: value })}
        />
        <SettingRow label={t("mobile.settings.executionUnits")}>
          <Stepper
            label={t("mobile.settings.executionUnits")}
            value={worktreeEnabled ? agentConfig?.executionUnits ?? 2 : 1}
            min={UNITS_MIN}
            max={UNITS_MAX}
            disabled={!agentConfig || !worktreeEnabled}
            onChange={(value) => void patchConfig({ executionUnits: value })}
          />
        </SettingRow>
        <SwitchRow
          label={t("mobile.settings.restoreQueued")}
          title={t("mobile.settings.restoreQueuedHint")}
          checked={agentConfig?.restoreQueuedTasks ?? false}
          disabled={!agentConfig}
          onChange={(value) => void patchConfig({ restoreQueuedTasks: value })}
        />
        <SettingRow label={t("mobile.settings.defaultRuntime")}>
          <select
            aria-label={t("mobile.settings.defaultRuntime")}
            title={t("mobile.settings.runtimeListHint")}
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
          <p className="py-2 text-ui-xs leading-4 text-slate-500" title={t("mobile.settings.worktreeLockHint")}>
            {t("mobile.settings.worktreeQueueBusy")}
          </p>
        ) : null}
      </section>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <h3 className="border-b border-border py-2 text-ui-sm text-slate-500">{t("mobile.settings.newBugNotifications")}</h3>
        <SwitchRow
          label={t("mobile.settings.enableNotifications")}
          title={t("mobile.settings.notificationsOffHint")}
          checked={notif?.enabled ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ enabled: value })}
        />
        <SettingRow label={t("mobile.settings.pollInterval")}>
          <Stepper
            label={t("mobile.settings.pollInterval")}
            value={notif?.pollIntervalSecs ?? 30}
            min={POLL_MIN}
            max={POLL_MAX}
            step={10}
            suffix={` ${t("common.seconds")}`}
            disabled={!notif}
            onChange={(value) => void patchNotif({ pollIntervalSecs: value })}
          />
        </SettingRow>
        <SwitchRow
          label={t("mobile.settings.newlyAssigned")}
          title={t("mobile.settings.newlyAssignedHint")}
          checked={notif?.includeNew ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ includeNew: value })}
        />
        <SwitchRow
          label={t("mobile.settings.reassigned")}
          title={t("mobile.settings.reassignedHint")}
          checked={notif?.includeTransferred ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ includeTransferred: value })}
        />
        <SwitchRow
          label={t("mobile.settings.reopened")}
          title={t("mobile.settings.reopenedHint")}
          checked={notif?.includeReopened ?? false}
          disabled={!notif}
          onChange={(value) => void patchNotif({ includeReopened: value })}
        />
        <SwitchRow
          label={t("mobile.settings.quietHours")}
          title={t("mobile.settings.quietHoursHint")}
          checked={notif?.quietHours.enabled ?? false}
          disabled={!notif}
          onChange={(value) => void patchQuietHours({ enabled: value })}
        />
        <SettingRow label={t("mobile.settings.hours")}>
          <span className="flex items-center gap-2">
            <input
              type="time"
              aria-label={t("mobile.settings.quietStart")}
              value={notif?.quietHours.start ?? "22:00"}
              disabled={!notif || !notif?.quietHours.enabled}
              onChange={(event) => void patchQuietHours({ start: event.target.value })}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200 disabled:opacity-40"
            />
            <span className="text-ui-sm text-slate-400">{t("mobile.settings.to")}</span>
            <input
              type="time"
              aria-label={t("mobile.settings.quietEnd")}
              value={notif?.quietHours.end ?? "09:00"}
              disabled={!notif || !notif?.quietHours.enabled}
              onChange={(event) => void patchQuietHours({ end: event.target.value })}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200 disabled:opacity-40"
            />
          </span>
        </SettingRow>
        <SettingRow label={t("mobile.settings.maxVisible")}>
          <Stepper
            label={t("mobile.settings.maxVisible")}
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
          title={t("mobile.settings.unpairHint")}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption text-rose-600 transition active:bg-overlay-soft"
        >
          {t("mobile.settings.unpair")}
        </button>
      </div>

      <div className="mx-3 mt-4 pb-2 text-center">
        <a
          href={PROJECT_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-ui-xs text-sky-600 underline decoration-sky-200 underline-offset-2 transition active:text-sky-700"
        >
          <Star size={11} />
          {t("mobile.settings.starOnGithub")}
        </a>
      </div>
    </div>
  );
}
