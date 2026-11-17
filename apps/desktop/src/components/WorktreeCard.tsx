/**
 * Worktrees the built-in agent created, as the project settings page sees them.
 *
 * Every task with an isolated worktree leaves one directory behind; deleting a
 * session removes its own, but a row that was lost (or a task from an older
 * build) can strand a directory forever. This card is the place that shows
 * them, points at the default target directory, and cleans one up.
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { FolderGit2, FolderOpen, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { dshWorktreeApi, type DshWorktree } from "../lib/dsh";
import { t } from "../lib/i18n";
import { relativeTime } from "../lib/api";
import { Button, cardClass } from "./ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { ScrollingName } from "./ScrollingName";

type State = { root: string; worktrees: DshWorktree[] } | null;

export function WorktreeCard({ toast }: { toast: (kind: "ok" | "error", text: string) => void }) {
  const [state, setState] = useState<State>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DshWorktree | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await dshWorktreeApi.list());
      setError(null);
    } catch (problem) {
      setError(String(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (path: string) => {
    void api.openPath(path).catch((problem) => toast("error", String(problem)));
  };

  const remove = async (target: DshWorktree) => {
    try {
      await dshWorktreeApi.remove(target.path);
      await load();
    } catch (problem) {
      toast("error", t("settings.worktrees.removeFailed", { error: String(problem) }));
    }
  };

  return (
    <section className={cardClass}>
      <div className="flex items-center gap-2">
        <h2
          className="flex min-w-0 items-center gap-2 text-ui-base text-slate-900"
          title={t("settings.worktrees.hint")}
        >
          <FolderGit2 size={15} className="text-slate-400" />
          {t("settings.worktrees.title")}
        </h2>
        {state && state.worktrees.length > 0 ? (
          <span className="shrink-0 text-ui-xs tabular-nums text-slate-400">
            {state.worktrees.length}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          icon={<FolderOpen size={12} />}
          disabled={!state?.root}
          onClick={() => state && open(state.root)}
        >
          {t("settings.worktrees.openRoot")}
        </Button>
      </div>

      <div className="mt-2 flex items-center gap-2 text-ui-xs text-slate-400">
        <span className="shrink-0">{t("settings.worktrees.root")}</span>
        <ScrollingName text={state?.root ?? "—"} className="min-w-0 flex-1 font-mono" />
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50 p-3 text-ui-sm leading-5 text-rose-700">
          <div className="break-all">{error}</div>
        </div>
      ) : state === null ? null : state.worktrees.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
          {t("settings.worktrees.empty")}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {state.worktrees.map((item) => (
            <div
              key={item.path}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-transparent py-1 pl-1 pr-1 transition hover:border-slate-100 hover:bg-slate-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ScrollingName
                    text={item.title || item.sessionId}
                    className="min-w-0 flex-1 text-ui-caption text-slate-700"
                  />
                  {item.orphan ? (
                    <span className="shrink-0 rounded bg-slate-100 px-1 text-ui-2xs text-slate-500">
                      {t("settings.worktrees.orphan")}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-400">
                  {item.project ? (
                    <span className="shrink-0">{item.project.name}</span>
                  ) : null}
                  <ScrollingName
                    text={item.path}
                    className={clsx("min-w-0 flex-1 font-mono")}
                  />
                  {item.updatedAt ? (
                    <span className="shrink-0 tabular-nums">
                      {relativeTime(item.updatedAt)}
                    </span>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                title={t("settings.worktrees.open")}
                onClick={() => open(item.path)}
                className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-overlay hover:text-slate-600"
              >
                <FolderOpen size={12} />
              </button>
              <button
                type="button"
                title={t("settings.worktrees.remove")}
                onClick={() => setRemoving(item)}
                className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-overlay hover:text-rose-600"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {removing ? (
        <ConfirmDialog
          title={t("settings.worktrees.remove")}
          message={t("settings.worktrees.removeHint", {
            title: removing.title || removing.sessionId,
          })}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            if (target) void remove(target);
          }}
        />
      ) : null}
    </section>
  );
}
