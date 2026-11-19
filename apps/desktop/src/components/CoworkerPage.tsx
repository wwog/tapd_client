import { Users } from "lucide-react";

import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { COWORKER_GUIDE_URL } from "../lib/links";
import { CoworkerGrid, useCoworkers } from "./CoworkerPicker";
import { Button } from "./ui";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * 同事页：勾选一起干活的同事。团队协作关闭时，启用的同事把角色、简述和技能包
 * 路径带进每一次 Agent 任务的提示词；开启后提示词不再写名单，工作由任务板分配。
 */
export function CoworkerPage({ toast }: Props) {
  const selection = useCoworkers(toast);
  const { selected, selectedIds } = selection;

  const openLink = (url: string) => {
    void api.openPath(url).catch((error) => toast("error", String(error)));
  };

  return (
    <div data-component="CoworkerPage" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="flex items-center gap-1.5 text-ui-lg text-slate-900"
              title={t("coworker.pageIntro")}
            >
              <Users size={16} className="text-slate-400" />
              {t("coworker.pageTitle")}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => openLink(COWORKER_GUIDE_URL)}>
              {t("coworker.submissionGuide")}
            </Button>
            <span
              className="max-w-[260px] truncate text-ui-xs text-slate-400"
              title={selected.map((coworker) => coworker.name).join(t("coworker.nameSeparator"))}
            >
              {selected.length > 0
                ? t("coworker.currentNames", {
                    names: selected.map((coworker) => coworker.name).join(t("coworker.nameSeparator")),
                  })
                : t("coworker.solo")}
            </span>
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
        </div>

        {selection.warnings.length > 0 ? (
          <details className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
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
          <details className="mb-4 rounded-xl border border-border bg-slate-50/60 px-3 py-2">
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
    </div>
  );
}
