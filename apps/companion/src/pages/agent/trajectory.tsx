/**
 * Host re-export of the shared trajectory view. The mobile session page calls
 * it with `inspectorVariant="sheet"`; the shared view renders the inline panel
 * for both variants today, so a bottom-sheet inspector remains a waiting point
 * tracked with the shared view (the call subset is already compatible).
 */
export {
  TrajectoryView,
  type TrajectoryViewProps,
} from "../../../../shared/agent/trajectory/TrajectoryView";
