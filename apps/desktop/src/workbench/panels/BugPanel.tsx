import { BugDetailDrawer } from "../../components/BugDetailDrawer";
import { usePanelServices, type PanelProps } from "./context";

/**
 * The singleton bug detail panel. The drawer is reused unchanged; the group
 * card supplies the chrome, so the drawer's own card border is neutralized.
 */
export function BugPanel({ active }: PanelProps) {
  const { bug } = usePanelServices();

  return (
    <div className="h-full [&>aside]:h-full [&>aside]:rounded-none [&>aside]:border-0">
      <BugDetailDrawer
        open={active}
        detail={bug.detail}
        loading={bug.loading}
        error={bug.error}
        exporting={bug.exporting}
        lastExport={bug.lastExport}
        onOpenWeb={bug.onOpenWeb}
        onCopy={bug.onCopy}
        onExport={bug.onExport}
        onAgentFix={bug.onAgentFix}
        onAgentCompose={bug.onAgentCompose}
        agentInFlight={bug.agentInFlight}
        onOpenAgentTask={bug.onOpenAgentTask}
        onOpenPath={bug.onOpenPath}
        onOpenMedia={bug.onOpenMedia}
        me={bug.me}
        members={bug.members}
        membersLoading={bug.membersLoading}
        onRefreshMembers={bug.onRefreshMembers}
        onClaim={bug.onClaim}
        onAddComment={bug.onAddComment}
        onChangeField={bug.onChangeField}
        onTransition={bug.onTransition}
      />
    </div>
  );
}
