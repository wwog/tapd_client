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
import { t } from "../lib/i18n";
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
          title={t("settings.companion.tooltip")}
        >
          <Smartphone size={15} className="text-slate-400" />
          {t("settings.companion.title")}
        </h2>
        <Switch
          checked={enabled}
          onChange={(value) => void toggleEnabled(value)}
          disabled={switching || status === null}
          label={t("settings.companion.enable")}
        />
      </div>

      {status === null ? (
        <div className={clsx(STATE_LINE, "flex items-center gap-3")}>
          <span className={statusError ? "text-rose-600" : "text-slate-400"}>
            {statusError ? t("settings.companion.statusFailed") : t("settings.companion.statusReading")}
          </span>
          {statusError ? (
            <Button size="sm" variant="ghost" onClick={() => void loadStatus(false)}>
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      ) : !enabled ? (
        <p className={clsx(STATE_LINE, "text-slate-400")}>
          {t("settings.companion.enabledHint")}
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span
              className="text-ui-sm text-slate-700"
              title={t("settings.companion.pairingTooltip")}
            >
              {t("settings.companion.pairingCode")}
            </span>
            <Switch
              checked={status.requirePairingCode}
              onChange={(value) => void toggleRequireCode(value)}
              disabled={switchingCode}
              label={t("settings.companion.requireCode")}
            />
          </div>
          {!status.running ? (
            <p className={clsx(STATE_LINE, "text-rose-600")}>
              {t("settings.companion.notRunning")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
