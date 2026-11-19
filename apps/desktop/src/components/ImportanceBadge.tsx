import { t, type MessageKey } from "../lib/i18n";
import type { WorkItemImportance } from "../lib/local";
import { Badge, type BadgeTone } from "./ui";

const LABEL: Record<WorkItemImportance, MessageKey> = {
  low: "local.importance.low",
  normal: "local.importance.normal",
  high: "local.importance.high",
};

const TONE: Record<WorkItemImportance, BadgeTone> = {
  low: "neutral",
  normal: "blue",
  high: "red",
};

/** The one importance mark used by rows, the detail panel and the dialog. */
export function ImportanceBadge({
  value,
  className,
}: {
  value: WorkItemImportance;
  className?: string;
}) {
  return (
    <Badge tone={TONE[value]} className={className}>
      {t(LABEL[value])}
    </Badge>
  );
}
