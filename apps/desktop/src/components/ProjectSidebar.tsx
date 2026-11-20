import clsx from "clsx";
import { useState } from "react";
import {
  EyeOff,
  Folder,
  FolderCog,
  FolderTree,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import type { Workspace, WorkspaceContext } from "../lib/api";
import type { ProjectMenu } from "../hooks/useWorkspaceData";
import { MIN_SIDEBAR_WIDTH } from "../hooks/useSidebarLayout";
import { t } from "../lib/i18n";
import type { LocalProject } from "../lib/local";
import { AccountChip } from "./AccountChip";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";
import { ScrollingName } from "./ScrollingName";
import { SkeletonRows } from "./Skeleton";
import type { View } from "./ActivityBar";

/** `px-2` on both sides of the list column. */
const SIDEBAR_CONTENT_PADDING = 16;

type Props = {
  context: WorkspaceContext | null;
  contextError: string | null;
  contextLoading: boolean;
  visibleWorkspaces: Workspace[];
  workspaceId: string;
  /** Local (non-TAPD) projects; `localProjectId` clears the TAPD selection. */
  localProjects: LocalProject[];
  localProjectId: string | null;
  /** `null` while the welcome page is showing (no page tab is open). */
  view: View | null;
  account: {
    meAvatar: string | null;
    name: string | null;
    company: string;
  };
  /** Auto-collapse is instant; animating both columns reflows the table. */
  autoCollapse: boolean;
  resizing: boolean;
  width: number;
  projectMenu: ProjectMenu | null;
  onRetry: () => void;
  onSelectWorkspace: (id: string) => void;
  onSelectLocalProject: (id: string) => void;
  onCreateLocalProject: () => void;
  onEditLocalProject: (project: LocalProject) => void;
  onDeleteLocalProject: (project: LocalProject) => void;
  onOpenAccount: () => void;
  onOpenProjectMenu: (menu: ProjectMenu) => void;
  onCloseProjectMenu: () => void;
  onHideWorkspace: (id: string) => void;
  onManageProjects: () => void;
  /** Opens the read-only file explorer for this project (workbench panel). */
  onBrowseFiles?: (workspaceId: string) => void;
};

/** Project list column plus its right-click menu and account footer. */
export function ProjectSidebar({
  context,
  contextError,
  contextLoading,
  visibleWorkspaces,
  workspaceId,
  localProjects,
  localProjectId,
  view,
  account,
  autoCollapse,
  resizing,
  width,
  projectMenu,
  onRetry,
  onSelectWorkspace,
  onSelectLocalProject,
  onCreateLocalProject,
  onEditLocalProject,
  onDeleteLocalProject,
  onOpenAccount,
  onOpenProjectMenu,
  onCloseProjectMenu,
  onHideWorkspace,
  onManageProjects,
  onBrowseFiles,
}: Props) {
  /** Local rows have their own two-entry menu; TAPD rows use App's `projectMenu`. */
  const [localMenu, setLocalMenu] = useState<{
    project: LocalProject;
    x: number;
    y: number;
  } | null>(null);
  return (
    <>
      <div
        className={clsx(
          "relative flex shrink-0 flex-col overflow-hidden",
          // Auto-collapse is instant: animating both the sidebar and the
          // detail pane reflows the bug table every frame.
          !resizing && !autoCollapse && "transition-[width] duration-200 ease-out",
        )}
        style={{ width }}
      >
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          {/* Same geometry as the "local projects" group header below, so both
              group titles and their first row share one rhythm. */}
          <div
            className="flex shrink-0 items-center justify-between px-2.5 pb-1 pt-1.5 text-ui-xs text-slate-400"
            data-tauri-drag-region
          >
            <span className="min-w-0 flex-1 truncate">{t("common.projects")}</span>
            {visibleWorkspaces.length ? (
              <span className="shrink-0 tabular-nums">{visibleWorkspaces.length}</span>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
            {/* Rows keep the layout they have at the narrowest sidebar, so a
                collapsing column clips them instead of re-truncating every
                name on every frame. */}
            <div
              className="space-y-0.5"
              style={{ minWidth: MIN_SIDEBAR_WIDTH - SIDEBAR_CONTENT_PADDING }}
            >
              {contextError ? (
                <div className="rounded-xl bg-rose-50 p-2.5 text-ui-sm leading-5 text-rose-700 border border-rose-100">
                  <div className="break-all">{contextError}</div>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-ui-xs text-rose-700 border border-rose-200 transition hover:bg-rose-100"
                  >
                    <RefreshCw size={10} />
                    {t("common.retry")}
                  </button>
                </div>
              ) : null}

              {!context && contextLoading ? (
                <SkeletonRows
                  rows={7}
                  columns={["w-2/3", "w-6"]}
                  className="pt-1"
                  rowClassName="px-3 py-2.5"
                  label={t("settings.sidebar.reading")}
                />
              ) : null}

              {context && visibleWorkspaces.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-2.5 py-3 text-ui-sm leading-5 text-slate-400">
                  {t("settings.sidebar.allHidden")}
                </div>
              ) : null}

              {visibleWorkspaces.map((item) => {
                // A selected local project owns the "active" state, so one row
                // is highlighted at a time across both sections.
                const active = item.id === workspaceId && localProjectId === null;
                return (
                  <div key={item.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelectWorkspace(item.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onOpenProjectMenu({
                          id: item.id,
                          name: item.name,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                      className={clsx(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] pr-8 text-left text-ui-base transition",
                        active
                          ? "bg-overlay font-normal text-slate-900"
                          : "text-slate-600 hover:bg-overlay-soft",
                      )}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: item.logoColor || "#0ea5e9" }}
                      />
                      <ScrollingName text={item.name} className="flex-1" />
                    </button>
                    {onBrowseFiles ? (
                      <button
                        type="button"
                        aria-label={t("explorer.browse")}
                        title={t("explorer.browseHint")}
                        onClick={(event) => {
                          event.stopPropagation();
                          onBrowseFiles(item.id);
                        }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 opacity-0 transition hover:bg-overlay hover:text-slate-600 focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <FolderTree size={12} />
                      </button>
                    ) : null}
                  </div>
                );
              })}

              {/* The group header is always here: the only in-sidebar way to
                  create a local project lives on it (count on rest,「+」on
                  hover, and「+」alone while there is nothing to count). */}
              <div className="mt-1 border-t border-border pt-1">
                <div
                  className="group/lp flex items-center justify-between px-2.5 pb-1 pt-1.5 text-ui-xs text-slate-400"
                  title={t("local.projects.hint")}
                >
                  <span>{t("local.projects.title")}</span>
                  <span className="grid shrink-0 place-items-center">
                    {localProjects.length > 0 ? (
                      <span className="tabular-nums group-hover/lp:hidden">
                        {localProjects.length}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t("local.projects.create")}
                      title={t("local.projects.create")}
                      onClick={onCreateLocalProject}
                      className={clsx(
                        "-my-1 h-5 w-5 place-items-center rounded transition hover:bg-overlay hover:text-slate-600 focus-visible:grid",
                        localProjects.length > 0
                          ? "hidden group-hover/lp:grid"
                          : "grid",
                      )}
                    >
                      <Plus size={12} />
                    </button>
                  </span>
                </div>
                {localProjects.map((project) => {
                  const active = project.id === localProjectId;
                  return (
                    <div key={project.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onSelectLocalProject(project.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setLocalMenu({
                            project,
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        className={clsx(
                          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] pr-8 text-left text-ui-base transition",
                          active
                            ? "bg-overlay font-normal text-slate-900"
                            : "text-slate-600 hover:bg-overlay-soft",
                        )}
                      >
                        <Folder
                          size={13}
                          className={clsx(
                            "shrink-0",
                            active ? "text-sky-600" : "text-slate-400",
                          )}
                        />
                        <ScrollingName text={project.name} className="flex-1" />
                      </button>
                      {onBrowseFiles ? (
                        <button
                          type="button"
                          aria-label={t("explorer.browse")}
                          title={t("explorer.browseHint")}
                          onClick={(event) => {
                            event.stopPropagation();
                            onBrowseFiles(project.id);
                          }}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 opacity-0 transition hover:bg-overlay hover:text-slate-600 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <FolderTree size={12} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <AccountChip
          meAvatar={account.meAvatar}
          name={account.name}
          company={account.company}
          active={view === "account"}
          onClick={onOpenAccount}
        />
      </div>

      {projectMenu ? (
        <ContextMenu
          key={`${projectMenu.id}-${projectMenu.x}-${projectMenu.y}`}
          x={projectMenu.x}
          y={projectMenu.y}
          label={t("settings.sidebar.manage")}
          onClose={onCloseProjectMenu}
        >
          {(requestClose) => (
            <>
              <ContextMenuItem
                icon={<FolderTree size={13} />}
                label={t("explorer.browse")}
                title={t("explorer.browseHint")}
                disabled={!onBrowseFiles}
                onClick={() => {
                  onBrowseFiles?.(projectMenu.id);
                  requestClose();
                }}
              />
              <ContextMenuItem
                icon={<EyeOff size={13} />}
                label={t("settings.sidebar.hideName", { name: projectMenu.name })}
                title={
                  visibleWorkspaces.length <= 1
                    ? t("settings.projects.keepOne")
                    : t("settings.sidebar.localOnly")
                }
                disabled={visibleWorkspaces.length <= 1}
                onClick={() => {
                  onHideWorkspace(projectMenu.id);
                  requestClose();
                }}
              />
              <ContextMenuItem
                icon={<FolderCog size={13} />}
                label={t("settings.sidebar.manage")}
                onClick={() => {
                  onManageProjects();
                  requestClose();
                }}
              />
            </>
          )}
        </ContextMenu>
      ) : null}

      {localMenu ? (
        <ContextMenu
          key={`${localMenu.project.id}-${localMenu.x}-${localMenu.y}`}
          x={localMenu.x}
          y={localMenu.y}
          label={localMenu.project.name}
          onClose={() => setLocalMenu(null)}
        >
          {(requestClose) => (
            <>
              <ContextMenuItem
                icon={<FolderTree size={13} />}
                label={t("explorer.browse")}
                title={t("explorer.browseHint")}
                disabled={!onBrowseFiles}
                onClick={() => {
                  onBrowseFiles?.(localMenu.project.id);
                  requestClose();
                }}
              />
              <ContextMenuItem
                icon={<Pencil size={13} />}
                label={t("local.projects.edit")}
                onClick={() => {
                  onEditLocalProject(localMenu.project);
                  requestClose();
                }}
              />
              <ContextMenuItem
                icon={<Trash2 size={13} />}
                label={t("local.projects.delete")}
                tone="danger"
                onClick={() => {
                  onDeleteLocalProject(localMenu.project);
                  requestClose();
                }}
              />
            </>
          )}
        </ContextMenu>
      ) : null}
    </>
  );
}
