import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bell,
  Bot,
  Bug,
  Check,
  Loader2,
  Plug,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";

import appIcon from "../assets/app-icon.png";
import { api, type AppInfo } from "../lib/api";

type Props = {
  info: AppInfo;
  onDone: () => void;
};

/* --------------------------------------------------------------------------
 * Tiny fake product shots. They are plain DOM/SVG so they stay crisp without
 * shipping extra screenshots.
 * ----------------------------------------------------------------------- */

function NotificationArt() {
  return (
    <div className="relative h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-slate-100 via-sky-50 to-white p-3">
      <div className="absolute right-3 top-3 flex h-5 items-center gap-1 rounded-full bg-slate-900 px-2 text-[7px] text-slate-200 ">
        <span className="h-1 w-1 rounded-full bg-emerald-400" />
        TAPD 待命
      </div>
      <div className="mt-7 w-[82%] rounded-lg bg-slate-900 p-2  ">
        <div className="flex items-center gap-1">
          <span className="grid h-4 w-4 place-items-center rounded bg-sky-500 text-white">
            <Bug size={9} />
          </span>
          <span className="h-1 w-10 rounded bg-white/25" />
          <span className="ml-auto h-1 w-4 rounded bg-white/10" />
        </div>
        <div className="mt-1.5 h-1 w-full rounded bg-white/30" />
        <div className="mt-1 h-1 w-3/4 rounded bg-white/15" />
        <div className="mt-2 flex gap-1">
          <span className="h-3 flex-1 rounded bg-sky-500" />
          <span className="h-3 flex-1 rounded bg-white/10" />
        </div>
      </div>
      <span className="absolute right-5 top-12 h-2 w-2 rounded-full bg-rose-500 border-2 border-white" />
      <Bell size={13} className="absolute bottom-3 right-4 text-slate-300" />
    </div>
  );
}

function FocusArt() {
  return (
    <div className="h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-emerald-50 via-white to-sky-50 p-2.5">
      <div className="flex h-full gap-1.5 rounded-lg bg-surface p-1.5  border border-border/70">
        <div className="flex w-6 flex-col items-center gap-1 rounded-md bg-slate-50 py-1">
          <span className="h-2 w-2 rounded bg-sky-400" />
          <span className="h-2 w-2 rounded bg-slate-200" />
          <span className="h-2 w-2 rounded bg-slate-200" />
          <span className="mt-auto h-3 w-3 rounded-full bg-gradient-to-br from-sky-400 to-emerald-400" />
        </div>
        <div className="flex w-[74px] flex-col gap-1">
          <span className="h-1 w-8 rounded bg-slate-300" />
          <span className="mt-0.5 h-3.5 w-full rounded bg-sky-50 border border-sky-200" />
          <span className="h-3.5 w-full rounded bg-slate-50" />
          <span className="h-3.5 w-full rounded bg-slate-50" />
          <span className="h-3.5 w-4/5 rounded bg-slate-50" />
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded-md bg-slate-50 p-1.5">
          <span className="h-1 w-9 rounded bg-slate-300" />
          <span className="h-1 w-full rounded bg-slate-200" />
          <span className="h-1 w-5/6 rounded bg-slate-200" />
          <span className="mt-auto h-3 w-10 rounded bg-slate-900/80" />
        </div>
      </div>
    </div>
  );
}

function FixArt() {
  return (
    <div className="relative h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-sky-50 via-white to-violet-50">
      <div className="absolute left-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-2xl bg-surface  border border-border">
        <div className="relative">
          <Bot size={26} className="text-slate-800" strokeWidth={1.8} />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </div>
      </div>
      <div className="absolute right-3 top-1/2 w-28 -translate-y-1/2 rounded-lg bg-slate-900 p-2  ">
        <div className="h-1 w-10 rounded bg-white/30" />
        <div className="mt-1 h-1 w-16 rounded bg-white/15" />
        <div className="mt-2 inline-flex h-4 items-center gap-1 rounded bg-emerald-400 px-1.5 text-[6px] font-normal text-slate-900">
          <Sparkles size={7} />
          自动修复
        </div>
      </div>
    </div>
  );
}

function McpArt() {
  return (
    <div className="relative h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-slate-900 to-slate-800 p-3 text-slate-200">
      <span className="absolute left-3 top-2.5 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        {"{ }"}
      </span>
      <span className="absolute bottom-2.5 left-3 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        {"</>"}
      </span>
      <span className="absolute right-3 top-2.5 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        AI
      </span>
      <span className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl bg-sky-500 text-white  ">
        <Plug size={16} />
      </span>
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 180 108"
        fill="none"
        aria-hidden="true"
      >
        <path d="M25 25 L78 48" stroke="rgba(56,189,248,.35)" strokeWidth="1" />
        <path d="M25 84 L78 62" stroke="rgba(56,189,248,.25)" strokeWidth="1" />
        <path d="M155 25 L104 48" stroke="rgba(52,211,153,.3)" strokeWidth="1" />
      </svg>
    </div>
  );
}

const FEATURES: Array<{
  title: string;
  copy: string;
  art: ReactNode;
}> = [
  {
    title: "新 bug 通知",
    copy: "新缺陷、转派、重开，胶囊立刻提醒。",
    art: <NotificationArt />,
  },
  {
    title: "专注工作",
    copy: "列表、详情、筛选，一个窗口搞定。",
    art: <FocusArt />,
  },
  {
    title: "一键修复",
    copy: "交给 Agent，修完自动回写 TAPD。",
    art: <FixArt />,
  },
  {
    title: "MCP 给外部",
    copy: "opencode / Claude / Cursor 直接接入。",
    art: <McpArt />,
  },
];

