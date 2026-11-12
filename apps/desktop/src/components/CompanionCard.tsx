import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { toDataURL } from "qrcode";
import { Copy, Smartphone } from "lucide-react";

import { companionApi, type CompanionStatus, type PairingCode } from "../lib/api";
import type { SettingsSectionProps } from "../lib/feature";
import { usePoll } from "../hooks/usePoll";
import { Button, Switch, cardClass, inputClass } from "./ui";
import { Segmented } from "./Segmented";

/** Pairing code plus its rendered QR data URL, set together or not at all. */
type PairingWithQr = PairingCode & { qr: string };

type Mode = "lan" | "tunnel";

const STATE_LINE = "mt-4 text-ui-caption";

/** A Quick Tunnel address: bare https host, trailing slash tolerated. */
const TUNNEL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

/** Settings card for the mobile companion: enable, pair via QR (LAN or Quick
 * Tunnel), unpair devices. cloudflared itself is never bundled or spawned —
 * the card only shows the steps and turns a pasted tunnel URL into a QR. */
export function CompanionCard({ toast }: SettingsSectionProps) {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [pairing, setPairing] = useState<PairingWithQr | null>(null);
  const [pairingError, setPairingError] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [unpairingId, setUnpairingId] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("lan");
  const [tunnelInput, setTunnelInput] = useState("");
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelQr, setTunnelQr] = useState<string | null>(null);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [buildingTunnel, setBuildingTunnel] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  const enabled = status?.enabled ?? false;
  const address =
    status?.running && status.lanIp && status.port
      ? `${status.lanIp}:${status.port}`
      : null;
  const runCommand =
    status?.running && status.port
      ? `cloudflared tunnel --url http://127.0.0.1:${status.port} --protocol http2`
      : null;

  const loadStatus = useCallback(
    async (silent: boolean): Promise<CompanionStatus | null> => {
      try {
        const next = await companionApi.status();
        setStatus(next);
        setStatusError(false);
        return next;
      } catch (error) {
        setStatusError(true);
        if (!silent) toast("error", String(error));
        return null;
      }
    },
    [toast],
  );

  /** Fetches a one-time code and renders both QRs; errors land in toast + inline. */
  const loadPairingCode = useCallback(async (): Promise<boolean> => {
    try {
      const code = await companionApi.pairingCode();
      const lan = await toDataURL(code.url);
      setPairing({ ...code, qr: lan });
      // A fresh code invalidates whatever the tunnel QR encoded before.
      setTunnelQr(tunnelUrl ? await toDataURL(`${tunnelUrl}/#/pair?t=${code.code}`) : null);
      setPairingError(false);
      return true;
    } catch (error) {
      setPairingError(true);
      toast("error", String(error));
      return false;
    }
  }, [toast, tunnelUrl]);

  /** First read decides whether a pairing code is needed right away. */
  const initialLoad = useCallback(() => {
    void loadStatus(false).then((next) => {
      if (next?.enabled) void loadPairingCode();
    });
  }, [loadStatus, loadPairingCode]);

  useEffect(() => {
    initialLoad();
  }, [initialLoad]);

  // Status only matters while the companion is enabled.
  usePoll(() => void loadStatus(true), enabled ? 10_000 : 0, {
    pauseWhenHidden: true,
  });

  const toggleEnabled = async (value: boolean) => {
    setSwitching(true);
    try {
      await companionApi.setEnabled(value);
      const next = await loadStatus(true);
      if (next?.enabled) {
        void loadPairingCode();
      } else {
        setPairing(null);
        setPairingError(false);
        setTunnelQr(null);
        setTunnelUrl(null);
      }
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSwitching(false);
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    await loadPairingCode();
    setRegenerating(false);
  };

  const unpair = async (deviceId: string) => {
    setUnpairingId(deviceId);
    try {
      await companionApi.unpair(deviceId);
      await loadStatus(true);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setUnpairingId(null);
    }
  };

  const confirmTunnel = async () => {
    const url = tunnelInput.trim().replace(/\/+$/, "");
    if (!TUNNEL_PATTERN.test(url)) {
      setTunnelError("需要 trycloudflare.com 的 https 地址");
      return;
    }
    if (!pairing) return;
    setBuildingTunnel(true);
    try {
      setTunnelQr(await toDataURL(`${url}/#/pair?t=${pairing.code}`));
      setTunnelUrl(url);
      setTunnelError(null);
    } catch {
      setTunnelError("二维码生成失败");
    } finally {
      setBuildingTunnel(false);
    }
  };

  const copyRunCommand = async () => {
    if (!runCommand) return;
    try {
      await navigator.clipboard.writeText(runCommand);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("error", "复制失败");
    }
  };

  return (
    <section className={cardClass}>
      <div className="flex items-start justify-between gap-3">
        <h2
          className="flex items-center gap-2 text-ui-base font-normal text-slate-900"
          title="手机扫码后在浏览器查看桌面端数据；局域网直连，或经 Quick Tunnel 外网访问。"
        >
          <Smartphone size={15} className="text-slate-400" />
          移动端伴侣
        </h2>
        <Switch
          checked={enabled}
          onChange={(value) => void toggleEnabled(value)}
          disabled={switching || status === null}
          label="启用移动端伴侣"
        />
      </div>

      {status === null ? (
        <div className={clsx(STATE_LINE, "flex items-center gap-3")}>
          <span className={statusError ? "text-rose-600" : "text-slate-400"}>
            {statusError ? "状态读取失败" : "读取状态中…"}
          </span>
          {statusError ? (
            <Button size="sm" variant="ghost" onClick={initialLoad}>
              重试
            </Button>
          ) : null}
        </div>
      ) : !enabled ? null : !status.running ? (
        <p className={clsx(STATE_LINE, "text-slate-400")}>服务未运行</p>
      ) : (
        <>
          <div className="mt-4">
            <Segmented<Mode>
              value={mode}
              options={[
                { value: "lan", label: "局域网" },
                { value: "tunnel", label: "外网隧道" },
              ]}
              onChange={setMode}
            />
          </div>

          {mode === "lan" ? (
            address ? (
              <LanQr
                pairing={pairing}
                pairingError={pairingError}
                address={address}
                regenerating={regenerating}
                onRegenerate={() => void regenerate()}
              />
            ) : (
              <p className={clsx(STATE_LINE, "text-slate-400")}>无局域网连接</p>
            )
          ) : (
            <TunnelQr
              pairing={pairing}
              runCommand={runCommand}
              tunnelInput={tunnelInput}
              tunnelUrl={tunnelUrl}
              tunnelQr={tunnelQr}
              tunnelError={tunnelError}
              buildingTunnel={buildingTunnel}
              copied={copied}
              onInput={setTunnelInput}
              onConfirm={() => void confirmTunnel()}
              onCopy={() => void copyRunCommand()}
            />
          )}

          <div className="mt-4 border-t border-border pt-3">
            <div className="text-ui-xs text-slate-500">已配对设备</div>
            {status.devices.length > 0 ? (
              <div className="mt-1 divide-y divide-slate-100">
                {status.devices.map((device) => (
                  <div key={device.id} className="flex items-center gap-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-700">
                      {device.name}
                    </span>
                    <span className="shrink-0 text-ui-xs text-slate-400">
                      {pairedOn(device.pairedAt)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={unpairingId === device.id}
                      onClick={() => void unpair(device.id)}
                    >
                      解除
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-ui-xs text-slate-400">暂无已配对设备</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function LanQr({
  pairing,
  pairingError,
  address,
  regenerating,
  onRegenerate,
}: {
  pairing: PairingWithQr | null;
  pairingError: boolean;
  address: string;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  return (
    <>
      <div className="mt-4 flex items-start gap-4">
        {pairing ? (
          <img
            src={pairing.qr}
            alt="配对二维码"
            title="一次性配对码，10 分钟内有效，被首个扫码设备独占"
            className="h-28 w-28 shrink-0 rounded-lg border border-border"
          />
        ) : pairingError ? (
          <div className="grid h-28 w-28 shrink-0 place-items-center rounded-lg border border-border text-ui-xs text-rose-600">
            生成失败
          </div>
        ) : (
          <div className="grid h-28 w-28 shrink-0 place-items-center rounded-lg border border-border text-ui-xs text-slate-400">
            生成中…
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <span className="truncate font-mono text-ui-sm text-slate-700" title={address}>
            {address}
          </span>
          <Button size="sm" variant="ghost" loading={regenerating} onClick={onRegenerate}>
            重新生成
          </Button>
        </div>
      </div>
    </>
  );
}

function TunnelQr({
  pairing,
  runCommand,
  tunnelInput,
  tunnelUrl,
  tunnelQr,
  tunnelError,
  buildingTunnel,
  copied,
  onInput,
  onConfirm,
  onCopy,
}: {
  pairing: PairingWithQr | null;
  runCommand: string | null;
  tunnelInput: string;
  tunnelUrl: string | null;
  tunnelQr: string | null;
  tunnelError: string | null;
  buildingTunnel: boolean;
  copied: boolean;
  onInput: (value: string) => void;
  onConfirm: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="mt-4 space-y-3">
      {tunnelQr && tunnelUrl ? (
        <div className="flex items-start gap-4">
          <img
            src={tunnelQr}
            alt="隧道配对二维码"
            title="经 Quick Tunnel 外网访问；配对码同样 10 分钟内有效、首个扫码设备独占"
            className="h-28 w-28 shrink-0 rounded-lg border border-border"
          />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
            <span className="truncate font-mono text-ui-sm text-slate-700" title={tunnelUrl}>
              {tunnelUrl.replace(/^https:\/\//, "")}
            </span>
            <span className="text-ui-xs text-slate-400">
              cloudflared 重启后地址会变，需重新粘贴
            </span>
          </div>
        </div>
      ) : null}

      <ol className="space-y-1.5 text-ui-xs text-slate-500">
        <li>1. 自行安装（应用不内嵌）：<code className="font-mono text-slate-700">brew install cloudflared</code></li>
        <li className="flex items-center gap-1.5">
          <span className="shrink-0">2. 运行：</span>
          {runCommand ? (
            <>
              <code className="min-w-0 flex-1 truncate font-mono text-slate-700" title={runCommand}>
                {runCommand}
              </code>
              <button
                type="button"
                onClick={onCopy}
                title="复制运行命令"
                className="shrink-0 rounded p-1 text-slate-400 hover:text-slate-700"
              >
                {copied ? <span className="text-ui-2xs">已复制</span> : <Copy size={12} />}
              </button>
            </>
          ) : (
            <span className="text-slate-400">服务未运行</span>
          )}
        </li>
        <li>3. 把终端输出的 trycloudflare.com 地址粘贴到下方</li>
      </ol>

      <div className="flex items-start gap-2">
        <input
          className={clsx(inputClass, "min-w-0 flex-1 font-mono")}
          placeholder="https://xxx.trycloudflare.com"
          value={tunnelInput}
          onChange={(event) => onInput(event.target.value)}
          title="粘贴 cloudflared 输出的隧道地址"
        />
        <Button
          size="sm"
          variant="primary"
          loading={buildingTunnel}
          disabled={!pairing}
          onClick={onConfirm}
        >
          生成二维码
        </Button>
      </div>
      {tunnelError ? <p className="text-ui-xs text-rose-600">{tunnelError}</p> : null}
    </div>
  );
}

/** `pairedAt` as a plain date; falls back to the raw string when unparseable. */
const pairedOn = (iso: string): string => {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : new Date(timestamp).toLocaleDateString("zh-CN");
};
