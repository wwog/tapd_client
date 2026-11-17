/**
 * Desktop wrapper around the shared trajectory panel
 * (`apps/shared/agent/trajectory/TrajectoryView.tsx`): injects the desktop
 * locale and adapts the store's `trajectoryFocus` request to the shared
 * `focus` prop. The ledger pane reads the same committed history the
 * transcript does.
 */
import { useLocale } from "../../lib/i18n";
import { TrajectoryView as SharedTrajectoryView } from "../../../../shared/agent/trajectory/TrajectoryView";
import type { LiveTraceInput } from "./model";
import type { DshEntry } from "../../lib/dsh";
import { agentStore } from "../store";

type Props = {
  sessionId: string;
  entries: readonly DshEntry[];
  live: LiveTraceInput | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
};

export function TrajectoryView({ sessionId, entries, live, loading, failed, onRetry }: Props) {
  const locale = useLocale();
  const request = agentStore.use().trajectoryFocus;
  const focus =
    request && request.sessionId === sessionId
      ? { recordId: request.recordId, nonce: request.nonce }
      : null;
  return (
    <SharedTrajectoryView
      entries={entries}
      locale={locale}
      live={live}
      loading={loading}
      failed={failed}
      onRetry={onRetry}
      focus={focus}
      inspectorVariant="panel"
    />
  );
}
