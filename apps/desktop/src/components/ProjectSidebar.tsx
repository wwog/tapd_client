import clsx from "clsx";
import type { MouseEvent as ReactMouseEvent } from "react";
import { RefreshCw } from "lucide-react";

import type { Workspace, WorkspaceContext } from "../lib/api";
import type { ProjectMenu } from "../hooks/useWorkspaceData";
import { AccountChip } from "./AccountChip";
import { ScrollingName } from "./ScrollingName";
import { SkeletonRows } from "./Skeleton";
import type { View } from "./NavRail";

type Props = {
  context: WorkspaceContext | null;
  contextError: string | null;
  contextLoading: boolean;
  visibleWorkspaces: Workspace[];
  workspaceId: string;
  view: View;
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
  onOpenAccount: () => void;
  onOpenProjectMenu: (menu: ProjectMenu) => void;
  onHideWorkspace: (id: string) => void;
  onManageProjects: () => void;
  onResizeStart: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

/** Project list column plus its right-click menu and account footer. */
export function ProjectSidebar({
  context,
  contextError,
  contextLoading,
  visibleWorkspaces,
  workspaceId,
  view,
  account,
  autoCollapse,
  resizing,
  width,
  projectMenu,
  onRetry,
  onSelectWorkspace,
  onOpenAccount,
  onOpenProjectMenu,
  onHideWorkspace,
  onManageProjects,
  onResizeStart,
}: Props) {
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
          <div
            className="flex h-9 shrink-0 items-center justify-between pr-2"
            data-tauri-drag-region
          >
            <span className="min-w-0 flex-1 truncate px-2 text-ui-base font-normal text-slate-800">
              项目
            </span>
            {visibleWorkspaces.length ? (
              <span className="shrink-0 text-ui-sm tabular-nums text-slate-400">
                {visibleWorkspaces.length}
              </span>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto [scrollbar-gutter:stable]">
            {contextError ? (
              <div className="rounded-xl bg-rose-50 p-2.5 text-ui-sm leading-5 text-rose-700 border border-rose-100">
                <div className="break-all">{contextError}</div>
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-ui-xs text-rose-700 border border-rose-200 transition hover:bg-rose-100"
                >
                  <RefreshCw size={10} />
                  重试
                </button>
              </div>
            ) : null}

            {!context && contextLoading ? (
              <SkeletonRows
                rows={7}
                columns={["w-2/3", "w-6"]}
                className="pt-1"
                rowClassName="px-3 py-2.5"
                label="正在读取项目…"
              />
            ) : null}

            {context && visibleWorkspaces.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-2.5 py-3 text-ui-sm leading-5 text-slate-400">
                项目已全部隐藏，可在「项目」tab 中恢复显示。
              </div>
            ) : null}

            {visibleWorkspaces.map((item) => {
              const active = item.id === workspaceId;
              return (
                <button
                  key={item.id}
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
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-ui-base transition",
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
                  {active ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <AccountChip
          meAvatar={account.meAvatar}
          name={account.name}
          company={account.company}
          active={view === "account"}
          onClick={onOpenAccount}
        />

        <button
          type="button"
          aria-label="调整项目列表宽度"
          title="拖动调整宽度，拖到很窄会自动收起"
          onMouseDown={onResizeStart}
          className={clsx(
            "absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize",
            resizing ? "bg-sky-400/50" : "bg-transparent transition hover:bg-overlay",
          )}
        />
      </div>

      {projectMenu ? (
        <div
          role="menu"
          className="fixed z-[70] min-w-[190px] rounded-lg border border-border bg-surface p-1 text-ui-sm text-slate-700 "
          style={{
            left: Math.min(projectMenu.x, window.innerWidth - 210),
            top: Math.min(projectMenu.y, window.innerHeight - 92),
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => onHideWorkspace(projectMenu.id)}
            disabled={visibleWorkspaces.length <= 1}
            title={
              visibleWorkspaces.length <= 1 ? "至少保留一个项目" : "只影响本机显示"
            }
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            在本地隐藏「{projectMenu.name}」
          </button>
          <button
            type="button"
            onClick={onManageProjects}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-slate-100"
          >
            管理项目
          </button>
        </div>
      ) : null}
    </>
  );
}
