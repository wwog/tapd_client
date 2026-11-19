import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, LoaderCircle } from "lucide-react";

import { api, asApiError, type DirListing } from "../lib/api";
import { t } from "../lib/i18n";
import { BottomSheet } from "./BottomSheet";

/** Turn a browse failure into a visible line; unknown codes keep the message. */
const pickerError = (err: unknown): string => {
  const failure = asApiError(err);
  if (failure.code === "forbidden") return t("mobile.local.picker.forbidden");
  if (failure.code === "not_found") return t("mobile.local.picker.notFound");
  return failure.message || t("mobile.local.picker.loadFailed");
};

/**
 * Directory picker for a new local project. Opens at the home directory and
 * only navigates into paths the desktop returned, so the phone can never ask
 * for a folder outside the backend's allowed roots.
 */
export function DirectoryPickerSheet(props: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Later navigations win: a slow earlier response is dropped.
  const seq = useRef(0);

  const browse = useCallback((path?: string | null) => {
    const request = ++seq.current;
    setLoading(true);
    setError(null);
    void api
      .browseDirs(path)
      .then((data) => {
        if (request === seq.current) setListing(data);
      })
      .catch((err) => {
        if (request === seq.current) setError(pickerError(err));
      })
      .finally(() => {
        if (request === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!props.open) return;
    setListing(null);
    browse();
  }, [props.open, browse]);

  return (
    <BottomSheet
      open={props.open}
      title={t("mobile.local.picker.title")}
      onClose={props.onClose}
      footer={
        <button
          type="button"
          disabled={!listing || loading}
          onClick={() => {
            if (listing) props.onPick(listing.path);
          }}
          className="min-h-11 w-full rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
        >
          {t("mobile.local.picker.confirm")}
        </button>
      }
    >
      <div className="-mx-4 -my-3 [&>*:last-child]:border-b-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <button
            type="button"
            aria-label={t("mobile.local.picker.parent")}
            disabled={!listing?.parent || loading}
            onClick={() => {
              if (listing?.parent) browse(listing.parent);
            }}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
          >
            <ArrowUp size={15} />
          </button>
          <span
            className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-500"
            title={listing?.path ?? ""}
          >
            {listing?.path || t("common.loadingEllipsis")}
          </span>
          {loading ? (
            <LoaderCircle size={14} className="shrink-0 animate-spin text-slate-400" />
          ) : null}
        </div>

        {error ? (
          <p className="border-b border-border px-4 py-3 text-ui-caption text-rose-600">
            {error}
          </p>
        ) : null}

        {!error && listing && listing.entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-ui-base text-slate-400">
            {t("mobile.local.picker.empty")}
          </p>
        ) : null}

        {/* A failed navigation keeps the last readable folder on screen so the
            user can pick it or go up instead of starting over. */}
        {listing?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => browse(entry.path)}
            className="flex min-h-11 w-full items-center gap-2 border-b border-border px-4 text-left transition active:bg-overlay-soft"
          >
            <Folder size={15} className="shrink-0 text-slate-400" />
            <span
              className="min-w-0 flex-1 truncate text-ui-caption text-slate-900"
              title={entry.name}
            >
              {entry.name}
            </span>
            <ChevronRight size={14} className="shrink-0 text-slate-400" />
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
