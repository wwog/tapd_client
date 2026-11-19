import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";

import {
  api,
  asApiError,
  type LocalProject,
  type ProjectAgentConfig,
  type Workspace,
} from "../lib/api";
import { t } from "../lib/i18n";
import { BottomSheet } from "./BottomSheet";

/** Everything the sheet needs, fetched together on each open. */
type FolderSources = {
  workspaces: Workspace[];
  localProjects: LocalProject[];
  /** null when the config read failed: show every workspace instead of none. */
  repoPaths: Record<string, ProjectAgentConfig> | null;
};

/**
 * Folder picker for a new terminal: the home directory, a TAPD workspace whose
 * Agent folder is configured, or a local project. Lists are fetched on every
 * open because the desktop can change a folder while this page is mounted.
 */
export function TerminalFolderSheet(props: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (workspaceId?: string) => void;
}) {
  const [sources, setSources] = useState<FolderSources | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row started the create, so its spinner replaces nothing else.
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setSources(null);
    setLoadError(null);
    setPending(null);
    void Promise.allSettled([
      api.workspaces(),
      api.agentSettings(),
      api.localProjects(),
    ]).then(([workspaceResult, configResult, localResult]) => {
      if (cancelled) return;
      const failures: string[] = [];
      if (workspaceResult.status === "rejected") {
        failures.push(asApiError(workspaceResult.reason).message);
      }
      if (localResult.status === "rejected") {
        failures.push(asApiError(localResult.reason).message);
      }
      setSources({
        workspaces:
          workspaceResult.status === "fulfilled"
            ? workspaceResult.value.workspaces
            : [],
        localProjects:
          localResult.status === "fulfilled" ? localResult.value.projects : [],
        repoPaths:
          configResult.status === "fulfilled"
            ? (configResult.value.projects ?? null)
            : null,
      });
      setLoadError(failures[0] ?? null);
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

  // A workspace without an Agent folder has no path to start the shell in.
  const workspaceRows = (sources?.workspaces ?? []).filter(
    (workspace) =>
      !sources?.repoPaths ||
      Boolean(sources.repoPaths[workspace.id]?.repoPath?.trim()),
  );
  const localRows = sources?.localProjects ?? [];

  return (
    <BottomSheet
      open={props.open}
      title={t("mobile.terminal.chooseFolder")}
      onClose={props.onClose}
    >
      <div className="-mx-4 -my-3 [&>*:last-child]:border-b-0">
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

        {loadError ? (
          <p
            className="px-4 py-3 text-ui-caption text-rose-600"
            title={t("mobile.terminal.loadFailed")}
          >
            {loadError}
          </p>
        ) : null}

        {sources === null ? (
          <div className="space-y-2 px-4 py-3">
            <div className="h-4 w-2/3 animate-pulse rounded bg-overlay-soft" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-overlay-soft" />
          </div>
        ) : null}

        {workspaceRows.length > 0 ? (
          <h3 className="px-4 pb-1.5 pt-3 text-ui-sm text-slate-500">
            {t("mobile.terminal.projectFolders")}
          </h3>
        ) : null}

        {workspaceRows.map((workspace) => {
          const key = `ws:${workspace.id}`;
          return (
            <button
              key={key}
              type="button"
              disabled={props.busy}
              onClick={() => pick(key, workspace.id)}
              className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft disabled:opacity-40"
            >
              <span
                className="min-w-0 flex-1 truncate text-ui-caption text-slate-900"
                title={workspace.name}
              >
                {workspace.name}
              </span>
              {pending === key ? (
                <LoaderCircle size={14} className="shrink-0 animate-spin text-slate-400" />
              ) : null}
            </button>
          );
        })}

        {localRows.length > 0 ? (
          <h3 className="px-4 pb-1.5 pt-3 text-ui-sm text-slate-500">
            {t("mobile.local.projects")}
          </h3>
        ) : null}

        {localRows.map((project) => {
          const key = `local:${project.id}`;
          return (
            <button
              key={key}
              type="button"
              disabled={props.busy}
              onClick={() => pick(key, project.id)}
              className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft disabled:opacity-40"
            >
              <span
                className="min-w-0 flex-1 truncate text-ui-caption text-slate-900"
                title={project.repoPath}
              >
                {project.name}
              </span>
              {pending === key ? (
                <LoaderCircle size={14} className="shrink-0 animate-spin text-slate-400" />
              ) : null}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}
