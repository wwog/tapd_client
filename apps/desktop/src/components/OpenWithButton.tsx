import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileImage,
  FileText,
  FileVideo,
  FolderGit2,
  Loader2,
} from "lucide-react";
import clsx from "clsx";

import { api, type OpenTarget, type OpenTargetSet } from "../lib/api";
import { useDismiss } from "../hooks/useDismiss";
import { t } from "../lib/i18n";

/** Resource kinds the backend builds an app list for. */
export type OpenKind = "file" | "image" | "video" | "directory";

type Props = {
  kind: OpenKind;
  /** Shown in the tooltip; opening itself uses whatever `onOpen` resolves. */
  path: string;
  /** Opens with `target`, or with the remembered app when omitted. */
  onOpen: (target?: string) => void | Promise<void>;
  onError: (message: string) => void;
};

/**
 * "打开方式" split button: the left half opens with the remembered app, the
 * caret lists every app that can take this kind (系统默认, editors, players,
 * browsers, Finder) and remembers the pick per kind.
 *
 * Shared by the project folder headers and the file viewer, so a file always
 * has a visible way out to a native app instead of a lone external-link icon.
 */
export function OpenWithButton({ kind, path, onOpen, onError }: Props) {
  const [targets, setTargets] = useState<OpenTargetSet | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTargets(null);

    void api
      .openTargets(kind)
      .then((set) => {
        if (!cancelled) setTargets(set);
      })
      .catch(() => {
        // Icons are decoration: the button still opens with the saved app.
      });

    return () => {
      cancelled = true;
    };
  }, [kind]);

  useDismiss(menuOpen, rootRef, () => setMenuOpen(false), {
    resize: true,
    blur: true,
  });

  const selected =
    targets?.targets.find((target) => target.id === targets.selected) ?? null;

  const open = async (target?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      // The visible choice wins even if saving it is still in flight.
      await onOpen(target);
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
      .setOpenTarget(kind, id)
      .catch((error) => onError(String(error)));
    // 「用以下应用打开」means open now, not only change the default.
    void open(id);
  };

  return (
    <div data-component="OpenWithButton" ref={rootRef} className="relative shrink-0">
      <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-border bg-surface text-ui-sm text-slate-600">
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy}
          title={t("app.open.with", {
            app: selected?.label ?? t("app.open.defaultApp"),
            path,
          })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 transition hover:bg-slate-50 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={13} className="shrink-0 animate-spin" />
          ) : (
            <TargetIcon target={selected} kind={kind} />
          )}
          {t("common.open")}
        </button>
        <button
          type="button"
          aria-label={t("app.open.chooseAppFor")}
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
                <TargetIcon target={target} kind={kind} />
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

function TargetIcon({ target, kind }: { target: OpenTarget | null; kind: OpenKind }) {
  if (target?.icon) {
    return (
      <img
        data-component="TargetIcon"
        src={target.icon}
        alt={target.label}
        className="h-4 w-4 shrink-0 rounded-[4px] object-contain"
      />
    );
  }
  switch (kind) {
    case "image":
      return <FileImage size={13} className="shrink-0" />;
    case "video":
      return <FileVideo size={13} className="shrink-0" />;
    case "directory":
      return <FolderGit2 size={13} className="shrink-0" />;
    default:
      return <FileText size={13} className="shrink-0" />;
  }
}
