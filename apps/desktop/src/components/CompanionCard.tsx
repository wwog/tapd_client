import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { toDataURL } from "qrcode";
import { Smartphone } from "lucide-react";

import { companionApi, type CompanionStatus, type PairingCode } from "../lib/api";
import type { SettingsSectionProps } from "../lib/feature";
import { usePoll } from "../hooks/usePoll";
import { Button, Switch, cardClass } from "./ui";

/** Pairing code plus its rendered QR data URL, set together or not at all. */
type PairingWithQr = PairingCode & { qr: string };

const STATE_LINE = "mt-4 text-ui-caption";

/** Settings card for the mobile companion: enable, pair via QR, unpair devices. */
export function CompanionCard({ toast }: SettingsSectionProps) {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [pairing, setPairing] = useState<PairingWithQr | null>(null);
  const [pairingError, setPairingError] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [unpairingId, setUnpairingId] = useState<string | null>(null);

  const enabled = status?.enabled ?? false;
  const address =
    status?.running && status.lanIp && status.port
      ? `${status.lanIp}:${status.port}`
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

  /** Fetches a one-time code and renders the QR; errors land in toast + inline. */
  const loadPairingCode = useCallback(async (): Promise<boolean> => {
    try {
      const code = await companionApi.pairingCode();
      setPairing({ ...code, qr: await toDataURL(code.url) });
      setPairingError(false);
      return true;
    } catch (error) {
      setPairingError(true);
      toast("error", String(error));
      return false;
    }
  }, [toast]);

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

  return (
    <section className={cardClass}>
      <div className="flex items-start justify-between gap-3">
        <h2
          className="flex items-center gap-2 text-ui-base font-normal text-slate-900"
          title="手机扫码后，在同一路由器下用浏览器查看桌面端的数据。"
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
      ) : !address ? (
        <p className={clsx(STATE_LINE, "text-slate-400")}>无局域网连接</p>
      ) : (
        <>
          <div className="mt-4 flex items-start gap-4">
            {pairing ? (
              <img
                src={pairing.qr}
                alt="配对二维码"
                title="一次性配对码，10 分钟内有效"
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
              <Button
                size="sm"
                variant="ghost"
                loading={regenerating}
                onClick={() => void regenerate()}
              >
                重新生成
              </Button>
            </div>
          </div>

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

/** `pairedAt` as a plain date; falls back to the raw string when unparseable. */
const pairedOn = (iso: string): string => {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : new Date(timestamp).toLocaleDateString("zh-CN");
};
