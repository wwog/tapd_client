import { useEffect, useState } from "react";
import { LoaderCircle, Plus, X } from "lucide-react";

import { TerminalFolderSheet } from "../components/TerminalFolderSheet";
import { asApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { navigate } from "../lib/router";
import { terminalApi, type TerminalMeta } from "../lib/terminal";
import { isPageHidden } from "../lib/visibility";

const POLL_MS = 10_000;

/**
 * Terminal sessions owned by the desktop. The desktop can create and close
 * sessions while this page is open, so the list refreshes on a timer instead
 * of being kept in sync by hand.
 */
export function TerminalPage() {
  const [sessions, setSessions] = useState<TerminalMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void terminalApi
        .list()
        .then(({ sessions: list }) => {
          if (cancelled) return;
          setSessions(list);
          setError(null);
        })
        .catch((err) => {
          if (!cancelled) setError(asApiError(err).message);
        });
    };
    load();
    const timer = window.setInterval(() => {
      if (!isPageHidden()) load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const create = async (workspaceId?: string) => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { session } = await terminalApi.create(
        workspaceId ? { workspaceId } : {},
      );
      navigate(`#/terminal/s/${encodeURIComponent(session.id)}`);
    } catch (err) {
      setCreateError(asApiError(err).message);
    } finally {
      setCreating(false);
    }
  };

  const openFolderSheet = () => {
    setCreateError(null);
    setFolderOpen(true);
  };

  const close = async (id: string) => {
    if (closingId) return;
    setClosingId(id);
    setCloseError(null);
    try {
      await terminalApi.close(id);
      setSessions((current) => current?.filter((session) => session.id !== id) ?? current);
    } catch (err) {
      setCloseError(asApiError(err).message);
    } finally {
      setClosingId(null);
    }
  };

  return (
    <div data-component="TerminalPage">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-canvas px-4 py-3">
        <h1 className="text-ui-base text-slate-900">{t("mobile.terminal.title")}</h1>
        <button
          type="button"
          aria-label={t("mobile.terminal.new")}
          title={t("mobile.terminal.new")}
          disabled={creating}
          onClick={openFolderSheet}
          className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {creating ? <LoaderCircle size={16} className="animate-spin" /> : <Plus size={16} />}
        </button>
      </header>

      {error ? (
        <p className="px-4 pt-3 pb-2 text-ui-caption text-rose-600" title={t("mobile.terminal.loadFailed")}>
          {error}
        </p>
      ) : null}
      {createError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
          title={t("mobile.terminal.createFailed")}
        >
          {createError}
        </p>
      ) : null}
      {closeError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
          title={t("mobile.terminal.closeFailed")}
        >
          {closeError}
        </p>
      ) : null}

      {sessions === null && !error ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          {t("mobile.terminal.loading")}
        </div>
      ) : null}

      {sessions && sessions.length === 0 && !error ? (
        <div className="px-4 py-10 text-center">
          <p className="text-ui-base text-slate-400" title={t("mobile.terminal.emptyHint")}>
            {t("mobile.terminal.empty")}
          </p>
          <button
            type="button"
            disabled={creating}
            onClick={openFolderSheet}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
          >
            <Plus size={14} />
            {t("mobile.terminal.new")}
          </button>
        </div>
      ) : null}

      {sessions?.map((session) => (
        <div key={session.id} className="flex items-stretch border-b border-border">
          <button
            type="button"
            onClick={() => navigate(`#/terminal/s/${encodeURIComponent(session.id)}`)}
            className="min-w-0 flex-1 px-4 py-3 text-left transition active:bg-overlay-soft"
          >
            <span className="block truncate text-ui-caption text-slate-900">
              {session.title || session.cwd}
            </span>
            <span className="mt-1 flex items-center gap-2 text-ui-xs text-slate-500">
              <span className="truncate font-mono">{session.cwd}</span>
              {session.exited !== null ? (
                <span className="shrink-0 text-slate-400">{t("mobile.terminal.exited")}</span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            aria-label={t("mobile.terminal.close")}
            disabled={closingId === session.id}
            onClick={() => void close(session.id)}
            className="flex shrink-0 items-center px-3 text-slate-400 transition active:bg-overlay-soft disabled:opacity-40"
          >
            <X size={15} />
          </button>
        </div>
      ))}

      <TerminalFolderSheet
        open={folderOpen}
        busy={creating}
        error={createError}
        onClose={() => setFolderOpen(false)}
        onCreate={(workspaceId) => void create(workspaceId)}
      />
    </div>
  );
}
