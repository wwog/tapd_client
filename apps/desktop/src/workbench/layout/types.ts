/**
 * Workbench layout protocol — the single source of truth for region geometry.
 *
 * A layout is a split tree: `SplitNode`s divide space, `GroupNode`s own tabs.
 * Groups hold panel refs only; the panel content itself lives in a stable
 * `PanelHost` layer (portals), so moving a tab between groups never remounts
 * its content. See `docs/WORKBENCH.md` for the naming table and invariants.
 */

/** Canonical docks. Roles only describe the default home of a group. */
export type GroupRole = "primary" | "secondary" | "bottom";

/** Full-page views reachable from the activity bar. */
export type PageView =
  | "bugs"
  | "local"
  | "agent"
  | "projects"
  | "coworker"
  | "mcp"
  | "settings"
  | "account";

export type PanelKind = "page" | "bug" | "explorer" | "file" | "terminal";

/**
 * What a panel points at. `workspaceId` already identifies the project, so the
 * panel id stays deterministic across restarts (stable persistence keys).
 *
 * A page is either global (`settings`, `agent`, …) or project-scoped: `bugs`
 * carries a TAPD workspace id, `local` a local project id. Project pages are
 * one per project and can be closed; global pages share a single navigation
 * tab (see `openPage`).
 */
export type PanelResource =
  | { type: "page"; view: PageView; projectId?: string }
  | { type: "bug"; workspaceId: string; bugId: string }
  | { type: "explorer"; workspaceId: string }
  | { type: "file"; workspaceId: string; path: string }
  | { type: "terminal"; sessionId: string };

export type PanelRef = {
  /** Deterministic id; build it with `panelId` / `makePanel`. */
  id: string;
  kind: PanelKind;
  resource: PanelResource;
  /**
   * A preview tab is replaced by the next preview tab of the same kind in the
   * same group (VS Code file preview). Pinned by `pinPanel`.
   */
  preview: boolean;
  /** Tab label captured at open time; the registry falls back to a resource label. */
  label?: string;
};

export type GroupNode = {
  kind: "group";
  id: string;
  /**
   * Canonical dock. Empty role groups stay in the tree with their fraction so
   * reopening a panel restores the previous size; non-role groups are removed
   * by `normalize` once empty.
   */
  role?: GroupRole;
  panels: PanelRef[];
  activePanelId: string | null;
};

/** `row` puts children side by side; `column` stacks them. */
export type SplitDirection = "row" | "column";

export type SplitNode = {
  kind: "split";
  id: string;
  direction: SplitDirection;
  children: LayoutNode[];
  /** Fractions aligned with `children`, sum 1. Empty groups keep their slot. */
  sizes: number[];
};

export type LayoutNode = SplitNode | GroupNode;

export type LayoutState = {
  version: 1;
  root: LayoutNode;
  activeGroupId: string;
  /** When set, only this group is rendered (double-click the tab strip). */
  maximizedGroupId: string | null;
};

/** Drop zone geometry: center = tabs, edges = split the target group. */
export type DropZone = "center" | "left" | "right" | "top" | "bottom";
export type SplitEdge = Exclude<DropZone, "center">;

export type PanelSize = { width: number; height: number };

/** Where an open request lands; `active` follows the last focused group. */
export type PanelTarget = GroupRole | "active";

export type PanelOpenSpec = {
  resource: PanelResource;
  /** Defaults to false (a permanent tab). */
  preview?: boolean;
  /** Defaults per kind through `defaultTarget` in `defaults.ts`. */
  target?: PanelTarget;
  /** Human label for the tab (bug title, file name, project name). */
  label?: string;
};

/** Prefs envelope persisted under `uiPrefs["workbench.layout.v1"]`. */
export type LayoutPrefs = {
  version: 1;
  layout: LayoutState;
  sidebarWidth: number;
  /** The project column is collapsed by the user (auto-collapse is separate). */
  sidebarCollapsed: boolean;
};

/** One split boundary: `sizes[index] / sizes[index + 1]`. */
export type SashRef = { splitId: string; index: number };

/**
 * Layout surface consumed by the view layer. Implemented by
 * `useWorkbenchLayout`; every operation is a pure tree transform plus a state
 * commit, so the UI never mutates the tree directly.
 */
