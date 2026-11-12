import clsx from "clsx";
import { AlertTriangle, RotateCcw } from "lucide-react";

import type { RecoveryReport } from "../lib/agent";
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
  if (requeued > 0) details.push(`${requeued} 个已重新排队`);
  if (report.awaitingApproval > 0) details.push(`${report.awaitingApproval} 个待审核`);
  if (report.awaitingMerge > 0) details.push(`${report.awaitingMerge} 个待合并`);
  if (report.failed > 0) details.push(`${report.failed} 个失败`);

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
        已恢复 {total} 个任务：{details.join("，")}。
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onOpenTasks}>
          查看任务
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          知道了
        </Button>
      </div>
    </div>
  );
}
