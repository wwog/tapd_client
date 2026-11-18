import clsx from "clsx";
import {
  Maximize2,
  Minimize2,
  Pin,
  Plus,
  X,
} from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "../../components/ContextMenu";
import { t } from "../../lib/i18n";
import { PANEL_DEFINITIONS } from "../panels/registry";
import { usePanelServices } from "../panels/context";
import { usePanelDirty } from "../panels/dirty";
import type { GroupNode, PanelRef, WorkbenchLayoutApi } from "../layout/types";
import { GROUP_INSET, type Rect } from "./SplitView";

type GroupViewProps = {
  api: WorkbenchLayoutApi;
  group: GroupNode;
  rect: Rect;
  empty: boolean;
  hidden: boolean;
  maximized: boolean;
  /**
   * Maximizing needs another group to hide; a lone filled group fills the
   * layout already, so the control is not rendered at all.
   */
  canMaximize: boolean;
  /** Side bar toggle, rendered left of the primary group's tabs. */
  primaryLeading?: ReactNode;
  /**
   * The tab strip's trailing slot (`ActiveTabExtra`). Only the tab focused in
   * *this* group may declare content for it: the slot belongs to the focused
   * tab, not to a fixed group role, so switching tabs swaps its content.
   */
  activeTabExtra?: (panel: PanelRef) => ReactNode;
  onRegisterBody: (groupId: string, element: HTMLElement | null) => void;
  onSpawnTerminal: () => void;
  onTabPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    panel: PanelRef,
    groupId: string,
  ) => void;
};

type TabMenu = { panel: PanelRef; x: number; y: number };

/**
 * Closable check with one layout-wide exception: the last page tab must stay.
 * `normalize` recreates a page for the main view when every page is closed, so
 * offering a close button there would look like it does nothing.
 */
function canClosePanel(api: WorkbenchLayoutApi, panel: PanelRef): boolean {
  if (!PANEL_DEFINITIONS[panel.kind].closable(panel)) return false;
  if (panel.kind !== "page") return true;
  const pages = api.groups.reduce(
    (count, group) =>
      count + group.panels.filter((item) => item.kind === "page").length,
    0,
  );
  return pages > 1;
}

/**
 * One group: an absolutely placed cell, the card chrome, the tab strip and the
 * body the panel portals land in. Empty canonical docks keep their cell (so a
 * drag can find them) but render no chrome and take 0px.
 */
