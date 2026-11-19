import { t } from "../lib/i18n";
import { Button } from "../components/ui";
import { agentActions, type PendingApproval } from "./store";

/** One approval request, answered by RPC id. Only "allow once" executes. */
export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  return (
    <section
      data-component="ApprovalCard"
      className="rounded-xl border border-amber-200 bg-amber-50/40 px-3 py-2"
      title={t("agent.approval.hint")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-slate-700">
            <span className="shrink-0">{t("agent.approval.title")}</span>
            <span className="truncate font-mono text-ui-xs text-slate-500">
              {approval.toolName}
            </span>
          </div>
          {approval.reason ? (
            <div className="mt-0.5 break-all text-ui-xs leading-5 text-slate-500 select-text">
              {approval.reason}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={approval.busy}
            onClick={() => void agentActions.answerApproval(approval.rpcId, "allowed-once")}
          >
            {t("agent.approval.allow")}
          </Button>
          <Button
            size="sm"
            disabled={approval.busy}
            onClick={() => void agentActions.answerApproval(approval.rpcId, "rejected")}
          >
            {t("agent.approval.reject")}
          </Button>
        </div>
      </div>
    </section>
  );
}
