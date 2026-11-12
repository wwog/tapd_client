import clsx from "clsx";
import { ArrowRight, GitBranch, Sparkles, Users } from "lucide-react";

import { api } from "../lib/api";
import { COWORKER_FORK_URL, COWORKER_GUIDE_URL } from "../lib/links";
import { CoworkerGrid, useCoworkers } from "./CoworkerPicker";
import { Button } from "./ui";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * 同事页：勾选一起干活的同事。启用的同事把角色、简述和技能包路径带进
 * 每一次 Agent 任务的提示词；可叠加，也可随时清空回到单干。
 */
export function CoworkerPage({ toast }: Props) {
  const selection = useCoworkers(toast);
  const { selected, selectedIds } = selection;

  const openLink = (url: string) => {
    void api.openPath(url).catch((error) => toast("error", String(error)));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-ui-lg text-slate-900">
              <Users size={16} className="text-slate-400" />
              找同事搭伙
            </h2>
            <p className="mt-1 text-ui-sm text-slate-500">
              找同事一起干活吧，工作不是一个人的工作。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="max-w-[260px] truncate text-ui-xs text-slate-400"
              title={selected.map((coworker) => coworker.name).join("、")}
            >
              {selected.length > 0
                ? `当前搭子：${selected.map((coworker) => coworker.name).join("、")}`
                : "今天单干"}
            </span>
            {selectedIds.length > 0 ? (
              <button
                type="button"
                disabled={selection.busy}
                onClick={selection.clear}
                className="rounded-lg px-1.5 py-0.5 text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-700 disabled:opacity-50"
              >
                清空
              </button>
            ) : null}
          </div>
        </div>

        {selection.warnings.length > 0 ? (
          <details className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
            <summary className="cursor-pointer select-none text-ui-sm text-amber-800">
              {selection.warnings.length} 条同事包告警
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
              将写入 Agent 提示词的内容
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

        <section className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-ui-base text-slate-800">
                <Sparkles size={14} className="text-amber-500" />
                技能征集
              </h3>
              <p className="mt-1 max-w-2xl text-ui-sm leading-5 text-slate-500">
                你的独门手艺，也值得成为下一位同事。带上角色、头像和技能包来投。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => openLink(COWORKER_GUIDE_URL)}>
                投稿规范
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<GitBranch size={13} />}
                onClick={() => openLink(COWORKER_FORK_URL)}
              >
                Fork 项目
              </Button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-ui-xs text-slate-500">
            <Step label="fork" />
            <ArrowRight size={11} className="text-slate-300" />
            <Step label="assets/coworker/<id>/" mono />
            <ArrowRight size={11} className="text-slate-300" />
            <Step label="PR" />
            <span className="ml-1 text-slate-400">
              规范见 README；
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

function Step({ label, mono = false }: { label: string; mono?: boolean }) {
  return (
    <span
      className={clsx(
        "rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-slate-600",
        mono && "font-mono",
      )}
    >
      {label}
    </span>
  );
}
