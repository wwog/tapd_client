import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Smartphone,
} from "lucide-react";
import { toDataURL } from "qrcode";

import {
  api,
  companionApi,
  type CompanionStatus,
  type CompanionTunnel,
  type PairingCode,
  type PairingMode,
} from "../lib/api";
import {
  cachedCompanionStatus,
  rememberCompanionStatus,
  setCompanionEnabledLocal,
} from "../lib/companion";
import type { SettingsSectionProps } from "../lib/feature";
import { usePoll } from "../hooks/usePoll";
import { useTauriEvent } from "../lib/tauriEvent";
import { Dialog } from "./Dialog";
import { Button } from "./ui";

/** Official download page; the app never installs cloudflared itself. */
const CLOUDFLARED_DOCS =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
const INSTALL_COMMAND = "brew install cloudflared";

type PairingWithQr = PairingCode & { qr: string };
type Busy = "tunnel" | "stop" | "unpair" | null;
type Tone = "emerald" | "amber" | "rose" | "sky" | "muted";

const TONE_DOT: Record<Tone, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500 animate-pulse",
  rose: "bg-rose-500",
  sky: "bg-sky-500 animate-pulse",
  muted: "bg-slate-300",
};

const addressOf = (url: string): string =>
  url
    .split("#")[0]
    .split("?")[0]
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