export type WorkbenchLayoutApi = {
  layout: LayoutState;
  /** Groups in tree order, including empty canonical docks. */
  groups: GroupNode[];
  /** Group owning keyboard focus last (falls back to the primary group). */
  activeGroup: GroupNode;
  activePanelId: string | null;
  /** Opens or focuses a panel; returns its id. */
  open: (spec: PanelOpenSpec) => string;
  /**
   * Opens or focuses a page tab in the primary group. With `projectId` the tab
   * belongs to that project (one per project); without it the single global
   * page tab is retargeted to `view`, like the old navigation behaviour.
   */
  openPage: (view: PageView, projectId?: string, label?: string) => void;
  /**
   * Turns a persisted generic page (opened before the project was known) into
   * the project's page tab. No-op when no generic page exists for `view`.
   */
  retargetPage: (view: PageView, projectId: string) => void;
  activatePanel: (panelId: string) => void;
  activateGroup: (groupId: string) => void;
  closePanel: (panelId: string) => void;
  /** Turns a preview tab into a permanent one. */
  pinPanel: (panelId: string) => void;
  setPanelLabel: (panelId: string, label: string) => void;
  /** Center drop: move a tab into `groupId` at `index`. */
  movePanel: (panelId: string, groupId: string, index: number) => void;
  /** Edge drop: split `groupId` in `edge` direction and put the tab there. */
  splitPanel: (panelId: string, groupId: string, edge: SplitEdge) => void;
  setSizes: (splitId: string, sizes: number[]) => void;
  /** Pixel delta from the drag origin; container is the split's main axis. */
  beginSashDrag: (
    splitId: string,
    index: number,
  ) => { move: (deltaPx: number, containerPx: number) => void; end: () => void };
  /** One pointer drag adjusts a vertical and a horizontal sash together. */
  beginCornerDrag: (
    vertical: { splitId: string; index: number; containerPx: number },
    horizontal: { splitId: string; index: number; containerPx: number },
  ) => { move: (dx: number, dy: number) => void; end: () => void };
  /** Double-click reset of one split to its default ratio. */
  resetSash: (splitId: string) => void;
  maximizeGroup: (groupId: string | null) => void;
  /** Reconciles backend-owned PTY sessions into terminal panels. */
  syncTerminalPanels: (sessions: { id: string; label: string }[]) => void;
  hasPanel: (panelId: string) => boolean;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  /** User-chosen collapse of the project column; persisted with the layout. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
};

// ---------------------------------------------------------------------------
// Id helpers — deterministic ids keep persisted layouts stable.
// ---------------------------------------------------------------------------

export const panelId = {
  /** `projectId` scopes the page to one project; omit it for a global page. */
  page: (view: PageView, projectId?: string): string =>
    projectId ? `page:${view}:${projectId}` : `page:${view}`,
  bug: (workspaceId: string, bugId: string): string => `bug:${workspaceId}:${bugId}`,
  explorer: (workspaceId: string): string => `explorer:${workspaceId}`,
  file: (workspaceId: string, path: string): string => `file:${workspaceId}:${path}`,
  terminal: (sessionId: string): string => `terminal:${sessionId}`,
};

/** Builds a panel ref and derives `kind` from the resource discriminant. */
export function makePanel(
  resource: PanelResource,
  extra: { preview?: boolean; label?: string } = {},
): PanelRef {
  const id =
    resource.type === "page"
      ? panelId.page(resource.view, resource.projectId)
      : resource.type === "bug"
        ? panelId.bug(resource.workspaceId, resource.bugId)
        : resource.type === "explorer"
          ? panelId.explorer(resource.workspaceId)
          : resource.type === "file"
            ? panelId.file(resource.workspaceId, resource.path)
            : panelId.terminal(resource.sessionId);
  return {
    id,
    kind: resource.type,
    resource,
    preview: extra.preview === true,
    ...(extra.label ? { label: extra.label } : {}),
  };
}

/** Finds a panel anywhere in the tree. */
export function findPanel(
  node: LayoutNode,
  id: string,
): { panel: PanelRef; group: GroupNode; index: number } | null {
  if (node.kind === "group") {
    const index = node.panels.findIndex((panel) => panel.id === id);
    return index === -1 ? null : { panel: node.panels[index]!, group: node, index };
  }
  for (const child of node.children) {
    const hit = findPanel(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Finds a group by id. */
export function findGroup(node: LayoutNode, id: string): GroupNode | null {
  if (node.kind === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const hit = findGroup(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Depth-first group list. */
export function listGroups(node: LayoutNode, out: GroupNode[] = []): GroupNode[] {
  if (node.kind === "group") {
    out.push(node);
    return out;
  }
  for (const child of node.children) listGroups(child, out);
  return out;
}

/** First group carrying `role`, if the user has not moved it away. */
export function findRoleGroup(node: LayoutNode, role: GroupRole): GroupNode | null {
  return listGroups(node).find((group) => group.role === role) ?? null;
}