export function GroupView({
  api,
  group,
  rect,
  empty,
  hidden,
  maximized,
  canMaximize,
  primaryLeading,
  activeTabExtra,
  onRegisterBody,
  onSpawnTerminal,
  onTabPointerDown,
}: GroupViewProps) {
  const services = usePanelServices();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);

  useLayoutEffect(() => {
    onRegisterBody(group.id, empty ? null : bodyRef.current);
    return () => onRegisterBody(group.id, null);
  }, [group.id, empty, onRegisterBody]);

  const hasTerminal = group.panels.some((panel) => panel.kind === "terminal");
  const activePanel =
    group.panels.find((panel) => panel.id === group.activePanelId) ?? null;
  const isMaximized = maximized;

  const toggleMaximize = () =>
    api.maximizeGroup(isMaximized ? null : group.id);

  const handleStripDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-tab-id], button")) return;
    toggleMaximize();
  };

  return (
    <div
      data-workbench-group={group.id}
      data-workbench-group-cell="true"
      {...(empty ? { "data-workbench-group-empty": "true" } : {})}
      // A maximized sibling makes this cell visibility-hidden; inert keeps a
      // focused terminal or form from receiving keys while it is not visible.
      inert={hidden}
      aria-hidden={hidden || undefined}
      className="absolute"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        visibility: hidden ? "hidden" : undefined,
        zIndex: maximized ? 10 : undefined,
      }}
    >
      {empty ? null : (
        <div
          data-workbench-group={group.id}
          className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface"
          style={{ inset: GROUP_INSET }}
        >
          <header
            className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5"
            data-tauri-drag-region
            onDoubleClick={handleStripDoubleClick}
          >
            {group.role === "primary" ? primaryLeading : null}
            <div
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
              data-tauri-drag-region
            >
              {group.panels.map((panel) => (
                <TabItem
                  key={panel.id}
                  panel={panel}
                  active={group.activePanelId === panel.id}
                  onSelect={() => api.activatePanel(panel.id)}
                  onClose={() => services.closePanel(panel.id)}
                  onPointerDown={(event) =>
                    onTabPointerDown(event, panel, group.id)
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ panel, x: event.clientX, y: event.clientY });
                  }}
                  onPin={() => services.pinPanel(panel.id)}
                  closable={canClosePanel(api, panel)}
                />
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <ActiveTabExtra panel={activePanel} render={activeTabExtra} />
              {hasTerminal ? (
                <StripButton label={t("terminal.new")} onClick={onSpawnTerminal}>
                  <Plus size={14} />
                </StripButton>
              ) : null}
              {canMaximize ? (
                <StripButton
                  label={isMaximized ? t("layout.restore") : t("layout.maximize")}
                  onClick={toggleMaximize}
                >
                  {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </StripButton>
              ) : null}
            </div>
          </header>

          <div
            ref={bodyRef}
            data-workbench-group={group.id}
            data-workbench-group-body="true"
            className="relative min-h-0 flex-1 overflow-hidden"
          />
        </div>
      )}

      {menu ? (
        <TabMenuView
          api={api}
          group={group}
          menu={menu}
          canMaximize={canMaximize}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function TabMenuView({
  api,
  group,
  menu,
  canMaximize,
  onClose,
}: {
  api: WorkbenchLayoutApi;
  group: GroupNode;
  menu: TabMenu;
  canMaximize: boolean;
  onClose: () => void;
}) {
  const services = usePanelServices();
  const closableOthers = group.panels.filter(
    (panel) => panel.id !== menu.panel.id && canClosePanel(api, panel),
  );
  const isMaximized = api.layout.maximizedGroupId === group.id;
  const title = PANEL_DEFINITIONS[menu.panel.kind].title(menu.panel);

  return (
    <ContextMenu x={menu.x} y={menu.y} label={title} onClose={onClose}>
      {(requestClose) => (
        <>
          {canClosePanel(api, menu.panel) ? (
            <ContextMenuItem
              icon={<X size={13} />}
              label={t("layout.closeTab")}
              onClick={() => {
                services.closePanel(menu.panel.id);
                requestClose();
              }}
            />
          ) : null}
          <ContextMenuItem
            icon={<X size={13} />}
            label={t("layout.closeOthers")}
            disabled={closableOthers.length === 0}
            onClick={() => {
              for (const panel of closableOthers) services.closePanel(panel.id);
              requestClose();
            }}
          />
          {menu.panel.preview ? (
            <ContextMenuItem
              icon={<Pin size={13} />}
              label={t("layout.pinTab")}
              onClick={() => {
                services.pinPanel(menu.panel.id);
                requestClose();
              }}
            />
          ) : null}
          {canMaximize ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                label={isMaximized ? t("layout.restore") : t("layout.maximize")}
                onClick={() => {
                  api.maximizeGroup(isMaximized ? null : group.id);
                  requestClose();
                }}
              />
            </>
          ) : null}
        </>
      )}
    </ContextMenu>
  );
}

function TabItem({
  panel,
  active,
  onSelect,
  onClose,
  onPointerDown,
  onContextMenu,
  onPin,
  closable,
}: {
  panel: PanelRef;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onPin: () => void;
  /** False for the global navigation tab and for the layout's last page tab. */
  closable: boolean;
}) {
  const definition = PANEL_DEFINITIONS[panel.kind];
  const label = definition.title(panel);
  /** Unsaved edits paint a dot; closing asks before discarding. */
  const dirty = usePanelDirty(panel.id);
  /** Pointer-down origin; a moved pointer means the click was a tab drag. */
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={panel.id}
      title={panel.preview ? t("layout.previewHint") : label}
      onPointerDown={(event) => {
        pressRef.current = { x: event.clientX, y: event.clientY };
        onPointerDown(event);
      }}
      onClick={(event) => {
        const press = pressRef.current;
        pressRef.current = null;
        if (
          press &&
          Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4
        ) {
          return;
        }
        onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if ((event.target as HTMLElement).closest("button")) return;
        onPin();
      }}
      onContextMenu={onContextMenu}
      className={clsx(
        "group/tab flex h-7 max-w-56 shrink-0 cursor-default items-center gap-1 rounded-md transition select-none",
        // A tab without a close button needs its own trailing inset; the
        // close button normally provides it (and sits 2px from the edge).
        closable ? "pl-2 pr-0.5" : "px-2",
        active
          ? "bg-slate-100 text-slate-700"
          : "text-slate-500 hover:bg-overlay",
      )}
    >
      <span className="shrink-0 text-slate-400">{definition.icon(panel)}</span>
      <span
        className={clsx(
          "min-w-0 truncate text-ui-sm",
          panel.preview && "italic",
        )}
      >
        {label}
      </span>
      {dirty ? (
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
          data-tab-dirty="true"
        />
      ) : null}
      {closable ? (
        <button
          type="button"
          aria-label={t("layout.closeTab")}
          title={t("layout.closeTab")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={clsx(
            "grid h-4 w-4 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-overlay hover:text-slate-600",
            active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
        >
          <X size={10} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Trailing slot of one group's tab strip. It renders the declaration of that
 * group's focused tab and nothing else: an extra never leaks to the group or to
 * a sibling tab, so moving focus moves the slot's content with it.
 */
function ActiveTabExtra({
  panel,
  render,
}: {
  panel: PanelRef | null;
  render?: (panel: PanelRef) => ReactNode;
}) {
  if (!panel || !render) return null;
  const extra = render(panel);
  if (extra === null || extra === undefined || extra === false) return null;
  return (
    <div
      data-active-tab-extra={panel.id}
      className="flex shrink-0 items-center"
    >
      {extra}
    </div>
  );
}

function StripButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-overlay hover:text-slate-700"
    >
      {children}
    </button>
  );
}