/** Short relative time for the device's last heartbeat. */
const lastSeenLabel = (iso: string | null | undefined): string => {
  if (!iso) return "尚未握手";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (secs < 15) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Phone scan entry: the default transport is a cloudflared Quick Tunnel, with
 * LAN kept as a secondary test path. The tunnel is started on open and is
 * never torn down by a scan or by closing this dialog — only the explicit
 * stop actions, disabling the companion or quitting the app end it.
 */
export function CompanionDialog({
  onClose,
  toast,
}: {
  onClose: () => void;
  toast: SettingsSectionProps["toast"];
}) {
  const [status, setStatus] = useState<CompanionStatus | null>(() =>
    cachedCompanionStatus(),
  );
  const [mode, setMode] = useState<PairingMode>("tunnel");
  const [pairing, setPairing] = useState<PairingWithQr | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "install" | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const pairingBaseRef = useRef<string | null>(null);
  const requestSeq = useRef(0);
  const copiedTimer = useRef<number | null>(null);

  const loadStatus = useCallback(
    async (silent = true): Promise<CompanionStatus | null> => {
      try {
        const next = await companionApi.status();
        setStatus(next);
        rememberCompanionStatus(next);
        return next;
      } catch (error) {
        if (!silent) toast("error", String(error));
        return null;
      }
    },
    [toast],
  );

  // Boot: read state, force one cloudflared detection, then start the tunnel
  // when the default transport is available.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next = await loadStatus(false);
      if (cancelled || !next) return;
      if (next.enabled && !next.running) {
        // The config says enabled but the listener died (port conflict at
        // boot, for example). Re-running the enable path is idempotent.
        await companionApi.setEnabled(true).catch(() => undefined);
        if (cancelled) return;
        next = (await loadStatus(true)) ?? next;
      }
      const cloudflared = await companionApi
        .cloudflaredCheck()
        .catch(() => next.cloudflared);
      if (cancelled) return;
      setStatus((previous) =>
        previous ? { ...previous, cloudflared } : previous,
      );
      if (cloudflared.installed && next.tunnel.state === "stopped") {
        try {
          await companionApi.tunnelStart();
          if (!cancelled) await loadStatus(true);
        } catch (error) {
          if (!cancelled) setActionError(String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  // Live updates: tunnel state, the pairing handshake and heartbeats.
  useTauriEvent<CompanionTunnel>("companion://tunnel", () => {
    void loadStatus(true);
  });
  useTauriEvent<unknown>("companion://paired", () => {
    void loadStatus(true);
  });
  useTauriEvent<unknown>("companion://presence", () => {
    void loadStatus(true);
  });

  // Poll as a fallback for missed events and to age the "last seen" labels.
  usePoll(
    () => {
      void loadStatus(true);
      setNow(Date.now());
    },
    2_000,
    { pauseWhenHidden: true },
  );

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const tunnelUrl =
    status?.tunnel.state === "running" ? (status.tunnel.url ?? null) : null;
  const lanBase =
    status?.running && status.lanIp && status.port
      ? `${status.lanIp}:${status.port}`
      : null;
  const pairingBase = mode === "tunnel" ? tunnelUrl : lanBase;
  const onlineDevice = status?.devices.find((device) => device.online) ?? null;
  const cloudflaredInstalled = status?.cloudflared.installed ?? false;
  const pairingExpired = pairing
    ? Date.parse(pairing.expiresAt) <= now
    : false;

  const requestPairing = useCallback(async () => {
    const seq = ++requestSeq.current;
    setPairingBusy(true);
    setPairingError(false);
    try {
      const code = await companionApi.pairingCode(mode);
      // Cache-bust the document so a phone that scanned before an SPA update
      // cannot reuse the old HTML/JS. The router only reads the hash, so the
      // extra query is inert.
      const [base, fragment] = code.url.split("#");
      const url = fragment
        ? `${base}${base.includes("?") ? "&" : "?"}v=${Date.now()}#${fragment}`
        : code.url;
      const qr = await toDataURL(url, { margin: 1, width: 480 });
      if (seq === requestSeq.current) setPairing({ ...code, url, qr });
    } catch (error) {
      if (seq === requestSeq.current) {
        setPairingError(true);
        setPairing(null);
        toast("error", String(error));
      }
    } finally {
      if (seq === requestSeq.current) setPairingBusy(false);
    }
  }, [mode, toast]);

  // A new tunnel URL (or a mode switch) invalidates the old QR.
  useEffect(() => {
    if (!pairingBase) {
      pairingBaseRef.current = null;
      setPairing(null);
      return;
    }
    if (pairingBaseRef.current !== pairingBase) {
      pairingBaseRef.current = pairingBase;
      void requestPairing();
    }
  }, [pairingBase, requestPairing]);

  // Keep a waiting QR usable: refresh an expired code until a device connects.
  useEffect(() => {
    if (!pairing || onlineDevice || !pairingExpired) return;
    void requestPairing();
  }, [pairing, onlineDevice, pairingExpired, requestPairing]);

  const copyText = async (text: string, kind: "link" | "install") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1500);
    } catch {
      toast("error", "复制失败");
    }
  };

  const switchMode = (next: PairingMode) => {
    if (next === mode) return;
    setMode(next);
    setPairing(null);
    setPairingError(false);
    pairingBaseRef.current = null;
    requestSeq.current += 1;
  };

  const startTunnel = async () => {
    setBusy("tunnel");
    setActionError(null);
    try {
      await companionApi.tunnelStart();
      await loadStatus(true);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusy(null);
    }
  };

  const stopTunnel = async () => {
    setBusy("tunnel");
    setActionError(null);
    try {
      await companionApi.tunnelStop();
      pairingBaseRef.current = null;
      requestSeq.current += 1;
      setPairing(null);
      await loadStatus(true);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusy(null);
    }
  };

  const recheckCloudflared = async () => {
    setChecking(true);
    setActionError(null);
    try {
      const cloudflared = await companionApi.cloudflaredCheck();
      setStatus((previous) =>
        previous ? { ...previous, cloudflared } : previous,
      );
      if (cloudflared.installed) {
        await companionApi.tunnelStart();
        await loadStatus(true);
      } else {
        setActionError("仍未检测到 cloudflared，请确认安装后重试");
      }
    } catch (error) {
      setActionError(String(error));
    } finally {
      setChecking(false);
    }
  };

  const unpair = async (deviceId: string) => {
    setBusy("unpair");
    try {
      await companionApi.unpair(deviceId);
      await loadStatus(true);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setBusy(null);
    }
  };

  const stopCompanion = async () => {
    setBusy("stop");
    try {
      await companionApi.setEnabled(false);
      setCompanionEnabledLocal(false);
      onClose();
    } catch (error) {
      toast("error", String(error));
      setBusy(null);
    }
  };

  const statusLine = ((): { tone: Tone; text: string } => {
    if (!status) return { tone: "muted", text: "读取状态中…" };
    if (mode === "tunnel" && !cloudflaredInstalled) {
      return { tone: "muted", text: "需要安装 cloudflared" };
    }
    if (mode === "tunnel" && status.tunnel.state === "starting") {
      return { tone: "amber", text: "正在建立外网隧道…" };
    }
    if (mode === "tunnel" && status.tunnel.state === "failed") {
      return { tone: "rose", text: "外网隧道启动失败" };
    }
    if (mode === "tunnel" && status.tunnel.state === "stopped") {
      return { tone: "muted", text: "外网隧道未建立" };
    }
    if (onlineDevice) {
      return { tone: "emerald", text: `已连接 ${onlineDevice.name}` };
    }
    if (pairingExpired) return { tone: "amber", text: "配对码已过期" };
    if (pairing) return { tone: "sky", text: "等待手机连接" };
    return { tone: "muted", text: "准备二维码…" };
  })();

  const renderQr = () => (
    <div className="rounded-2xl border border-border bg-slate-50/60 p-5">
      <div className="flex items-center gap-2">
        <span className={clsx("h-2 w-2 rounded-full", TONE_DOT[statusLine.tone])} />
        <span className="text-ui-sm text-slate-700">{statusLine.text}</span>
      </div>

      <div className="mt-4 flex justify-center">
        {pairing ? (
          <div className="rounded-xl border border-border bg-white p-3">
            <img src={pairing.qr} alt="配对二维码" className="h-56 w-56" />
          </div>
        ) : (
          <div className="grid h-[248px] w-[248px] place-items-center rounded-xl border border-dashed border-border px-4 text-center text-ui-xs text-slate-400">
            {pairingError
              ? "二维码生成失败，可点下方重新生成"
              : pairingBusy
                ? "生成二维码…"
                : "等待隧道地址"}
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
          <span
            className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-600"
            title={pairing?.url ?? pairingBase ?? ""}
          >
            {pairingBase ? addressOf(pairingBase) : "—"}
          </span>
          <button
            type="button"
            title="复制链接"
            aria-label="复制链接"
            disabled={!pairing}
            onClick={() => {
              if (pairing) void copyText(pairing.url, "link");
            }}
            className="shrink-0 rounded p-1 text-slate-400 transition hover:text-slate-700 disabled:opacity-40"
          >
            {copied === "link" ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={pairingBusy}
            disabled={!pairingBase}
            onClick={() => void requestPairing()}
          >
            重新生成
          </Button>
          <span className="text-ui-2xs text-slate-400">
            配对码 10 分钟内有效，首个扫码设备独占
          </span>
        </div>
      </div>
    </div>
  );

  const renderMain = () => {
    if (!status) {
      return (
        <div className="grid h-[360px] place-items-center rounded-2xl border border-border bg-surface">
          <div className="text-center">
            <Loader2 size={20} className="mx-auto animate-spin text-slate-400" />
            <p className="mt-3 text-ui-sm text-slate-500">读取伴侣状态…</p>
          </div>
        </div>
      );
    }

    if (mode === "tunnel") {
      if (!cloudflaredInstalled) {
        return (
          <div className="rounded-2xl border border-border bg-surface p-5">
            <h3 className="text-ui-base text-slate-900">需要安装 cloudflared</h3>
            <p className="mt-1 text-ui-caption text-slate-500">
              外网隧道依赖本机的 cloudflared，应用不会自动安装。
            </p>
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-slate-100">
              <code className="min-w-0 flex-1 truncate font-mono text-ui-xs">
                {INSTALL_COMMAND}
              </code>
              <button
                type="button"
                title="复制安装命令"
                aria-label="复制安装命令"
                onClick={() => void copyText(INSTALL_COMMAND, "install")}
                className="shrink-0 rounded p-1 text-slate-300 transition hover:text-white"
              >
                {copied === "install" ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <ol className="mt-3 space-y-1 text-ui-xs text-slate-500">
              <li>1. 在终端运行上面的命令</li>
              <li>2. 安装完成后点「我已安装」</li>
            </ol>
            {actionError ? (
              <p className="mt-3 break-all text-ui-xs text-rose-600">{actionError}</p>
            ) : null}
            <div className="mt-4 flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={checking}
                onClick={() => void recheckCloudflared()}
              >
                我已安装
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<ExternalLink size={12} />}
                onClick={() => {
                  void api.openPath(CLOUDFLARED_DOCS).catch((error) => toast("error", String(error)));
                }}
              >
                安装文档
              </Button>
            </div>
          </div>
        );
      }

      if (status.tunnel.state === "starting") {
        return (
          <div className="grid h-[360px] place-items-center rounded-2xl border border-border bg-surface">
            <div className="text-center">
              <Loader2 size={20} className="mx-auto animate-spin text-slate-400" />
              <p className="mt-3 text-ui-sm text-slate-600">正在建立外网隧道…</p>
              <p className="mt-1 text-ui-xs text-slate-400">首次建立通常需要几秒</p>
            </div>
          </div>
        );
      }

      if (status.tunnel.state === "failed") {
        return (
          <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5">
            <p className="text-ui-sm text-rose-700">外网隧道启动失败</p>
            <p className="mt-1 break-all text-ui-xs text-rose-600">
              {status.tunnel.error ?? actionError ?? "未知错误"}
            </p>
            <div className="mt-4 flex items-center gap-2">
              <Button
                size="sm"
                loading={busy === "tunnel"}
                onClick={() => void startTunnel()}
              >
                重试
              </Button>
              <Button size="sm" variant="ghost" onClick={() => switchMode("lan")}>
                改用局域网（测试）
              </Button>
            </div>
          </div>
        );
      }

      if (status.tunnel.state === "stopped") {
        return (
          <div className="grid h-[360px] place-items-center rounded-2xl border border-border bg-surface">
            <div className="text-center">
              <p className="text-ui-sm text-slate-600">外网隧道未建立</p>
              <p className="mt-1 text-ui-xs text-slate-400">建立后扫码即可在外网访问</p>
              <Button
                size="sm"
                variant="primary"
                className="mt-4"
                loading={busy === "tunnel"}
                onClick={() => void startTunnel()}
              >
                建立隧道
              </Button>
            </div>
          </div>
        );
      }
    }

    if (mode === "lan" && !lanBase) {
      return (
        <div className="grid h-[360px] place-items-center rounded-2xl border border-border bg-surface">
          <p className="text-ui-sm text-slate-500">无局域网连接</p>
        </div>
      );
    }

    return renderQr();
  };

  const tunnelLabel =
    status?.tunnel.state === "running"
      ? "运行中"
      : status?.tunnel.state === "starting"
        ? "建立中"
        : status?.tunnel.state === "failed"
          ? "失败"
          : "已停止";

  return (
    <Dialog
      title="移动端伴侣"
      icon={<Smartphone size={15} className="text-slate-400" />}
      size="wide"
      onClose={onClose}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <p
            className="text-ui-caption text-slate-500"
            title="手机扫码后在浏览器打开当前工作区；数据全部由桌面端转发。"
          >
            扫码在手机上打开当前工作区。
          </p>

          <div className="mt-4">{renderMain()}</div>

          {actionError && !(mode === "tunnel" && !cloudflaredInstalled) ? (
            <p className="mt-3 break-all text-ui-xs text-rose-600">{actionError}</p>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-3 text-ui-xs text-slate-400">
            <span>{mode === "tunnel" ? "外网隧道" : "局域网（测试）"}</span>
            <button
              type="button"
              onClick={() => switchMode(mode === "tunnel" ? "lan" : "tunnel")}
              className="rounded px-1 py-0.5 transition hover:bg-overlay-soft hover:text-slate-700"
            >
              {mode === "tunnel" ? "改用局域网（测试）" : "改用外网隧道"}
            </button>
          </div>
        </section>

        <aside className="min-w-0 space-y-4">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-sm text-slate-900">外网隧道</h3>
              <span
                className={clsx(
                  "text-ui-2xs",
                  status?.tunnel.state === "failed" ? "text-rose-600" : "text-slate-400",
                )}
              >
                {tunnelLabel}
              </span>
            </div>
            <p
              className="mt-2 truncate font-mono text-ui-xs text-slate-500"
              title={tunnelUrl ?? ""}
            >
              {tunnelUrl ? addressOf(tunnelUrl) : "未建立"}
            </p>
            <div className="mt-3 flex items-center gap-2">
              {status?.tunnel.state === "running" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === "tunnel"}
                  onClick={() => void stopTunnel()}
                >
                  停止隧道
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "tunnel"}
                  disabled={!cloudflaredInstalled}
                  onClick={() => void startTunnel()}
                >
                  建立隧道
                </Button>
              )}
            </div>
            <p className="mt-2 truncate text-ui-2xs text-slate-400">
              {cloudflaredInstalled
                ? `cloudflared ${status?.cloudflared.version ?? ""}`.trim()
                : "未检测到 cloudflared"}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-sm text-slate-900">已配对设备</h3>
              <span className="text-ui-2xs text-slate-400">
                {status?.devices.length ?? 0}
              </span>
            </div>
            {status && status.devices.length > 0 ? (
              <ul className="mt-1 divide-y divide-slate-100">
                {status.devices.map((device) => (
                  <li key={device.id} className="flex items-center gap-2 py-2">
                    <span
                      className={clsx(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        device.online ? "bg-emerald-500" : "bg-slate-300",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui-caption text-slate-700">
                        {device.name}
                      </p>
                      <p className="text-ui-2xs text-slate-400">
                        {device.online ? "在线" : "离线"} ·{" "}
                        {lastSeenLabel(device.lastSeenAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy === "unpair"}
                      onClick={() => void unpair(device.id)}
                      className="shrink-0 rounded px-1 py-0.5 text-ui-2xs text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                    >
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-ui-xs text-slate-400">暂无已配对设备</p>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-slate-50/60 p-4">
            <p
              className="text-ui-xs text-slate-500"
              title="关闭弹窗不会停止隧道；手机可以继续使用当前地址。"
            >
              关闭弹窗不会停止隧道。
            </p>
            {confirmStop ? (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === "stop"}
                  onClick={() => void stopCompanion()}
                >
                  确定停止
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmStop(false)}
                >
                  取消
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => setConfirmStop(true)}
              >
                停止移动端伴侣
              </Button>
            )}
          </div>
        </aside>
      </div>
    </Dialog>
  );
}
