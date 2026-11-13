import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Smartphone } from "lucide-react";

import { companionApi, type CompanionStatus } from "../lib/api";
import {
  cachedCompanionStatus,
  rememberCompanionStatus,
  setCompanionEnabledLocal,
} from "../lib/companion";
import type { SettingsSectionProps } from "../lib/feature";
import { Button, Switch, cardClass } from "./ui";

const STATE_LINE = "mt-4 text-ui-caption";

/**
 * Settings for the mobile companion. Deliberately QR-free: the scan entry is
 * the phone icon above Settings in the rail, and it only exists while the
 * service is enabled here. Everything else (tunnel, QR, devices) lives in
 * `CompanionDialog`.
 */
export function CompanionCard({ toast }: SettingsSectionProps) {
  const [status, setStatus] = useState<CompanionStatus | null>(() =>
    cachedCompanionStatus(),
  );
  const [statusError, setStatusError] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchingCode, setSwitchingCode] = useState(false);

  const loadStatus = useCallback(
    async (silent: boolean): Promise<CompanionStatus | null> => {
      try {
        const next = await companionApi.status();
        setStatus(next);
        setStatusError(false);
        rememberCompanionStatus(next);
        return next;
      } catch (error) {
        setStatusError(true);
        if (!silent) toast("error", String(error));
        return null;
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  const toggleEnabled = async (value: boolean) => {
    setSwitching(true);
    try {
      await companionApi.setEnabled(value);
      setCompanionEnabledLocal(value);
      await loadStatus(true);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSwitching(false);
    }
  };

  const toggleRequireCode = async (value: boolean) => {
    setSwitchingCode(true);
    try {
      await companionApi.setRequireCode(value);
      await loadStatus(true);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSwitchingCode(false);
    }
  };

  const enabled = status?.enabled ?? false;

  return (
    <section className={cardClass}>
      <div className="flex items-start justify-between gap-3">
        <h2
          className="flex items-center gap-2 text-ui-base font-normal text-slate-900"
          title="开启后，左侧栏「设置」上方出现手机扫码入口；手机扫码即可查看桌面端数据。"
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
            <Button size="sm" variant="ghost" onClick={() => void loadStatus(false)}>
              重试
            </Button>
          ) : null}
        </div>
      ) : !enabled ? (
        <p className={clsx(STATE_LINE, "text-slate-400")}>开启后显示手机扫码入口</p>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span
              className="text-ui-sm text-slate-700"
              title="关闭后，手机打开伴侣地址即可直接配对，无需扫码；仅建议测试阶段使用。"
            >
              配对码
            </span>
            <Switch
              checked={status.requirePairingCode}
              onChange={(value) => void toggleRequireCode(value)}
              disabled={switchingCode}
              label="要求配对码"
            />
          </div>
          {!status.running ? (
            <p className={clsx(STATE_LINE, "text-rose-600")}>服务未运行，可关闭后重新开启</p>
          ) : null}
        </>
      )}
    </section>
  );
}
