import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Bell, Bot, Clock, RefreshCw, Send } from "lucide-react";

import type { SettingsSectionProps } from "../lib/feature";
import { bugTitle } from "../lib/bug";
import {
  AI_TONE_LABELS,
  DEFAULT_NOTIFICATION_SETTINGS,
  formatPollTime,
  notificationApi,
  type AiTone,
  type NotificationItem,
  type NotificationSettings as NotificationSettingsValue,
  type NotificationStateSnapshot,
} from "../lib/notification";
import { Badge, Button, Switch, cardClass } from "./ui";
import { usePoll } from "../hooks/usePoll";

/** Last snapshot, so re-entering Settings paints before the silent refresh. */
let cachedSnapshot: NotificationStateSnapshot | null = null;

export function NotificationSettings({ toast }: SettingsSectionProps) {
  const [settings, setSettings] = useState<NotificationSettingsValue>(
    () => cachedSnapshot?.settings ?? DEFAULT_NOTIFICATION_SETTINGS,
  );
  const [snapshot, setSnapshot] = useState<NotificationStateSnapshot | null>(
    () => cachedSnapshot,
  );
  const [loading, setLoading] = useState(() => cachedSnapshot === null);
  const [simulating, setSimulating] = useState(false);
  const [debugTitle, setDebugTitle] = useState("测试通知");
  const [debugBody, setDebugBody] = useState("这是一条来自设置页的调试通知。");
  const [debugTone, setDebugTone] = useState<AiTone>("success");
  const [debugActions, setDebugActions] = useState(true);
  const [debugSending, setDebugSending] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      try {
        const state = await notificationApi.state();
        cachedSnapshot = state;
        setSettings(state.settings);
        setSnapshot(state);
      } catch (error) {
        if (!silent) toast("error", String(error));
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh while the panel is open so debug notifications' action results
  // appear without a manual reload; stop while the window is hidden.
  usePoll(() => load(true), 4000, { pauseWhenHidden: true });

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /** Applying a value persists it right away — there is no save button. */
  const persist = async (nextValue: NotificationSettingsValue) => {
    setSettings(nextValue);
    try {
      const result = await notificationApi.settingsSet(nextValue);
      setSettings(result.settings);
      await load(true);
    } catch (error) {
      toast("error", String(error));
    }
  };

  const patch = (partial: Partial<NotificationSettingsValue>) => {
    void persist({ ...settingsRef.current, ...partial });
  };

  const patchQuietHours = (
    partial: Partial<NotificationSettingsValue["quietHours"]>,
  ) => {
    const current = settingsRef.current;
    void persist({
      ...current,
      quietHours: { ...current.quietHours, ...partial },
    });
  };

  /** Text/number fields keep local state while typing and save on blur. */
  const saveOnBlur = () => {
    void persist(settingsRef.current);
  };

  const simulate = async () => {
    setSimulating(true);
    try {
      await notificationApi.simulate({});
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSimulating(false);
    }
  };

  const sendDebug = async () => {
    setDebugSending(true);
    try {
      await notificationApi.aiDebug({
        title: debugTitle.trim() || "测试通知",
        tone: debugTone,
        body: debugBody.trim() || undefined,
        // Repeated debug sends replace the previous card instead of stacking.
        tag: "settings-debug",
        actions: debugActions
          ? [
              { id: "confirm", label: "确认", style: "primary" },
              { id: "cancel", label: "取消", style: "secondary" },
            ]
          : [],
      });
      await load(true);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setDebugSending(false);
    }
  };

  /** AI cards stay in memory, so `state` returns both pending and resolved. */
  const aiItems = (snapshot?.items ?? [])
    .filter((item) => item.source === "ai")
    .slice(0, 4);

  return (
    <section className={cardClass}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
            <Bell size={15} className="text-slate-400" />
            新缺陷通知
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {loading ? (
            <Badge tone="neutral">读取中</Badge>
          ) : snapshot?.running ? (
            <Badge tone="green">轮询中</Badge>
          ) : (
            <Badge tone="amber">已暂停</Badge>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
          <div>
            <div
              className="text-ui-caption text-slate-800"
              title="关闭后停止轮询与弹窗，已有待处理通知仍保留。"
            >
              启用新缺陷通知
            </div>
          </div>
          <Switch
            checked={settings.enabled}
            onChange={(value) => patch({ enabled: value })}
            label="启用新缺陷通知"
          />
        </div>

        <div>
          <div className="text-ui-sm font-normal text-slate-600">通知范围</div>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            <ScopeOption
              active={settings.scope === "mine"}
              title="只通知分配给我的"
              description="处理人等于当前 TAPD 用户"
              onClick={() => patch({ scope: "mine" })}
            />
            <ScopeOption
              active={settings.scope === "project"}
              title="项目内所有新缺陷"
              description="当前项目内的新分配与重开"
              onClick={() => patch({ scope: "project" })}
            />
          </div>
        </div>

        <div>
          <div className="text-ui-sm font-normal text-slate-600">通知类型</div>
          <div className="mt-1.5 divide-y divide-slate-100 rounded-xl border border-slate-100">
            <SwitchRow
              label="纯新建"
              description="本轮新创建且分配给我的缺陷"
              checked={settings.includeNew}
              onChange={(value) => patch({ includeNew: value })}
            />
            <SwitchRow
              label="转派给我"
              description="非新建，但处理人刚刚变成我"
              checked={settings.includeTransferred}
              onChange={(value) => patch({ includeTransferred: value })}
            />
            <SwitchRow
              label="重新打开"
              description="状态从其它值变为重新打开"
              checked={settings.includeReopened}
              onChange={(value) => patch({ includeReopened: value })}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-100 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div
                className="flex items-center gap-1.5 text-ui-caption text-slate-800"
                title="opencode、Claude Code 等可调用 tapd_notify_user，在胶囊里提示成功、失败或等待确认。"
              >
                <Bot size={12} className="text-slate-400" />
                允许 AI / MCP 唤起通知
              </div>
            </div>
            <Switch
              checked={settings.aiEnabled}
              onChange={(value) => patch({ aiEnabled: value })}
              label="允许 AI 通知"
            />
          </div>

          {/* 通知测试完毕，暂时注释 */
          /* <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/70 p-2.5">
            <div className="flex items-center justify-between">
              <div
                className="text-ui-sm text-slate-700"
                title="卡片会出现在屏幕顶部"
              >
                调试通知
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(Object.keys(AI_TONE_LABELS) as AiTone[]).map((tone) => (
                <button
                  key={tone}
                  type="button"
                  onClick={() => setDebugTone(tone)}
                  className={clsx(
                    "rounded-full border px-2 py-0.5 text-ui-xs transition",
                    AI_TONE_CHIP[tone],
                    debugTone === tone
                      ? "border-slate-400"
                      : "opacity-70 hover:opacity-100",
                  )}
                >
                  {AI_TONE_LABELS[tone]}
                </button>
              ))}
            </div>

            <input
              value={debugTitle}
              onChange={(event) => setDebugTitle(event.target.value)}
              placeholder="标题"
              className="mt-2 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200"
            />
            <textarea
              value={debugBody}
              onChange={(event) => setDebugBody(event.target.value)}
              rows={2}
              placeholder="正文（可换行）"
              className="mt-1.5 w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200"
            />

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-ui-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={debugActions}
                  onChange={(event) => setDebugActions(event.target.checked)}
                  className="h-3 w-3 rounded border-slate-300"
                />
                带「确认 / 取消」按钮
              </label>
              <Button
                size="sm"
                loading={debugSending}
                onClick={() => void sendDebug()}
                icon={<Send size={12} />}
              >
                发送调试通知
              </Button>
            </div>

            {aiItems.length > 0 ? (
              <div className="mt-2 space-y-0.5 border-t border-border/70 pt-1.5">
                {aiItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 text-ui-xs text-slate-500"
                  >
                    <span className="min-w-0 flex-1 truncate" title={bugTitle(item.title)}>
                      {bugTitle(item.title)}
                    </span>
                    <span className="shrink-0 text-slate-400">{aiResultLabel(item)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div> */}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label
            className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
            title="允许 20–600 秒，默认 30。"
          >
            <span className="flex items-center gap-1.5 text-ui-sm text-slate-600">
              <RefreshCw size={11} className="text-slate-400" />
              轮询间隔（秒）
            </span>
            <input
              type="number"
              min={20}
              max={600}
              step={10}
              value={settings.pollIntervalSecs}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  pollIntervalSecs: Number(event.target.value) || 30,
                }))
              }
              onBlur={saveOnBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200"
            />
          </label>

          <label
            className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"
            title="超出部分保持待处理，处理一条后自动补位。"
          >
            <span className="text-ui-sm text-slate-600">同时展示数量</span>
            <select
              value={settings.maxVisible}
              onChange={(event) =>
                patch({ maxVisible: Number(event.target.value) })
              }
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200"
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value} 条
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rounded-xl border border-slate-100 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div
              className="flex items-center gap-1.5 text-ui-caption text-slate-800"
              title="时段内只累计待处理通知，不弹窗；时段结束后自动显示未处理通知。"
            >
              <Clock size={12} className="text-slate-400" />
              免打扰
            </div>
            <Switch
              checked={settings.quietHours.enabled}
              onChange={(value) => patchQuietHours({ enabled: value })}
              label="启用免打扰"
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            <input
              type="time"
              value={settings.quietHours.start}
              disabled={!settings.quietHours.enabled}
              onChange={(event) =>
                patchQuietHours({ start: event.target.value })
              }
              className="rounded-lg border border-border px-2 py-1.5 text-ui-caption text-slate-700 disabled:bg-slate-50 disabled:text-slate-400 focus:outline-2 focus:outline-sky-200"
            />
            <span className="text-ui-sm text-slate-400">至</span>
            <input
              type="time"
              value={settings.quietHours.end}
              disabled={!settings.quietHours.enabled}
              onChange={(event) => patchQuietHours({ end: event.target.value })}
              className="rounded-lg border border-border px-2 py-1.5 text-ui-caption text-slate-700 disabled:bg-slate-50 disabled:text-slate-400 focus:outline-2 focus:outline-sky-200"
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
          <div className="grid gap-1 text-ui-sm text-slate-500 sm:grid-cols-2">
            <div>
              上次轮询：
              <span className="ml-1 font-mono text-slate-700">
                {formatPollTime(snapshot?.lastPollAt ?? null)}
              </span>
            </div>
            <div className="min-w-0 truncate">
              待处理：
              <span className="ml-1 text-slate-700">
                {
                  (snapshot?.items ?? []).filter(
                    (item) => item.state === "pending",
                  ).length
                }{" "}
                条
              </span>
            </div>
          </div>
          {snapshot?.lastError ? (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-ui-xs leading-4 text-rose-700">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span className="break-all">{snapshot.lastError}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const AI_TONE_CHIP: Record<AiTone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  error: "border-rose-200 bg-rose-50 text-rose-700",
  progress: "border-sky-200 bg-sky-50 text-sky-700",
};

function aiResultLabel(item: NotificationItem): string {
  const resolution = item.ai?.resolution;
  if (!resolution) return item.state === "pending" ? "待操作" : "—";
  if (resolution.kind === "action") {
    return `已点击 ${resolution.actionLabel ?? resolution.actionId ?? ""}`.trim();
  }
  if (resolution.kind === "dismissed") return "已关闭";
  if (resolution.kind === "replaced") return "已替换";
  return resolution.kind;
}

function ScopeOption(props: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.description}
      className={clsx(
        "rounded-xl border px-3 py-2 text-left transition",
        props.active
          ? "border-sky-300 bg-sky-50/60 "
          : "border-border bg-surface hover:border-slate-300",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "grid h-3.5 w-3.5 place-items-center rounded-full border",
            props.active ? "border-sky-500" : "border-slate-300",
          )}
        >
          {props.active ? (
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
          ) : null}
        </span>
        <span className="text-ui-caption font-normal text-slate-800">
          {props.title}
        </span>
      </div>
    </button>
  );
}

function SwitchRow(props: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="text-ui-caption text-slate-700" title={props.description}>
        {props.label}
      </div>
      <Switch
        checked={props.checked}
        onChange={props.onChange}
        label={props.label}
      />
    </div>
  );
}
