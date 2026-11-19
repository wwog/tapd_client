/**
 * Read-only explorer for one project: a lazily loaded directory tree with
 * persisted expansion, a breadcrumb for the current selection directory, and
 * the usual reveal-hidden / refresh controls.
 *
 * The panel never writes to disk. Files open as preview tabs in the file
 * viewer; double-clicking pins the tab.
 */
import clsx from "clsx";
import {
  Eye,
  EyeOff,
  FolderOpen,
  FolderTree,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { ProjectOpenButton } from "../../components/ProjectOpenButton";
import { dirname, fsApi, type FsEntry } from "../../lib/fs";
import { t } from "../../lib/i18n";
import { Breadcrumb } from "../explorer/Breadcrumb";
import { ExplorerTree } from "../explorer/ExplorerTree";
import {
  buildRows,
  useExplorerExpanded,
  useExplorerTree,
  type ExplorerRow,
} from "../explorer/useExplorerTree";
import { usePanelServices, type PanelProps } from "./context";

const MAX_ENTRIES = 5_000;

type EntryRow = Extract<ExplorerRow, { kind: "entry" }>;

export function ExplorerPanel({ panel, active }: PanelProps) {
  const services = usePanelServices();
  const resource = panel.resource;
  const workspaceId =
    resource.type === "explorer"
      ? resource.workspaceId
      : services.currentWorkspaceId;
  const projectName = services.workspaceName(workspaceId) || t("explorer.root");

  const [currentPath, setCurrentPath] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { dirs, load, refresh } = useExplorerTree(workspaceId);
  const { expanded, expand, collapse } = useExplorerExpanded(workspaceId);

  // Restore persisted expansions lazily: each path fetches one level.
  useEffect(() => {
    for (const path of expanded) load(path);
  }, [expanded, load]);

  const reveal = useCallback(
    (path: string) => {
      const parts = path.split("/").filter(Boolean);
      for (let index = 1; index <= parts.length; index += 1) {
        const directory = parts.slice(0, index).join("/");
        expand(directory);
        load(directory);
      }
    },
    [expand, load],
  );

  const navigate = useCallback(
    (path: string) => {
      setCurrentPath(path);
      setSelected(null);
      reveal(path);
      if (path) load(path);
    },
    [load, reveal],
  );

  const toggleDir = useCallback(
    (path: string) => {
      if (expanded.has(path)) {
        collapse(path);
        return;
      }
      // Expanding also makes the directory the breadcrumb target.
      setCurrentPath(path);
      expand(path);
      load(path);
    },
    [collapse, expand, expanded, load],
  );

  const openFile = useCallback(
    (entry: FsEntry, preview: boolean) => {
      services.open({
        resource: { type: "file", workspaceId, path: entry.path },
        preview,
        label: entry.name,
      });
    },
    [services, workspaceId],
  );

  const selectEntry = useCallback((entry: FsEntry) => {
    setSelected(entry.path);
    setCurrentPath(entry.kind === "dir" ? entry.path : dirname(entry.path));
  }, []);

  const activate = useCallback(
    async (entry: FsEntry, preview: boolean) => {
      selectEntry(entry);
      if (entry.kind === "dir") {
        toggleDir(entry.path);
        return;
      }
      if (entry.kind === "symlink") {
        try {
          const stat = await fsApi.stat({ workspaceId, path: entry.path });
          if (stat.kind === "dir") {
            toggleDir(entry.path);
            return;
          }
        } catch (error) {
          services.toast("error", String(error));
          return;
        }
      }
      openFile(entry, preview);
    },
    [openFile, selectEntry, services, toggleDir, workspaceId],
  );

  const rows = useMemo(
    () => buildRows(dirs, expanded, showHidden),
    [dirs, expanded, showHidden],
  );
  const entryRows = useMemo(
    () => rows.filter((row): row is EntryRow => row.kind === "entry"),
    [rows],
  );

  // Single click follows VS Code: a preview tab that the next click replaces.
  const onRowClick = useCallback(
    (entry: FsEntry) => {
      selectEntry(entry);
      if (entry.kind === "file") openFile(entry, true);
      if (entry.kind === "symlink") void activate(entry, true);
    },
    [activate, openFile, selectEntry],
  );

  // Double click turns the tab into a permanent one.
  const onRowDoubleClick = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === "dir") {
        selectEntry(entry);
        toggleDir(entry.path);
        return;
      }
      void activate(entry, false);
    },
    [activate, selectEntry, toggleDir],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (entryRows.length === 0) return;
      const index = selected
        ? entryRows.findIndex((row) => row.entry.path === selected)
        : -1;

      const selectAt = (target: number) => {
        const row =
          entryRows[Math.max(0, Math.min(entryRows.length - 1, target))];
        if (row) selectEntry(row.entry);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          selectAt(index + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          selectAt(index <= 0 ? 0 : index - 1);
          break;
        case "Home":
          event.preventDefault();
          selectAt(0);
          break;
        case "End":
          event.preventDefault();
          selectAt(entryRows.length - 1);
          break;
        case "ArrowRight": {
          event.preventDefault();
          const row = entryRows[index];
          if (!row || row.entry.kind !== "dir") return;
          if (!expanded.has(row.entry.path)) {
            expand(row.entry.path);
            load(row.entry.path);
          } else {
            selectAt(index + 1);
          }
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          const row = entryRows[index];
          if (row?.entry.kind === "dir" && expanded.has(row.entry.path)) {
            collapse(row.entry.path);
            break;
          }
          const parent = dirname(row?.entry.path ?? selected ?? "");
          const parentRow = parent
            ? entryRows.find(
                (candidate) =>
                  candidate.entry.path === parent &&
                  candidate.entry.kind === "dir",
              )
            : undefined;
          if (parentRow) selectEntry(parentRow.entry);
          else setSelected(parent || null);
          break;
        }
        case "Enter": {
          event.preventDefault();
          const row = entryRows[index];
          if (row) void activate(row.entry, true);
          break;
        }
        default:
          break;
      }
    },
    [activate, collapse, entryRows, expand, expanded, load, selectEntry, selected],
  );

  const rootState = dirs[""];
  const rootError =
    rootState?.status === "error" ? (rootState.error ?? "") : null;
  const noFolder = rootError?.startsWith("no_folder:") ?? false;
  const rootReady = rootState?.status === "ready";
  const truncated = useMemo(
    () => Object.values(dirs).some((state) => state.listing?.truncated === true),
    [dirs],
  );

  const refreshTree = useCallback(() => {
    setSelected(null);
    refresh([...expanded]);
  }, [expanded, refresh]);

  const body = (() => {
    if (!rootState || rootState.status === "loading") {
      return (
        <div className="flex flex-1 items-center justify-center gap-2 text-ui-sm text-slate-400">
          <Loader2 size={13} className="animate-spin" />
          {t("explorer.loading")}
        </div>
      );
    }
    if (rootState.status === "error") {
      if (noFolder) {
        return (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
            <FolderTree size={20} className="text-slate-300" />
            <p className="text-ui-caption text-slate-600" title={t("explorer.noFolderHint")}>
              {t("explorer.noFolder")}
            </p>
          </div>
        );
      }
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="break-all text-ui-sm leading-5 text-rose-600">
            {t("explorer.loadFailed", { error: rootError ?? "" })}
          </p>
          <button
            type="button"
            onClick={refreshTree}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-ui-xs text-slate-600 transition hover:bg-overlay"
          >
            <RefreshCw size={10} />
            {t("explorer.refresh")}
          </button>
        </div>
      );
    }
    if (rows.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <FolderOpen size={20} className="text-slate-300" />
          <p className="text-ui-caption text-slate-600">
            {t("explorer.emptyDir")}
          </p>
        </div>
      );
    }
    return null;
  })();

  return (
    <div
      data-component="ExplorerPanel"
      className="flex h-full min-h-0 flex-col bg-surface"
      data-panel-id={panel.id}
      data-panel-active={active ? "true" : "false"}
      data-workbench-explorer="panel"
    >
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2"
        data-workbench-explorer="header"
      >
        <button
          type="button"
          aria-label={t("explorer.refresh")}
          title={t("explorer.refresh")}
          onClick={refreshTree}
          className="ml-auto rounded-md p-1 text-slate-500 transition hover:bg-overlay hover:text-slate-700"
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          aria-label={t("explorer.showHidden")}
          title={t("explorer.showHidden")}
          aria-pressed={showHidden}
          onClick={() => setShowHidden((value) => !value)}
          className={clsx(
            "rounded-md p-1 transition",
            showHidden
              ? "bg-sky-50 text-sky-700"
              : "text-slate-500 hover:bg-overlay hover:text-slate-700",
          )}
        >
          {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <ProjectOpenButton
          workspaceId={workspaceId}
          onError={(message) => services.toast("error", message)}
        />
      </div>

      <div className="flex h-7 shrink-0 items-center border-b border-border px-2">
        <Breadcrumb
          rootLabel={projectName}
          path={currentPath}
          onNavigate={navigate}
        />
      </div>

      {rootReady ? (
        <ExplorerTree
          rows={rows}
          expanded={expanded}
          selected={selected}
          containerRef={containerRef}
          onKeyDown={onKeyDown}
          onRowClick={onRowClick}
          onRowDoubleClick={onRowDoubleClick}
          onToggleDir={toggleDir}
        />
      ) : (
        body
      )}

      {truncated ? (
        <div
          className="shrink-0 border-t border-border px-2 py-1 text-ui-xs text-slate-400"
          data-workbench-explorer="footer"
          title={t("explorer.truncated", { n: MAX_ENTRIES })}
        >
          {t("explorer.truncated", { n: MAX_ENTRIES })}
        </div>
      ) : null}
    </div>
  );
}
