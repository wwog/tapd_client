import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { api, asApiError, type Workspace } from "../lib/api";
import { t } from "../lib/i18n";
import { BottomSheet } from "./BottomSheet";

/**
 * Folder picker for a new terminal: the home directory, or a project's
 * configured repo path. The project list is fetched on every open because the
 * desktop can change a project's folder while this page is mounted.
 */
export function TerminalFolderSheet(props: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (workspaceId?: string) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row started the create, so its spinner replaces nothing else.
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setWorkspaces(null);
    setLoadError(null);
    setPending(null);
    void api
      .workspaces()
      .then((context) => {
        if (!cancelled) setWorkspaces(context.workspaces);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(asApiError(err).message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  // A failed create ends `busy`; the row goes back to its idle state.
  useEffect(() => {
    if (!props.busy) setPending(null);
  }, [props.busy]);

  const pick = (key: string, workspaceId?: string) => {
    if (props.busy) return;
    setPending(key);
    props.onCreate(workspaceId);
  };

  return (
    <BottomSheet
      open={props.open}
      title={t("mobile.terminal.chooseFolder")}
      onClose={props.onClose}
    >
      <div className="-mx-4 -my-3">
        {props.error ? (
          <p
            className="border-b border-border px-4 py-2 text-ui-caption text-rose-600"
            title={t("mobile.terminal.createFailed")}
          >
            {props.error}
          </p>
        ) : null}

        <button
          type="button"
          disabled={props.busy}
          onClick={() => pick("home")}
          className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft disabled:opacity-40"
        >
          <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900">
            {t("mobile.terminal.homeFolder")}
          </span>
          {pending === "home" ? (
            <LoaderCircle size={14} className="shrink-0 animate-spin text-slate-400" />
          ) : null}
        </button>

        <h3 className="px-4 pb-1.5 pt-3 text-ui-sm text-slate-500">
          {t("mobile.terminal.projectFolders")}
        </h3>

        {loadError ? (
          <p
            className="px-4 py-3 text-ui-caption text-rose-600"
            title={t("mobile.terminal.loadFailed")}
          >
            {loadError}
          </p>
        ) : null}

        {workspaces === null && !loadError ? (
          <div className="space-y-2 px-4 py-3">
            <div className="h-4 w-2/3 animate-pulse rounded bg-overlay-soft" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-overlay-soft" />
          </div>
        ) : null}

        {workspaces?.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            disabled={props.busy}
            onClick={() => pick(workspace.id, workspace.id)}
            className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft disabled:opacity-40"
          >
            <span
              className="min-w-0 flex-1 truncate text-ui-caption text-slate-900"
              title={workspace.name}
            >
              {workspace.name}
            </span>
            {pending === workspace.id ? (
              <LoaderCircle size={14} className="shrink-0 animate-spin text-slate-400" />
            ) : null}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
