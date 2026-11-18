/**
 * Desktop wrapper around the shared trajectory panel
 * (`apps/shared/agent/trajectory/TrajectoryView.tsx`): injects the desktop
 * locale and the panel variant. The ledger pane reads the same committed
 * history the transcript does.
 */
import { useLocale } from "../../lib/i18n";
import { TrajectoryView as SharedTrajectoryView } from "../../../../shared/agent/trajectory/TrajectoryView";
import type { LiveTraceInput } from "./model";
import type { DshEntry } from "../../lib/dsh";

type Props = {
  entries: readonly DshEntry[];
  live: LiveTraceInput | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
};

export function TrajectoryView({ entries, live, loading, failed, onRetry }: Props) {
  const locale = useLocale();
  return (
    <SharedTrajectoryView
      entries={entries}
      locale={locale}
      live={live}
      loading={loading}
      failed={failed}
      onRetry={onRetry}
      inspectorVariant="panel"
    />
  );
}
