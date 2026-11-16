import { useState } from "react";
import { Download, Sparkles, UserPlus } from "lucide-react";

import type { BugDetail, ExportResult } from "../lib/api";
import { formatBytes } from "../lib/format";
import { t } from "../lib/i18n";
import { EnqueueSheet } from "../agent/EnqueueSheet";
import { Button } from "./ui";

type Props = {
  detail: BugDetail;
  mine: boolean;
  /** The single write action currently in flight (claim/comment/field/status). */
  busy: string | null;
  exporting: boolean;
  lastExport: ExportResult | null;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
  onClaim: () => void;
  onExport: (detail: BugDetail) => void;
};

/** Sticky action footer: last export, claim, Agent hand-over and bug.json export. */
export function BugDrawerFooter(props: Props) {
  const {
    detail,
    mine,
    busy,
    exporting,
    lastExport,
    onOpenPath,
    onCopy,
    onClaim,
    onExport,
  } = props;
  const [enqueueOpen, setEnqueueOpen] = useState(false);

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
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon={<Sparkles size={13} />}
            title={t("agent.enqueue.bugHint")}
            onClick={() => setEnqueueOpen(true)}
          >
            {t("bugs.fixWithAgent")}
          </Button>
        )}
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

      {enqueueOpen ? (
        <EnqueueSheet
          target={{
            kind: "bug",
            workspaceId: detail.workspaceId,
            bugId: detail.id,
            title: detail.title,
          }}
          onClose={() => setEnqueueOpen(false)}
        />
      ) : null}
    </div>
  );
}
