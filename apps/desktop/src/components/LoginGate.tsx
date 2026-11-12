import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowUpCircle,
  Bell,
  Bot,
  Bug,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Video,
} from "lucide-react";

import appIcon from "../assets/app-icon.png";
import { api, type AppInfo, type LoginQrState } from "../lib/api";
import { CodeRain } from "./CodeRain";

type Props = {
  info: AppInfo | null;
  onRefresh: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
};

const EMPTY_STATE: LoginQrState = {
  phase: "loading",
  qrUrl: null,
  name: null,
  avatarUrl: null,
  corp: null,
  message: "正在连接隐藏会话窗口",
};

/** Soft floating app glyphs on the brand side. */
const FLOATING_CHIPS: Array<{
  icon: ReactNode;
  position: string;
  tone: string;
  delay: string;
  rotate: string;
}> = [
  {
    icon: <Bug size={18} />,
    position: "left-[18%] top-[12%]",
    tone: "text-amber-500",
    delay: "0s",
    rotate: "-9deg",
  },
  {
    icon: <Video size={18} />,
    position: "left-[63%] top-[18%]",
    tone: "text-sky-500",
    delay: "1.4s",
    rotate: "7deg",
  },
  {
    icon: <MessageSquare size={17} />,
    position: "left-[13%] top-[33%]",
    tone: "text-emerald-500",
    delay: "2.6s",
    rotate: "5deg",
  },
  {
    icon: <Bell size={17} />,
    position: "left-[3%] top-[49%]",
    tone: "text-violet-500",
    delay: "0.8s",
    rotate: "10deg",
  },
  {
    icon: <QrCode size={18} />,
    position: "left-[84%] top-[47%]",
    tone: "text-slate-700",
    delay: "3.4s",
    rotate: "-6deg",
  },
  {
    icon: <Plus size={18} />,
    position: "left-[84%] top-[27%]",
    tone: "text-cyan-500",
    delay: "2s",
    rotate: "12deg",
  },
];

/** Brand-side status capsule: one message per interval, with a wobble first. */
const CAPSULE_SHAKE_MS = 420;
const CAPSULE_HOLD_MS = 860;

function phaseCopy(state: LoginQrState, refreshing: boolean): { title: string; hint: string } {
  if (refreshing) {
    return { title: "正在刷新二维码", hint: "马上就好，请稍候" };
  }

  switch (state.phase) {
    case "scanned":
      return {
        title: "已扫码，正在登录",
        hint: "正在浏览器中建立 TAPD 会话",
      };
    case "expired":
      return {
        title: "二维码已过期",
        hint: "正在自动为你刷新二维码",
      };
    case "error":
      return {
        title: "登录页暂时不可用",
        hint: state.message ?? "请重新加载登录页后重试",
      };
    case "qr":
      return {
        title: "请使用企业微信扫码登录",
        hint: "扫描后在手机上确认即可",
      };
    default:
      return {
        title: "正在接入 TAPD 登录",
        hint: state.message ?? "正在加载企业微信二维码",
      };
  }
}

