/**
 * Defaults shared by the layout core and the view layer: the initial tree,
 * canonical dock ids, panel minimum sizes and open-target rules.
 *
 * Keeping these in one module means the sash clamp, the "does this fit"
 * window check and the empty-dock rendering all use the same numbers.
 */
import type {
  GroupNode,
  GroupRole,
  LayoutState,
  PageView,
  PanelKind,
  PanelRef,
  PanelSize,
  SplitDirection,
} from "./types";

/** Canonical dock ids. Persisted layouts keep these unless a group was moved. */
export const GROUP_ID: Record<GroupRole, string> = {
  primary: "group-primary",
  secondary: "group-secondary",
  bottom: "group-bottom",
};

export const ROOT_SPLIT_ID = "split-root";
export const MAIN_SPLIT_ID = "split-main";

/** Initial share of the dock when it first opens (fraction of its parent). */
export const ROLE_DEFAULT_SIZE: Record<Exclude<GroupRole, "primary">, number> = {
  secondary: 0.34,
  bottom: 0.32,
};

/** Space between a group card and its neighbors, in px. */
export const GROUP_GAP = 6;
/** Sash hit area; wider than the gutter so the pointer catches it easily. */
export const SASH_HIT = 8;
/** Width of the sash highlight line. */
export const SASH_LINE = 2;
/** Corner handle size in px. */
export const CORNER_SIZE = 8;

/** Side bar sizing; the collapse/auto-collapse logic lives in the view layer. */
export const MIN_SIDEBAR_WIDTH = 168;
export const MAX_SIDEBAR_WIDTH = 300;
/** Default width for a window, until the user drags the sash once. */
export const defaultSidebarWidth = (viewport: number): number =>
  Math.round(Math.min(Math.max(viewport * 0.15, 176), 208));

/** Smallest usable size of a panel; a group's minimum is the max over its tabs. */
export const PANEL_MIN_SIZE: Record<PanelKind, PanelSize> = {
  page: { width: 460, height: 320 },
  bug: { width: 360, height: 240 },
  explorer: { width: 240, height: 220 },
  file: { width: 320, height: 220 },
  terminal: { width: 280, height: 140 },
};

/** Empty docks reserve nothing; they collapse to a point until a tab arrives. */
export function groupMinSize(group: GroupNode): PanelSize {
  if (group.panels.length === 0) return { width: 0, height: 0 };
  return group.panels.reduce<PanelSize>(
    (size, panel) => {
      const min = PANEL_MIN_SIZE[panel.kind];
      return {
        width: Math.max(size.width, min.width),
        height: Math.max(size.height, min.height),
      };
    },
    { width: 0, height: 0 },
  );
}

/** Default ratio when a drop creates a new group beside its target. */
export function defaultSplitSizes(direction: SplitDirection): number[] {
  return direction === "row" ? [0.66, 0.34] : [0.68, 0.32];
}

/** Where each panel kind opens when the caller gives no explicit target. */
export function defaultTarget(kind: PanelKind): GroupRole {
  switch (kind) {
    case "page":
      return "primary";
    case "terminal":
      return "bottom";
    case "bug":
    case "explorer":
    case "file":
      return "secondary";
  }
}

export const PAGE_VIEWS: readonly PageView[] = [
  "bugs",
  "local",
  "projects",
  "chat",
  "agent",
  "coworker",
  "mcp",
  "settings",
  "account",
];

/** Creates an empty canonical dock; role groups stay in the tree when empty. */
export function createGroup(role: GroupRole, panels: PanelRef[] = []): GroupNode {
  return {
    kind: "group",
    id: GROUP_ID[role],
    role,
    panels,
    activePanelId: panels[0]?.id ?? null,
  };
}

/**
 * Initial layout: `primary | secondary` above a full-width `bottom` dock —
 * the VS Code arrangement, and the closest match to the old "terminal spans
 * the window" behaviour.
 *
 * Empty docks keep their fraction; only the filled ones take space, so the
 * first open restores the intended size without any animation bookkeeping.
 */
export function defaultLayout(view: PageView = "bugs"): LayoutState {
  return {
    version: 1,
    root: {
      kind: "split",
      id: ROOT_SPLIT_ID,
      direction: "column",
      sizes: [1 - ROLE_DEFAULT_SIZE.bottom, ROLE_DEFAULT_SIZE.bottom],
      children: [
        {
          kind: "split",
          id: MAIN_SPLIT_ID,
          direction: "row",
          sizes: [1 - ROLE_DEFAULT_SIZE.secondary, ROLE_DEFAULT_SIZE.secondary],
          children: [
            createGroup("primary", [
              {
                id: `page:${view}`,
                kind: "page",
                resource: { type: "page", view },
                preview: false,
              },
            ]),
            createGroup("secondary"),
          ],
        },
        createGroup("bottom"),
      ],
    },
    activeGroupId: GROUP_ID.primary,
    maximizedGroupId: null,
  };
}
