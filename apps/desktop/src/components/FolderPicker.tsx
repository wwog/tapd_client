import { useEffect, useState } from "react";
import { ArrowUp, Check, Folder, FolderOpen, Loader2, X } from "lucide-react";
import clsx from "clsx";

import { api, type DirListing } from "../lib/api";
import { Button, ModalDragStrip } from "./ui";

/**
 * Dependency-free folder picker: browses directories through the Rust side
 * (`list_dirs`), which also resolves a dropped file to its parent folder.
 */
export function FolderPicker(props: {
  open: boolean;
  /** Starting folder; empty means the user's home directory. */
  initialPath?: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const {
    open,
    initialPath,
    title = "选择项目文件夹",
    description,
    confirmLabel = "使用此文件夹",
    onCancel,
    onSelect,
  } = props;
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");

  const load = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.listDirs(path);
      setListing(next);
      setPathInput(next.path);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setListing(null);
    void load(initialPath || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[2px]">
      <ModalDragStrip />
      <div className="relative z-10 flex h-[520px] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl bg-surface  border border-black/10">
        <div
          data-tauri-drag-region
          className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3"
        >
          <div className="min-w-0" data-tauri-drag-region>
            <h2 data-tauri-drag-region className="text-ui-base font-normal text-slate-900">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-ui-sm leading-5 text-slate-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
          <button
            type="button"
            aria-label="上一级"
            title="上一级"
            disabled={!listing?.parent || loading}
            onClick={() => void load(listing?.parent ?? undefined)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 disabled:opacity-40"
          >
            <ArrowUp size={14} />
          </button>
          <input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load(pathInput);
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-border bg-slate-50 px-2.5 py-1.5 font-mono text-ui-sm text-slate-600 transition focus:border-sky-300 focus:bg-surface focus:outline-2 focus:outline-sky-200"
          />
          <Button size="sm" variant="secondary" onClick={() => void load(pathInput)}>
            前往
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex h-24 items-center justify-center gap-2 text-ui-caption text-slate-400">
              <Loader2 size={14} className="animate-spin" />
              读取目录…
            </div>
          ) : error ? (
            <div className="m-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-ui-sm leading-5 text-rose-700">
              {error}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {(listing?.entries ?? []).map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => void load(entry.path)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-caption text-slate-700 transition hover:bg-slate-50"
                  >
                    <Folder size={14} className="shrink-0 text-sky-500" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
              {listing && listing.entries.length === 0 ? (
                <li className="px-3 py-6 text-center text-ui-sm text-slate-400">
                  这里没有子文件夹
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-sm text-slate-400">
            <FolderOpen size={13} className="shrink-0 text-slate-400" />
            <span className="truncate font-mono" title={listing?.path}>
              {listing?.path ?? "—"}
            </span>
          </div>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!listing || loading}
            onClick={() => listing && onSelect(listing.path)}
            icon={<Check size={13} />}
            className={clsx(!listing && "opacity-50")}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
