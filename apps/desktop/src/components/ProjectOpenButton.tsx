import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderGit2, Loader2 } from "lucide-react";
import clsx from "clsx";

import { agentApi } from "../lib/agent";
import { api, type OpenTarget, type OpenTargetSet } from "../lib/api";
import { useDismiss } from "../hooks/useDismiss";
import { t } from "../lib/i18n";

type Props = {
  workspaceId: string;
  onError: (message: string) => void;
};

/**
 * Header split button for the folder bound to a TAPD project: the left half
 * opens it in the current editor, the caret picks another one. The target set
 * is the `directory` kind, which only offers code editors (VS Code, Xcode,
 * Zed, Cursor) plus Finder — folders never go to a browser or image viewer.
 */
export function ProjectOpenButton({ workspaceId, onError }: Props) {
  const [repoPath, setRepoPath] = useState("");
  const [targets, setTargets] = useState<OpenTargetSet | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The folder lives in the agent config, so re-read it whenever the project
  // changes. Switching views remounts this button, which picks up edits made
  // in 项目管理.
  useEffect(() => {
    let cancelled = false;
    setRepoPath("");
    setTargets(null);

    void agentApi
      .configGet()
      .then(({ config }) => {
        if (cancelled) return;
        const path = (config.projects?.[workspaceId]?.repoPath ?? "").trim();
        setRepoPath(path);
        if (!path) return;
        return api
          .openTargets("directory")
          .then((set) => {
            if (!cancelled) setTargets(set);
          })
          .catch(() => {
            // Icons are decoration: the button still opens the folder.
          });
      })
      .catch(() => {
        // No config means no bound folder; the header stays clean.
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useDismiss(menuOpen, rootRef, () => setMenuOpen(false), {
    resize: true,
    blur: true,
  });

  if (!repoPath) return null;

  const selected =
    targets?.targets.find((target) => target.id === targets.selected) ?? null;

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The visible choice wins even if saving it is still in flight.
      await api.openDirectory(repoPath, targets?.selected);
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const select = (id: string) => {
    setMenuOpen(false);
    setTargets((current) => (current ? { ...current, selected: id } : current));
    void api
      .setOpenTarget("directory", id)
      .catch((error) => onError(String(error)));
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-border bg-surface text-ui-sm text-slate-600">
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy}
          title={t("app.open.with", {
            app: selected?.label ?? t("app.open.defaultApp"),
            path: repoPath,
          })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 transition hover:bg-slate-50 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={13} className="shrink-0 animate-spin" />
          ) : (
            <TargetIcon target={selected} />
          )}
          {t("common.open")}
        </button>
        <button
          type="button"
          aria-label={t("app.open.chooseApp")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
          className="border-l border-border px-1 transition hover:bg-slate-50"
        >
          <ChevronDown size={11} />
        </button>
      </div>

      {menuOpen ? (
        <div className="absolute right-0 z-50 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-surface py-1 ">
          <p className="px-3 py-1 text-ui-xs text-slate-400">{t("app.open.withList")}</p>
          {(targets?.targets ?? []).map((target) => {
            const active = target.id === targets?.selected;
            return (
              <button
                key={target.id}
                type="button"
                onClick={() => select(target.id)}
                className={clsx(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm transition hover:bg-slate-50",
                  active ? "text-slate-800" : "text-slate-600",
                )}
              >
                <TargetIcon target={target} />
                <span className="truncate">{target.label}</span>
                {active ? <Check size={12} className="ml-auto text-sky-500" /> : null}
              </button>
            );
          })}
          {targets && targets.targets.length === 0 ? (
            <p className="px-3 py-2 text-ui-sm text-slate-400">{t("app.open.noApps")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TargetIcon({ target }: { target: OpenTarget | null }) {
  if (target?.icon) {
    return (
      <img
        src={target.icon}
        alt={target.label}
        className="h-4 w-4 shrink-0 rounded-[4px] object-contain"
      />
    );
  }
  return <FolderGit2 size={13} className="shrink-0" />;
}