export function LoginGate({ info, onRefresh, onToast }: Props) {
  const [state, setState] = useState<LoginQrState>(EMPTY_STATE);
  const [refreshing, setRefreshing] = useState(false);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [capsuleIndex, setCapsuleIndex] = useState(0);
  const [capsuleShaking, setCapsuleShaking] = useState(false);
  const avatar = state.avatarUrl;
  const displayName = state.name?.trim();
  const cachedAvatar = useRef<string | null>(null);

  // Shake the capsule, swap the copy, hold briefly, then shake it again.
  useEffect(() => {
    let shake: number | undefined;
    let next: number | undefined;
    const step = () => {
      setCapsuleIndex((index) => index + 1);
      setCapsuleShaking(true);
      shake = window.setTimeout(() => setCapsuleShaking(false), CAPSULE_SHAKE_MS);
      next = window.setTimeout(step, CAPSULE_SHAKE_MS + CAPSULE_HOLD_MS);
    };
    next = window.setTimeout(step, CAPSULE_SHAKE_MS + CAPSULE_HOLD_MS);
    return () => {
      if (shake !== undefined) window.clearTimeout(shake);
      if (next !== undefined) window.clearTimeout(next);
    };
  }, []);


  useEffect(() => {
    setAvatarBroken(false);
  }, [avatar]);

  // The WeCom scan panel exposes the signed-in user's avatar before TAPD
  // finishes the login. Cache it so the account view and sidebar can show it
  // immediately (and offline) after entering the app.
  useEffect(() => {
    const next = avatar?.trim();
    if (!next || next === cachedAvatar.current || next === info?.meAvatar) return;
    cachedAvatar.current = next;
    void api.cacheAvatar(next).catch(() => undefined);
  }, [avatar, info?.meAvatar]);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const next = await api.loginState();
        if (!alive) return;
        setState(next);
      } catch {
        // The hidden webview is navigating; keep the last projected state.
      }
      if (alive) {
        timer = window.setTimeout(poll, 900);
      }
    };

    void poll();

    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await api.reloadLogin();
    } catch (error) {
      onToast("error", String(error));
    } finally {
      window.setTimeout(() => setRefreshing(false), 1400);
    }
  };

  const showQr = !refreshing && state.phase === "qr" && Boolean(state.qrUrl);
  const showScanned = !refreshing && state.phase === "scanned";
  const copy = phaseCopy(state, refreshing);

  const capsules = [
    {
      icon: <Bot size={15} />,
      tone: "text-emerald-300",
      text: "TAPD Agent 运行中",
    },
    {
      icon: <ArrowUpCircle size={15} />,
      tone: "text-sky-300",
      text: info ? `TAPD v${info.version} 升级` : "TAPD 客户端已就绪",
    },
    {
      icon: <RefreshCw size={15} />,
      tone: "text-slate-300",
      text: "缺陷 · 需求 · 迭代 已同步",
    },
  ];
  const capsule = capsules[capsuleIndex % capsules.length];

  return (
    <div data-theme="light" className="relative flex h-full overflow-hidden bg-surface text-slate-900">
      {/* macOS traffic lights live over this strip; the whole strip drags. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-30 h-11" />

      {/* Brand pane */}
      <aside className="relative hidden w-[45%] min-w-[340px] shrink-0 flex-col overflow-hidden border-r border-slate-100 bg-[#f3f6fa] md:flex">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-28 top-8 h-80 w-80 rounded-full bg-sky-200/60 blur-3xl" />
          <div className="absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-emerald-200/50 blur-3xl" />
          <div className="login-breathe absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-white/80 blur-2xl" />
        </div>

        <div className="pointer-events-none absolute inset-0 z-10">
          {FLOATING_CHIPS.map((chip) => (
            <div
              key={chip.position}
              className={`login-float absolute grid h-12 w-12 place-items-center ${chip.position}`}
              style={
                {
                  animationDelay: chip.delay,
                  "--rot": chip.rotate,
                } as CSSProperties
              }
            >
              <span className={chip.tone}>{chip.icon}</span>
            </div>
          ))}
        </div>

        <div className="relative z-10 flex flex-1 items-center justify-center px-10 pt-16">
          <div className="relative -translate-y-2">
            <div className="login-breathe absolute -inset-20 rounded-full bg-sky-100/50 blur-2xl" />
            <div
              className={`relative flex h-[42px] w-[252px] items-center justify-center gap-2.5 rounded-full bg-[#0b1220] ${
                capsuleShaking ? "login-capsule-shake" : ""
              }`}
            >
              <span className={`grid place-items-center ${capsule.tone}`}>{capsule.icon}</span>
              <span className="whitespace-nowrap text-[15px] font-normal tracking-tight text-white">
                {capsule.text}
              </span>
            </div>
            <div className="mt-8 flex items-center justify-center gap-2 text-ui-sm text-slate-400">
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              让缺陷、需求与研发进度保持同步
              <span className="h-1 w-1 rounded-full bg-slate-300" />
            </div>
          </div>
        </div>

        <div className="relative z-10 px-10 pb-10">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white  border border-black/5">
              <img
                src={appIcon}
                alt="TAPD 客户端"
                draggable={false}
                className="h-9 w-9 select-none object-contain"
              />
            </div>
            <div>
              <div className="text-[17px] font-normal tracking-tight text-slate-900">
                欢迎来到 TAPD 客户端
              </div>
              <div className="mt-0.5 text-ui-sm text-slate-500">
                一站式 AI Agent 工作流
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Login pane */}
      <section className="relative flex min-w-0 flex-1 overflow-y-auto px-6 pb-6 pt-12">
        <div className="m-auto w-full max-w-[394px]">
          <header className="text-center">
            <h1 className="text-[26px] font-normal tracking-tight text-slate-900">
              TAPD 桌面端
            </h1>
          </header>

          <div className="relative mt-6 flex justify-center">
            <div className="absolute -inset-5 rounded-[36px] bg-gradient-to-br from-sky-100/80 via-white to-emerald-50/80 blur-xl" />

            <div className="relative rounded-[28px] bg-gradient-to-br from-sky-200/80 via-white to-emerald-100/80 p-[1.5px] ">
              <div className="rounded-[26.5px] bg-white p-3">
                <div className="relative aspect-square w-[clamp(190px,30vh,248px)] overflow-hidden rounded-[18px] bg-white">
                  {showQr ? (
                    <img
                      key={state.qrUrl ?? "qr"}
                      src={state.qrUrl ?? ""}
                      alt="企业微信登录二维码"
                      draggable={false}
                      className="h-full w-full select-none object-contain bg-white p-1.5"
                    />
                  ) : showScanned ? (
                    <div className="flex h-full flex-col items-center justify-center gap-4 bg-white px-5 text-center">
                      <div className="relative">
                        <div className="absolute -inset-2 animate-ping rounded-full bg-sky-200/50" />
                        {avatar && !avatarBroken ? (
                          <img
                            src={avatar}
                            alt={displayName ?? "扫码用户"}
                            draggable={false}
                            onError={() => setAvatarBroken(true)}
                            className="relative h-[68px] w-[68px] rounded-full object-cover  border-2 border-white"
                          />
                        ) : (
                          <div className="relative grid h-[68px] w-[68px] place-items-center rounded-full bg-sky-50 text-sky-500 border-2 border-white">
                            <CheckCircle2 size={30} />
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="truncate text-ui-lg font-normal text-slate-900">
                          {displayName || "扫码成功"}
                        </div>
                        {state.corp ? (
                          <div className="mt-0.5 truncate text-ui-sm text-slate-400">
                            {state.corp}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5 text-ui-sm font-normal text-sky-600">
                        <Loader2 size={13} className="animate-spin" />
                        正在完成登录…
                      </div>
                    </div>
                  ) : (
                    <>
                      <CodeRain className="absolute inset-0 h-full w-full" active />
                      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,transparent_18%,rgba(2,8,16,0.62)_100%)]" />
                      <div className="pointer-events-none absolute inset-0 grid place-items-center px-5">
                        <div className="rounded-2xl border border-sky-300/15 bg-black/30 px-4 py-3 text-center backdrop-blur-sm">
                          <div className="flex items-center justify-center gap-1.5 text-[11.5px] font-normal text-sky-100">
                            <Loader2 size={12} className="animate-spin" />
                            {copy.title}
                          </div>
                          <div className="mt-1 font-mono text-ui-2xs uppercase tracking-[0.16em] text-sky-200/45">
                            securing session
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="absolute -bottom-3 right-4 flex items-center gap-1 rounded-full border border-border bg-white px-2.5 py-1 text-ui-xs font-normal text-slate-500 ">
              <QrCode size={11} className="text-sky-500" />
              企业微信
            </div>
          </div>

          <div className="mt-5 text-center">
            <div className="flex items-center justify-center gap-1.5 text-[13.5px] font-normal text-slate-700">
              {state.phase === "error" ? (
                <ShieldCheck size={14} className="text-rose-400" />
              ) : state.phase === "scanned" ? (
                <CheckCircle2 size={14} className="text-emerald-500" />
              ) : (
                <Smartphone size={14} className="text-sky-500" />
              )}
              {copy.title}
            </div>
            <div className="mt-1 text-ui-sm text-slate-400">{copy.hint}</div>
          </div>

          <div className="mt-4 rounded-2xl bg-slate-50/90 px-5 py-3.5 border border-slate-100">
            <ol className="space-y-1.5 text-[12.5px] leading-6 text-slate-600">
              <li className="flex gap-2">
                <span className="w-3 shrink-0 text-slate-400">1.</span>
                打开手机「企业微信」，扫描上方二维码
              </li>
              <li className="flex gap-2">
                <span className="w-3 shrink-0 text-slate-400">2.</span>
                在手机上确认登录
              </li>
              <li className="flex gap-2">
                <span className="w-3 shrink-0 text-slate-400">3.</span>
                登录完成后自动进入客户端
              </li>
            </ol>
          </div>

          <div className="mt-4 flex items-center justify-center gap-4 text-ui-sm">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1 font-normal text-sky-600 transition hover:text-sky-700 disabled:opacity-50"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
              刷新二维码
            </button>
            <span className="h-3 w-px bg-slate-200" />
            <button
              type="button"
              onClick={onRefresh}
              className="text-slate-400 transition hover:text-slate-600"
            >
              重新检测登录状态
            </button>
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-ui-xs text-slate-300">
            <span className="h-px w-8 bg-slate-200" />
            V{info?.version ?? "0.1.0"}
            <span className="h-px w-8 bg-slate-200" />
          </div>
        </div>
      </section>
    </div>
  );
}
