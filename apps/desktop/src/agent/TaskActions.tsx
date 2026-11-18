import { useState } from "react";
import { FolderOpen } from "lucide-react";

import { api } from "../lib/api";
import type { DshTask } from "../lib/dsh";
import { t } from "../lib/i18n";
import { Button } from "../components/ui";

function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

/**
 * The small strip above the transcript for workflow tasks. Review decisions
 * live in `ReviewView`; what is left here is the export folder of a failed or
 * canceled task, which the reader cannot reach from anywhere else.
 * Chat tasks have no bar: they are a plain conversation.
 */
export function TaskActions({ task }: { task: DshTask }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportDir = task.jsonPath ? dirName(task.jsonPath) : "";
  const showExport =
    Boolean(exportDir) && (task.workflow === "failed" || task.workflow === "canceled");

  if (!showExport) return null;

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.openPath(exportDir);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-border px-5 py-2">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            icon={<FolderOpen size={13} />}
            loading={busy}
            onClick={() => void open()}
          >
            {t("agent.task.openExport")}
          </Button>
        </div>
        {error ? (
          <div className="select-text break-all text-ui-xs text-rose-600">{error}</div>
        ) : null}
      </div>
    </div>
  );
}
