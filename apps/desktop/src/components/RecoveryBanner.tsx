import clsx from "clsx";
import { AlertTriangle, RotateCcw } from "lucide-react";

import type { RecoveryReport } from "../lib/agent";
import { getLocale, t } from "../lib/i18n";
import { Button } from "./ui";

/**
 * One-line summary of the agent tasks the backend restored on entering the
 * system. Only non-zero counts are listed so an empty category adds no noise.
 */
export function RecoveryBanner(props: {
  report: RecoveryReport;
  onOpenTasks: () => void;
  onDismiss: () => void;
}) {
  const { report, onOpenTasks, onDismiss } = props;
  const total =
    report.queued +
    report.retried +
    report.awaitingApproval +
    report.awaitingMerge +
    report.failed;

  if (total === 0) return null;

  // `queued` and `retried` both end up back in the queue; the banner does not
  // ask the user to distinguish how a restored task got there.
  const requeued = report.queued + report.retried;
  const details: string[] = [];
  if (requeued > 0) details.push(t("settings.recovery.requeued", { n: requeued }));
  if (report.awaitingApproval > 0)
    details.push(t("settings.recovery.review", { n: report.awaitingApproval }));
  if (report.awaitingMerge > 0)
    details.push(t("settings.recovery.merge", { n: report.awaitingMerge }));
  if (report.failed > 0) details.push(t("settings.recovery.failed", { n: report.failed }));

  const hasFailures = report.failed > 0;
  const Icon = hasFailures ? AlertTriangle : RotateCcw;

  return (
    <div
      role="status"
      className={clsx(
        "mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2",
        hasFailures
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-sky-200 bg-sky-50 text-slate-700",
      )}
    >
      <Icon
        size={14}
        className={clsx("shrink-0", hasFailures ? "text-amber-500" : "text-sky-500")}
      />
      <p className="min-w-0 flex-1 text-ui-caption leading-5">
        {t("settings.recovery.summary", {
          total,
          details: details.join(getLocale() === "en" ? ", " : "，"),
        })}
        {report.queuePaused ? t("settings.recovery.paused") : null}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onOpenTasks}>
          {t("settings.recovery.viewTasks")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t("common.gotIt")}
        </Button>
      </div>
    </div>
  );
}
