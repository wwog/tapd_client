import { Bot, ChevronDown, Download, Loader2, UserPlus } from "lucide-react";

import {
  agentInFlightLabel,
  type AgentInFlight,
} from "../lib/agent";
import type { BugDetail, ExportResult } from "../lib/api";
import { formatBytes } from "../lib/format";
import { t } from "../lib/i18n";
import { useCurrentAgent } from "../lib/useCurrentAgent";
import { Button } from "./ui";

type Props = {
  detail: BugDetail;
  mine: boolean;
  /** The single write action currently in flight (claim/comment/field/status). */
  busy: string | null;
  exporting: boolean;
  loading: boolean;
  lastExport: ExportResult | null;
  agentInfo: AgentInFlight | null;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
  onClaim: () => void;
  onAgentFix: (detail: BugDetail) => void;
  onAgentCompose: (detail: BugDetail) => void;
  onOpenAgentTask?: (taskId: string) => void;
  onExport: (detail: BugDetail) => void;
};

/** Sticky action footer: last export, claim, Agent and bug.json export. */
export function BugDrawerFooter(props: Props) {
  const {
    detail,
    mine,
    busy,
    exporting,
    loading,
    lastExport,
    agentInfo,
    onOpenPath,
    onCopy,
    onClaim,
    onAgentFix,
    onAgentCompose,
    onOpenAgentTask,
    onExport,
  } = props;
  /** Runtime the 修复 button will launch, from 设置 →「默认 Agent」. */
  const currentAgent = useCurrentAgent();

  return (
    <div className="shrink-0 border-t border-slate-100 bg-surface px-4 py-3">
      {lastExport ? (
        <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-ui-xs leading-4 text-emerald-900">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-normal">
              {t("bugs.exported", {
                count: lastExport.assetCount,
                size: formatBytes(lastExport.downloadedBytes),
              })}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpenPath(lastExport.dir)}
                className="rounded border border-emerald-300 bg-surface px-1.5 py-0.5"
              >
                {t("bugs.openFolder")}
              </button>
              <button
                type="button"
                onClick={() => onCopy(lastExport.bugJson)}
                className="rounded border border-emerald-300 bg-surface px-1.5 py-0.5"
              >
                {t("bugs.copyPath")}
              </button>
            </div>
          </div>
          <div className="mt-0.5 truncate font-mono text-emerald-700" title={lastExport.bugJson}>
            {lastExport.bugJson}
          </div>
          {lastExport.warnings.length > 0 ? (
            <div className="mt-1 truncate text-amber-700" title={lastExport.warnings.join("；")}>
              {lastExport.warnings.length > 1
                ? t("bugs.warningsMore", {
                    first: lastExport.warnings[0],
                    count: lastExport.warnings.length,
                  })
                : lastExport.warnings[0]}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {!mine ? (
          <Button
            size="sm"
            variant="primary"
            icon={<UserPlus size={13} />}
            loading={busy === "claim"}
            disabled={busy !== null && busy !== "claim"}
            onClick={onClaim}
          >
            {t("bugs.claim")}
          </Button>
        ) : null}
        {mine ? (
          agentInfo ? (
            <Button
              size="sm"
              variant="primary"
              icon={
                agentInfo.task.status === "preparing" ||
                agentInfo.task.status === "running" ||
                agentInfo.task.status === "merging" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Bot size={13} />
                )
              }
              title={t("bugs.agentQueued")}
              onClick={() => onOpenAgentTask?.(agentInfo.task.id)}
            >
              {t("bugs.viewTaskLabel", { label: agentInFlightLabel(agentInfo) })}
            </Button>
          ) : (
            <div className="inline-flex">
              <Button
                size="sm"
                variant="primary"
                className="rounded-r-none"
                icon={<Bot size={13} />}
                title={
                  currentAgent
                    ? t("bugs.currentAgent", {
                        name: currentAgent.name,
                        binary: currentAgent.binary,
                      })
                    : t("bugs.loadingAgent")
                }
                disabled={exporting || loading}
                onClick={() => onAgentFix(detail)}
              >
                {t("bugs.fixWith", {
                  agent: currentAgent?.name ?? "Agent",
                })}
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="rounded-l-none border-l border-primary-foreground/20 px-2"
                title={t("bugs.startWithNote")}
                aria-label={t("bugs.startWithNote")}
                disabled={exporting || loading}
                onClick={() => onAgentCompose(detail)}
              >
                <ChevronDown size={13} />
              </Button>
            </div>
          )
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={13} />}
          loading={exporting}
          onClick={() => onExport(detail)}
        >
          {exporting ? t("bugs.exporting") : t("bugs.export")}
        </Button>
      </div>
    </div>
  );
}
