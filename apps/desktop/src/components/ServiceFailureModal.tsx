import { useState } from "react";
import { AlertTriangle, FileText, RotateCw } from "lucide-react";

import { api } from "../lib/api";
import { t } from "../lib/i18n";
import {
  restartApp,
  retryService,
  useServiceFailures,
  type ServiceFailure,
  type ServiceKey,
} from "../lib/services";
import { showToast } from "../lib/toast";
import { Dialog } from "./Dialog";
import { Button } from "./ui";

/**
 * One modal for the services that start with the app and stay down after the
 * startup guard's attempts. Mounted outside the page tree: a failure can be
 * recorded before login (or before the agent page is ever opened), and the
 * user still needs to see it.
 */
export function ServiceFailureModal() {
  const failures = useServiceFailures();
  /** Dismissed services stay hidden until a manual retry is attempted. */
  const [dismissed, setDismissed] = useState<ServiceKey[]>([]);
  const [busy, setBusy] = useState<ServiceKey | null>(null);

  const visible = failures.filter(
    (failure) => !dismissed.includes(failure.service),
  );
  if (visible.length === 0) return null;

  const dismiss = () => {
    setDismissed((current) => [
      ...current,
      ...visible
        .map((failure) => failure.service)
        .filter((service) => !current.includes(service)),
    ]);
  };

  const retry = async (service: ServiceKey) => {
    // Retry is an explicit request: bring the row back even if it was dismissed.
    setDismissed((current) => current.filter((item) => item !== service));
    setBusy(service);
    try {
      await retryService(service);
    } catch {
      // The backend publishes the new reason on `service://failed`; the row
      // stays visible with that error.
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title={t("service.failed.title")}
      icon={<AlertTriangle size={15} className="text-rose-500" />}
      onClose={dismiss}
    >
      <div className="space-y-3">
        {visible.map((failure) => (
          <FailureRow
            key={failure.service}
            failure={failure}
            busy={busy === failure.service}
            onRetry={() => void retry(failure.service)}
          />
        ))}
      </div>
      <p className="mt-3 text-ui-xs text-slate-400">{t("service.failed.hint")}</p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void restartApp().catch(() => undefined)}
        >
          {t("service.failed.restartApp")}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t("service.failed.later")}
        </Button>
      </div>
    </Dialog>
  );
}

function FailureRow(props: {
  failure: ServiceFailure;
  busy: boolean;
  onRetry: () => void;
}) {
  const { failure, busy, onRetry } = props;
  const label =
    failure.service === "agent"
      ? t("service.failed.agent")
      : t("service.failed.companion");

  const openLogs = () => {
    if (!failure.logDir) return;
    void api
      .openPath(failure.logDir)
      .catch((error) => showToast("error", String(error)));
  };

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-ui-caption text-slate-800">{label}</span>
        <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
          {t("service.failed.attempts", { attempts: failure.attempts })}
        </span>
      </div>
      <p
        className="mt-2 break-all rounded-lg bg-rose-50 px-2 py-1.5 text-ui-sm text-rose-600"
        title={failure.error}
      >
        {failure.error}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<FileText size={13} />}
          disabled={!failure.logDir}
          onClick={openLogs}
          title={failure.logDir}
        >
          {t("service.failed.logs")}
        </Button>
        <Button
          size="sm"
          loading={busy}
          icon={<RotateCw size={13} />}
          onClick={onRetry}
        >
          {t("service.failed.retry")}
        </Button>
      </div>
    </div>
  );
}