export function Onboarding({ info, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.completeOnboarding();
      onDone();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-theme="light" className="fixed inset-0 z-[90] grid place-items-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="max-h-[calc(100vh-2rem)] w-full max-w-[720px] overflow-y-auto rounded-3xl bg-surface  border border-black/5">
        <div className="relative overflow-hidden bg-gradient-to-br from-sky-50 via-white to-emerald-50 px-7 pb-6 pt-7">
          <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-sky-200/50 blur-3xl" />
          <div className="pointer-events-none absolute -left-20 bottom-0 h-44 w-44 rounded-full bg-emerald-200/40 blur-3xl" />

          <div className="relative flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-surface  border border-black/5">
              <img
                src={appIcon}
                alt="TAPD 客户端"
                draggable={false}
                className="h-9 w-9 select-none object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="text-ui-xs font-normal uppercase tracking-[0.18em] text-sky-600/70">
                TAPD Client · V{info.version}
              </div>
              <h2 className="mt-0.5 text-[21px] font-normal tracking-tight text-slate-900">
                {step === 0 ? "你的工作从未如此轻松" : "安全，默认在本地"}
              </h2>
              <p className="mt-0.5 text-ui-sm text-slate-500">
                {step === 0
                  ? "像微信聊天一样处理你的事物"
                  : "登录态、缓存和写操作都在本机闭环"}
              </p>
            </div>
          </div>
        </div>

        <div className="flex min-h-[380px] flex-col justify-center px-7 py-5">
          {step === 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-2xl border border-slate-100 bg-surface p-3 transition hover:border-border "
                >
                  {feature.art}
                  <div className="mt-3 text-ui-base font-normal text-slate-900">
                    {feature.title}
                  </div>
                  <div className="mt-0.5 text-ui-sm leading-5 text-slate-500">
                    {feature.copy}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-100 bg-surface p-4">
                  <div className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
                    <ShieldCheck size={16} className="text-emerald-500" />
                    安全
                  </div>
                  <ul className="mt-3 space-y-2 text-ui-sm leading-5 text-slate-600">
                    <li className="flex gap-2">
                      <Check size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                      Cookie 只存在隐藏 WebView，不上传。
                    </li>
                    <li className="flex gap-2">
                      <Check size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                      MCP 只监听 127.0.0.1，token 每次启动轮换。
                    </li>
                    <li className="flex gap-2">
                      <Check size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                      写操作可关闭、逐条审计，不记录正文。
                    </li>
                  </ul>
                </div>

                <div className="rounded-2xl border border-slate-100 bg-surface p-4">
                  <div className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
                    <Workflow size={16} className="text-sky-500" />
                    实现方式
                  </div>
                  <ul className="mt-3 space-y-2 text-ui-sm leading-5 text-slate-600">
                    <li className="flex gap-2">
                      <Check size={12} className="mt-0.5 shrink-0 text-sky-500" />
                      WebView 复用登录态 → SQLite 快照 → 界面。
                    </li>
                    <li className="flex gap-2">
                      <Check size={12} className="mt-0.5 shrink-0 text-sky-500" />
                      MCP sidecar ↔ 本地回环 ↔ 桌面客户端。
                    </li>
                    <li className="flex gap-2">
                      <Check size={12} className="mt-0.5 shrink-0 text-sky-500" />
                      Agent 在本机 opencode 执行，权限手动批准。
                    </li>
                  </ul>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-ui-xs text-slate-400">
                <span className="rounded-full bg-surface px-2 py-0.5">TAPD WebView</span>
                <ArrowRight size={10} />
                <span className="rounded-full bg-surface px-2 py-0.5">SQLite</span>
                <ArrowRight size={10} />
                <span className="rounded-full bg-surface px-2 py-0.5">界面</span>
                <span className="mx-1 h-3 w-px bg-slate-200" />
                <span className="rounded-full bg-surface px-2 py-0.5">AI</span>
                <ArrowRight size={10} />
                <span className="rounded-full bg-surface px-2 py-0.5">MCP</span>
                <ArrowRight size={10} />
                <span className="rounded-full bg-surface px-2 py-0.5">本机 App</span>
              </div>
            </div>
          )}

          {error ? (
            <div className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-ui-sm text-rose-700 border border-rose-100">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-7 py-4">
          <button
            type="button"
            onClick={() => void finish()}
            disabled={busy}
            className="text-ui-sm text-slate-400 transition hover:text-slate-600 disabled:opacity-40"
          >
            跳过
          </button>

          <div className="flex items-center gap-1.5">
            {[0, 1].map((index) => (
              <button
                key={index}
                type="button"
                aria-label={`第 ${index + 1} 页`}
                onClick={() => setStep(index)}
                className={
                  index === step
                    ? "h-1.5 w-5 rounded-full bg-sky-500 transition-all"
                    : "h-1.5 w-1.5 rounded-full bg-slate-300 transition-all hover:bg-slate-400"
                }
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step === 0 ? (
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-ui-sm font-normal text-primary-foreground transition hover:bg-primary-hover"
              >
                下一步
                <ArrowRight size={12} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finish()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3 py-1.5 text-ui-sm font-normal text-white transition hover:bg-sky-400 disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ShieldCheck size={12} />
                )}
                开始使用
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
