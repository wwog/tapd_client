import { Users } from "lucide-react";

import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { COWORKER_GUIDE_URL } from "../lib/links";
import { CoworkerGrid, useCoworkers } from "../components/CoworkerPicker";
import { Button } from "../components/ui";

type Toast = (kind: "ok" | "error", text: string) => void;

/**
 * 同事 selection inside the Agent configuration dialog. Team collaboration off
 * writes the picked roles and skill paths into every task prompt; on, the
 * board assigns the work instead.
 */
export function CoworkerSettings({ toast }: { toast: Toast }) {
  const selection = useCoworkers(toast);
  const { selected, selectedIds } = selection;
  const names = selected
    .map((coworker) => coworker.name)
    .join(t("coworker.nameSeparator"));

  const openLink = () => {
    void api.openPath(COWORKER_GUIDE_URL).catch((error) => toast("error", String(error)));
  };

  return (
    <div data-component="CoworkerSettings" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          className="flex items-center gap-1.5 text-ui-base text-slate-900"
          title={t("coworker.pageIntro")}
        >
          <Users size={14} className="text-slate-400" />
          {t("agent.config.nav.coworkers")}
        </h2>
        <span
          className="min-w-0 flex-1 truncate text-ui-xs text-slate-400"
          title={names}
        >
          {selected.length > 0
            ? t("coworker.currentNames", { names })
            : t("coworker.solo")}
        </span>
        <Button size="sm" onClick={openLink}>
          {t("coworker.submissionGuide")}
        </Button>
        {selectedIds.length > 0 ? (
          <button
            type="button"
            disabled={selection.busy}
            onClick={selection.clear}
            className="rounded-lg px-1.5 py-0.5 text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-700 disabled:opacity-50"
          >
            {t("common.clear")}
          </button>
        ) : null}
      </div>

      {selection.warnings.length > 0 ? (
        <details className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
          <summary className="cursor-pointer select-none text-ui-sm text-amber-800">
            {t("coworker.warnings", { n: selection.warnings.length })}
          </summary>
          <ul className="mt-1.5 space-y-1">
            {selection.warnings.map((warning, index) => (
              <li
                key={`${index}-${warning}`}
                className="break-all text-ui-xs leading-4 text-amber-700"
              >
                {warning}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {selection.promptSection ? (
        <details className="rounded-xl border border-border bg-slate-50/60 px-3 py-2">
          <summary className="cursor-pointer select-none text-ui-sm text-slate-500">
            {t("coworker.promptSection")}
          </summary>
          <pre className="mt-2 max-h-52 select-text overflow-auto whitespace-pre-wrap break-all font-mono text-ui-xs leading-5 text-slate-600">
            {selection.promptSection}
          </pre>
        </details>
      ) : null}

      <CoworkerGrid
        coworkers={selection.coworkers}
        selectedIds={selectedIds}
        busy={selection.busy}
        loadError={selection.loadError}
        onRetry={() => void selection.reload()}
        onToggle={selection.toggle}
      />
    </div>
  );
}
