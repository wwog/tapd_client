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
import { localeTag, t } from "../lib/i18n";
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
  if (!iso) return t("settings.companion.notPaired");
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (secs < 15) return t("common.justNow");
  if (secs < 60) return t("settings.companion.secondsAgo", { n: secs });
  if (secs < 3600) return t("settings.companion.minutesAgo", { n: Math.floor(secs / 60) });
  return new Date(timestamp).toLocaleTimeString(localeTag(), {
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
      toast("error", t("common.copyFailed"));
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
        setActionError(t("settings.companion.noCloudflaredRetry"));
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
    if (!status) return { tone: "muted", text: t("settings.companion.statusReading") };
    if (mode === "tunnel" && !cloudflaredInstalled) {
      return { tone: "muted", text: t("settings.companion.needCloudflared") };
    }
    if (mode === "tunnel" && status.tunnel.state === "starting") {
      return { tone: "amber", text: t("settings.companion.tunnelStarting") };
    }
    if (mode === "tunnel" && status.tunnel.state === "failed") {
      return { tone: "rose", text: t("settings.companion.tunnelFailed") };
    }
    if (mode === "tunnel" && status.tunnel.state === "stopped") {
      return { tone: "muted", text: t("settings.companion.tunnelMissing") };
    }
    if (onlineDevice) {
      return { tone: "emerald", text: t("settings.companion.connected", { name: onlineDevice.name }) };
    }
    if (pairingExpired) return { tone: "amber", text: t("settings.companion.codeExpired") };
    if (pairing) return { tone: "sky", text: t("settings.companion.waitingPhone") };
    return { tone: "muted", text: t("settings.companion.preparingQr") };
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
            <img src={pairing.qr} alt={t("settings.companion.qrAlt")} className="h-56 w-56" />
          </div>
        ) : (
          <div className="grid h-[248px] w-[248px] place-items-center rounded-xl border border-dashed border-border px-4 text-center text-ui-xs text-slate-400">
            {pairingError
              ? t("settings.companion.qrFailed")
              : pairingBusy
                ? t("settings.companion.generatingQr")
                : t("settings.companion.waitingTunnel")}
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
            title={t("settings.companion.copyLink")}
            aria-label={t("settings.companion.copyLink")}
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
            {t("settings.companion.regenerate")}
          </Button>
          <span className="text-ui-2xs text-slate-400">
            {t("settings.companion.codeHint")}
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
            <p className="mt-3 text-ui-sm text-slate-500">{t("settings.companion.statusLoading")}</p>
          </div>
        </div>
      );
    }

    if (mode === "tunnel") {
      if (!cloudflaredInstalled) {
        return (
          <div className="rounded-2xl border border-border bg-surface p-5">
            <h3 className="text-ui-base text-slate-900">{t("settings.companion.needCloudflared")}</h3>
            <p className="mt-1 text-ui-caption text-slate-500">
              {t("settings.companion.cloudflaredHint")}
            </p>
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-slate-100">
              <code className="min-w-0 flex-1 truncate font-mono text-ui-xs">
                {INSTALL_COMMAND}
              </code>
              <button
                type="button"
                title={t("settings.companion.copyInstall")}
                aria-label={t("settings.companion.copyInstall")}
                onClick={() => void copyText(INSTALL_COMMAND, "install")}
                className="shrink-0 rounded p-1 text-slate-300 transition hover:text-white"
              >
                {copied === "install" ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <ol className="mt-3 space-y-1 text-ui-xs text-slate-500">
              <li>{t("settings.companion.installStep1")}</li>
              <li>{t("settings.companion.installStep2")}</li>
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
                {t("settings.companion.installed")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<ExternalLink size={12} />}
                onClick={() => {
                  void api.openPath(CLOUDFLARED_DOCS).catch((error) => toast("error", String(error)));
                }}
              >
                {t("settings.companion.installDocs")}
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
              <p className="mt-3 text-ui-sm text-slate-600">{t("settings.companion.tunnelStarting")}</p>
              <p className="mt-1 text-ui-xs text-slate-400">{t("settings.companion.firstRunHint")}</p>
            </div>
          </div>
        );
      }

      if (status.tunnel.state === "failed") {
        return (
          <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-5">
            <p className="text-ui-sm text-rose-700">{t("settings.companion.tunnelFailed")}</p>
            <p className="mt-1 break-all text-ui-xs text-rose-600">
              {status.tunnel.error ?? actionError ?? t("settings.companion.unknownError")}
            </p>
            <div className="mt-4 flex items-center gap-2">
              <Button
                size="sm"
                loading={busy === "tunnel"}
                onClick={() => void startTunnel()}
              >
                {t("common.retry")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => switchMode("lan")}>
                {t("settings.companion.useLan")}
              </Button>
            </div>
          </div>
        );
      }

      if (status.tunnel.state === "stopped") {
        return (
          <div className="grid h-[360px] place-items-center rounded-2xl border border-border bg-surface">
            <div className="text-center">
              <p className="text-ui-sm text-slate-600">{t("settings.companion.tunnelMissing")}</p>
              <p className="mt-1 text-ui-xs text-slate-400">
                {t("settings.companion.scanHint")}
              </p>
              <Button
                size="sm"
                variant="primary"
                className="mt-4"
                loading={busy === "tunnel"}
                onClick={() => void startTunnel()}
              >
                {t("settings.companion.startTunnel")}
              </Button>
            </div>
          </div>
        );
      }
    }

    if (mode === "lan" && !lanBase) {
      return (
        <div className="grid h-[360px] place-items-center rounded-2xl border border-border bg-surface">
          <p className="text-ui-sm text-slate-500">{t("settings.companion.noLan")}</p>
        </div>
      );
    }

    return renderQr();
  };

  const tunnelLabel =
    status?.tunnel.state === "running"
      ? t("settings.companion.stateRunning")
      : status?.tunnel.state === "starting"
        ? t("settings.companion.stateStarting")
        : status?.tunnel.state === "failed"
          ? t("common.failed")
          : t("settings.companion.stateStopped");

  return (
    <Dialog
      title={t("settings.companion.title")}
      icon={<Smartphone size={15} className="text-slate-400" />}
      size="wide"
      onClose={onClose}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <p
            className="text-ui-caption text-slate-500"
            title={t("settings.companion.descTooltip")}
          >
            {t("settings.companion.desc")}
          </p>

          <div className="mt-4">{renderMain()}</div>

          {actionError && !(mode === "tunnel" && !cloudflaredInstalled) ? (
            <p className="mt-3 break-all text-ui-xs text-rose-600">{actionError}</p>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-3 text-ui-xs text-slate-400">
            <span>{mode === "tunnel" ? t("settings.companion.publicTunnel") : t("settings.companion.lan")}</span>
            <button
              type="button"
              onClick={() => switchMode(mode === "tunnel" ? "lan" : "tunnel")}
              className="rounded px-1 py-0.5 transition hover:bg-overlay-soft hover:text-slate-700"
            >
              {mode === "tunnel" ? t("settings.companion.useLan") : t("settings.companion.useTunnel")}
            </button>
          </div>
        </section>

        <aside className="min-w-0 space-y-4">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-sm text-slate-900">{t("settings.companion.publicTunnel")}</h3>
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
              {tunnelUrl ? addressOf(tunnelUrl) : t("settings.companion.notEstablished")}
            </p>
            <div className="mt-3 flex items-center gap-2">
              {status?.tunnel.state === "running" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === "tunnel"}
                  onClick={() => void stopTunnel()}
                >
                  {t("settings.companion.stopTunnel")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "tunnel"}
                  disabled={!cloudflaredInstalled}
                  onClick={() => void startTunnel()}
                >
                  {t("settings.companion.startTunnel")}
                </Button>
              )}
            </div>
            <p className="mt-2 truncate text-ui-2xs text-slate-400">
              {cloudflaredInstalled
                ? `cloudflared ${status?.cloudflared.version ?? ""}`.trim()
                : t("settings.companion.cloudflaredMissing")}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-sm text-slate-900">{t("settings.companion.devices")}</h3>
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
                        {device.online ? t("settings.companion.online") : t("settings.companion.offline")} ·{" "}
                        {lastSeenLabel(device.lastSeenAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy === "unpair"}
                      onClick={() => void unpair(device.id)}
                      className="shrink-0 rounded px-1 py-0.5 text-ui-2xs text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                    >
                      {t("settings.companion.unpair")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-ui-xs text-slate-400">{t("settings.companion.noDevices")}</p>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-slate-50/60 p-4">
            <p
              className="text-ui-xs text-slate-500"
              title={t("settings.companion.closeTooltip")}
            >
              {t("settings.companion.closeHint")}
            </p>
            {confirmStop ? (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === "stop"}
                  onClick={() => void stopCompanion()}
                >
                  {t("settings.companion.stopConfirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmStop(false)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => setConfirmStop(true)}
              >
                {t("settings.companion.stop")}
              </Button>
            )}
          </div>
        </aside>
      </div>
    </Dialog>
  );
}
