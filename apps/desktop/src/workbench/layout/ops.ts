/**
 * Pure split-tree transforms behind `useWorkbenchLayout`.
 *
 * Every export takes a `LayoutState` and returns a new one (never mutates the
 * input). `normalize` is the only repair function: the remaining operations
 * assume a normalized tree and finish with `normalize` after structural edits,
 * so invariants from `docs/WORKBENCH.md` §3 hold after every commit.
 */
import {
  GROUP_ID,
  PAGE_VIEWS,
  ROLE_DEFAULT_SIZE,
  createGroup,
  defaultSplitSizes,
  defaultTarget,
} from "./defaults.ts";
import {
  findGroup,
  findPanel,
  findRoleGroup,
  listGroups,
  makePanel,
  panelId,
} from "./types.ts";
import type {
  GroupNode,
  GroupRole,
  LayoutNode,
  LayoutState,
  PageView,
  PanelOpenSpec,
  PanelRef,
  PanelResource,
  SplitDirection,
  SplitEdge,
  SplitNode,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

let idSeq = 0;

/** `group:` / `split:` ids for groups the user creates by dragging. */
function randomId(prefix: "group" | "split"): string {
  idSeq += 1;
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}${idSeq.toString(36)}`;
}

function equalShares(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

function isGroupRole(value: unknown): value is GroupRole {
  return value === "primary" || value === "secondary" || value === "bottom";
}

const PAGE_VIEW_SET: ReadonlySet<string> = new Set<string>(PAGE_VIEWS);
const PANEL_KIND_SET: ReadonlySet<string> = new Set([
  "page",
  "bug",
  "explorer",
  "file",
  "terminal",
]);

function isPanelResource(value: unknown): value is PanelResource {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "page":
      return typeof value.view === "string" && PAGE_VIEW_SET.has(value.view);
    case "bug":
      return (
        typeof value.workspaceId === "string" &&
        value.workspaceId.length > 0 &&
        typeof value.bugId === "string" &&
        value.bugId.length > 0
      );
    case "explorer":
      return typeof value.workspaceId === "string" && value.workspaceId.length > 0;
    case "file":
      return (
        typeof value.workspaceId === "string" &&
        value.workspaceId.length > 0 &&
        typeof value.path === "string" &&
        value.path.length > 0
      );
    case "terminal":
      return typeof value.sessionId === "string" && value.sessionId.length > 0;
    default:
      return false;
  }
}

/**
 * Rebuilds a persisted panel from its resource. Unknown kinds, unknown page
 * views and mismatched kind/resource pairs are dropped by returning null; ids
 * are always re-derived so a corrupted id cannot break persistence keys.
 */
function normalizePanel(raw: unknown): PanelRef | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.kind !== "string" || !PANEL_KIND_SET.has(raw.kind)) return null;
  if (!isPanelResource(raw.resource)) return null;
  if (raw.resource.type !== raw.kind) return null;
  const label = typeof raw.label === "string" && raw.label.length > 0 ? raw.label : undefined;
  return makePanel(raw.resource, {
    preview: raw.preview === true,
    ...(label ? { label } : {}),
  });
}

function canonicalRoleForId(id: string): GroupRole | undefined {
  for (const role of Object.keys(GROUP_ID) as GroupRole[]) {
    if (GROUP_ID[role] === id) return role;
  }
  return undefined;
}

function cloneLayout(layout: LayoutState): LayoutState {
  if (typeof structuredClone === "function") return structuredClone(layout);
  return JSON.parse(JSON.stringify(layout)) as LayoutState;
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => Math.abs(value - (b[index] ?? 0)) < 1e-12);
}

/** Creates a canonical role group, avoiding a duplicate canonical id. */
function freshRoleGroup(root: LayoutNode | null, role: GroupRole): GroupNode {
  const panels =
    role === "primary" ? [makePanel({ type: "page", view: "bugs" })] : [];
  const group = createGroup(role, panels);
  if (root && findGroup(root, group.id)) group.id = randomId("group");
  return group;
}

/** Locates a group plus its parent split and index (parent null at the root). */
type GroupLocation = {
  group: GroupNode;
  parent: SplitNode | null;
  index: number;
};

function locateGroup(
  node: LayoutNode,
  id: string,
  parent: SplitNode | null = null,
): GroupLocation | null {
  if (node.kind === "group") {
    if (node.id !== id) return null;
    return { group: node, parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  for (const child of node.children) {
    const hit = locateGroup(child, id, node);
    if (hit) return hit;
  }
  return null;
}

/** Replaces the group node carrying `id` with `replacement` (returns the root). */
function replaceGroupNode(
  node: LayoutNode,
  id: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.kind === "group") return node.id === id ? replacement : node;
  node.children = node.children.map((child) => replaceGroupNode(child, id, replacement));
  return node;
}

/** Finds a split by id (exported for the hook's sash snapshots). */
export function findSplit(node: LayoutNode, id: string): SplitNode | null {
  if (node.kind === "group") return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findSplit(child, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Inserts `child` at `index`, giving it `share` of the split and scaling the
 * remaining children down proportionally so the sizes still sum to 1.
 */
function insertChildAt(
  split: SplitNode,
  index: number,
  child: LayoutNode,
  share: number,
): void {
  const count = split.children.length;
  if (count === 0) {
    split.children = [child];
    split.sizes = [1];
    return;
  }
  const clampedShare = Math.min(Math.max(share, 0.01), 0.99);
  const rest = 1 - clampedShare;
  const base =
    split.sizes.length === count
      ? split.sizes.slice()
      : Array.from({ length: count }, () => 1 / count);
  const total = base.reduce(
    (sum, value) => sum + (isFiniteNumber(value) && value > 0 ? value : 0),
    0,
  );
  const scaled = base.map((value) => {
    const fraction = isFiniteNumber(value) && value > 0 ? value : 0;
    return total > 0 ? (fraction / total) * rest : rest / count;
  });
  const at = Math.min(Math.max(Math.trunc(index), 0), count);
  scaled.splice(at, 0, clampedShare);
  split.sizes = scaled;
  split.children.splice(at, 0, child);
}

/** Normalizes a raw sizes array to `count` finite, non-negative fractions summing to 1. */
function normalizeSizes(values: readonly unknown[], count: number): number[] {
  if (count <= 0) return [];
  const cleaned: Array<number | null> = [];
  for (let i = 0; i < count; i += 1) {
    const value = values[i];
    cleaned.push(isFiniteNumber(value) && value >= 0 ? value : null);
  }
  const known = cleaned.filter((value): value is number => value !== null);
  const knownSum = known.reduce((sum, value) => sum + value, 0);
  const fallback = known.length > 0 && knownSum > 0 ? knownSum / known.length : 1;
  const filled = cleaned.map((value) => value ?? fallback);
  const total = filled.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return equalShares(count);
  // Preserve exact persisted values when they already form a valid sum; only
  // pay the floating-point division cost when a fix-up is actually needed.
  if (Math.abs(total - 1) < 1e-9) return filled;
  return filled.map((value) => value / total);
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

function normalizeNode(raw: unknown, seen: Set<string>): LayoutNode | null {
  if (!isRecord(raw)) return null;

  if (raw.kind === "group") {
    const panels: PanelRef[] = [];
    if (Array.isArray(raw.panels)) {
      for (const rawPanel of raw.panels) {
        const panel = normalizePanel(rawPanel);
        if (!panel || seen.has(panel.id)) continue;
        seen.add(panel.id);
        panels.push(panel);
      }
    }
    const id =
      typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomId("group");
    const role = isGroupRole(raw.role) ? raw.role : canonicalRoleForId(id);
    // Empty non-role groups only exist during editing; drop them here.
    if (!role && panels.length === 0) return null;
    const activePanelId =
      typeof raw.activePanelId === "string" &&
      panels.some((panel) => panel.id === raw.activePanelId)
        ? raw.activePanelId
        : (panels[0]?.id ?? null);
    return {
      kind: "group",
      id,
      ...(role ? { role } : {}),
      panels,
      activePanelId,
    };
  }

  if (raw.kind === "split") {
    const direction: SplitDirection | null =
      raw.direction === "row" || raw.direction === "column" ? raw.direction : null;
    if (!direction) return null;
    const rawChildren = Array.isArray(raw.children) ? raw.children : [];
    const rawSizes = Array.isArray(raw.sizes) ? raw.sizes : [];
    const kept: Array<{ node: LayoutNode; rawSize: unknown }> = [];
    for (let i = 0; i < rawChildren.length; i += 1) {
      const node = normalizeNode(rawChildren[i], seen);
      if (node) kept.push({ node, rawSize: rawSizes[i] });
    }
    if (kept.length === 0) return null;
    // A split must have at least two children; a lone survivor takes its slot.
    if (kept.length === 1) return kept[0]!.node;
    const id =
      typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomId("split");
    return {
      kind: "split",
      id,
      direction,
      children: kept.map((entry) => entry.node),
      sizes: normalizeSizes(kept.map((entry) => entry.rawSize), kept.length),
    };
  }

  return null;
}

/** Removes empty non-role groups and collapses single-child splits. */
function pruneNode(node: LayoutNode): LayoutNode | null {
  if (node.kind === "group") {
    return !node.role && node.panels.length === 0 ? null : node;
  }
  const children: LayoutNode[] = [];
  const sizes: unknown[] = [];
  for (let i = 0; i < node.children.length; i += 1) {
    const child = pruneNode(node.children[i]!);
    if (!child) continue;
    children.push(child);
    sizes.push(node.sizes[i]);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  node.children = children;
  node.sizes = normalizeSizes(sizes, children.length);
  return node;
}

/** Repairs every group's active tab pointer. */
function fixPointers(node: LayoutNode): void {
  if (node.kind === "group") {
    if (!node.panels.some((panel) => panel.id === node.activePanelId)) {
      node.activePanelId = node.panels[0]?.id ?? null;
    }
    return;
  }
  for (const child of node.children) fixPointers(child);
}

/** Inserts the primary group as the first (main) area of the tree. */
function insertPrimary(root: LayoutNode, group: GroupNode): LayoutNode {
  if (root.kind === "group") {
    return {
      kind: "split",
      id: randomId("split"),
      direction: "row",
      children: [group, root],
      sizes: [0.5, 0.5],
    };
  }
  // Walk down the first-child chain so the primary lands in the deepest
  // leading split (the default `row [primary, secondary]` in `split-main`).
  let split = root;
  for (;;) {
    const first = split.children[0];
    if (!first || first.kind !== "split") break;
    split = first;
  }
  insertChildAt(split, 0, group, 0.5);
  return root;
}

/** Removes one panel by id and repairs the group's active pointer. */
function removePanelFromGroup(group: GroupNode, id: string): void {
  const index = group.panels.findIndex((panel) => panel.id === id);
  if (index === -1) return;
  group.panels.splice(index, 1);
  if (group.activePanelId === id) {
    group.activePanelId =
      group.panels[Math.min(index, group.panels.length - 1)]?.id ?? null;
  }
}

/**
 * Ensures exactly one primary group exists and that the whole tree carries
 * exactly one page tab: the main view is a single fixed navigation tab, so
 * visiting another page changes that tab instead of appending one. The
 * preferred survivor is the primary's active page, then its first page, then
 * any page (a page dragged to another dock is moved back here).
 */
function ensurePrimary(root: LayoutNode): { root: LayoutNode; primary: GroupNode } {
  const seenRoles = new Set<GroupRole>();
  for (const group of listGroups(root)) {
    if (!group.role) continue;
    if (seenRoles.has(group.role)) delete group.role;
    else seenRoles.add(group.role);
  }

  let primary = findRoleGroup(root, "primary");
  if (!primary) {
    const group = freshRoleGroup(root, "primary");
    root = insertPrimary(root, group);
    primary = group;
  }

  const pages: Array<{ panel: PanelRef; group: GroupNode }> = [];
  for (const group of listGroups(root)) {
    for (const panel of group.panels) {
      if (panel.kind === "page") pages.push({ panel, group });
    }
  }
  const keep =
    pages.find(
      (page) =>
        page.group.id === primary.id && page.panel.id === primary.activePanelId,
    ) ??
    pages.find((page) => page.group.id === primary.id) ??
    pages[0] ??
    null;

  for (const page of pages) {
    if (keep && page.panel.id === keep.panel.id) continue;
    removePanelFromGroup(page.group, page.panel.id);
  }

  if (!keep) {
    primary.panels.push(makePanel({ type: "page", view: "bugs" }));
    if (primary.activePanelId === null) {
      primary.activePanelId = primary.panels[0]?.id ?? null;
    }
    return { root, primary };
  }

  if (keep.group.id !== primary.id) {
    removePanelFromGroup(keep.group, keep.panel.id);
    primary.panels.push(keep.panel);
  }
  if (
    primary.activePanelId === null ||
    !primary.panels.some((panel) => panel.id === primary.activePanelId)
  ) {
    primary.activePanelId = keep.panel.id;
  }
  return { root, primary };
}

/**
 * Repairs any layout, persisted or hand-built: drops unknown/invalid panels,
 * removes empty non-role groups, collapses single-child splits, fixes sizes,
 * restores the primary dock with a page tab, and repairs active pointers.
 */
export function normalize(layout: LayoutState): LayoutState {
  const seenPanels = new Set<string>();
  let root = normalizeNode(layout?.root, seenPanels);
  if (!root) root = freshRoleGroup(null, "primary");

  const ensured = ensurePrimary(root);
  root = ensured.root;
  root = pruneNode(root) ?? freshRoleGroup(null, "primary");
  fixPointers(root);

  // Pruning can remove the active group when it was an empty non-role dock.
  const activeGroupId =
    typeof layout?.activeGroupId === "string" && findGroup(root, layout.activeGroupId)
      ? layout.activeGroupId
      : ensured.primary.id;
  const maximizedGroupId =
    typeof layout?.maximizedGroupId === "string" &&
    findGroup(root, layout.maximizedGroupId)
      ? layout.maximizedGroupId
      : null;

  return { version: 1, root, activeGroupId, maximizedGroupId };
}

// ---------------------------------------------------------------------------
// Open / close / activate
// ---------------------------------------------------------------------------

export type OpenPanelResult = { layout: LayoutState; panelId: string };

/**
 * Opens or focuses a panel.
 *
 * - An existing id is activated (and pinned when `preview === false`).
 * - Bug panels are singleton by kind: a new bug retargets the existing tab.
 * - Preview tabs replace the previous preview of the same kind in the target
 *   group; otherwise the panel is appended.
 */
export function openPanel(
  layout: LayoutState,
  spec: PanelOpenSpec,
  activeGroupId: string,
): OpenPanelResult {
  const preview = spec.preview === true;
  const panel = makePanel(spec.resource, {
    preview,
    ...(spec.label ? { label: spec.label } : {}),
  });

  const current = findPanel(layout.root, panel.id);
  if (current) {
    const needsPin = spec.preview === false && current.panel.preview;
    const alreadyActive =
      current.group.activePanelId === panel.id &&
      layout.activeGroupId === current.group.id;
    if (!needsPin && alreadyActive) return { layout, panelId: panel.id };

    const next = cloneLayout(layout);
    const existing = findPanel(next.root, panel.id)!;
    if (spec.preview === false) existing.panel.preview = false;
    existing.group.activePanelId = panel.id;
    next.activeGroupId = existing.group.id;
    return { layout: normalize(next), panelId: panel.id };
  }

  let next = cloneLayout(layout);

  // `bug` is singleton by kind (docs/WORKBENCH.md §2.3).
  if (panel.kind === "bug") {
    for (const group of listGroups(next.root)) {
      const index = group.panels.findIndex((candidate) => candidate.kind === "bug");
      if (index === -1) continue;
      group.panels[index] = panel;
      group.activePanelId = panel.id;
      next.activeGroupId = group.id;
      return { layout: normalize(next), panelId: panel.id };
    }
  }

  let target: GroupNode | null = null;
  if (spec.target === "active") {
    target = findGroup(next.root, activeGroupId) ?? findRoleGroup(next.root, "primary");
  } else if (spec.target) {
    target = findRoleGroup(next.root, spec.target);
    if (!target) {
      next = ensureRoleGroup(next, spec.target);
      target = findRoleGroup(next.root, spec.target);
    }
  } else {
    const role = defaultTarget(panel.kind);
    target = findRoleGroup(next.root, role);
    if (!target) {
      next = ensureRoleGroup(next, role);
      target = findRoleGroup(next.root, role);
    }
  }

  if (!target) {
    // Normalized layouts always have a primary dock; keep the tree untouched
    // rather than throwing if a caller passes a hand-built broken layout.
    return { layout: normalize(next), panelId: panel.id };
  }

  let replaced = false;
  if (preview) {
    const index = target.panels.findIndex(
      (candidate) => candidate.preview && candidate.kind === panel.kind,
    );
    if (index !== -1) {
      target.panels[index] = panel;
      replaced = true;
    }
  }
  if (!replaced) target.panels.push(panel);
  target.activePanelId = panel.id;
  next.activeGroupId = target.id;
  return { layout: normalize(next), panelId: panel.id };
}

/**
 * Switches the primary group's single page tab to `view` and activates it.
 * The page tab represents the whole main view, so the previous page panel is
 * dropped by `normalize` instead of being left behind as another tab.
 */
export function openPage(layout: LayoutState, view: PageView): LayoutState {
  let base = layout;
  if (!findRoleGroup(base.root, "primary")) base = ensureRoleGroup(base, "primary");
  const primary = findRoleGroup(base.root, "primary");
  if (!primary) return normalize(base);

  const id = panelId.page(view);
  const hit = findPanel(base.root, id);
  const pageCount = listGroups(base.root).reduce(
    (count, group) =>
      count + group.panels.filter((panel) => panel.kind === "page").length,
    0,
  );
  if (
    hit &&
    hit.group.id === primary.id &&
    primary.activePanelId === id &&
    base.activeGroupId === primary.id &&
    pageCount <= 1
  ) {
    return base;
  }

  const next = cloneLayout(base);
  const nextPrimary = findRoleGroup(next.root, "primary")!;
  const current = findPanel(next.root, id);
  if (current) {
    if (current.group.id !== nextPrimary.id) {
      removePanelFromGroup(current.group, id);
      nextPrimary.panels.push(current.panel);
    }
  } else {
    nextPrimary.panels.push(makePanel({ type: "page", view }));
  }
  nextPrimary.activePanelId = id;
  next.activeGroupId = nextPrimary.id;
  return normalize(next);
}

/**
 * Closes a closable tab. Page tabs are permanent. The neighbor to the right
 * (else the left) becomes active; when the group empties, focus falls back to
 * the primary dock and non-role groups are removed by `normalize`.
 */
export function closePanel(layout: LayoutState, panelIdToClose: string): LayoutState {
  const hit = findPanel(layout.root, panelIdToClose);
  if (!hit || hit.panel.kind === "page") return layout;

  const next = cloneLayout(layout);
  const current = findPanel(next.root, panelIdToClose);
  if (!current) return layout;
  const group = current.group;
  const wasActive = next.activeGroupId === group.id;

  group.panels.splice(current.index, 1);
  group.activePanelId =
    group.panels.length === 0
      ? null
      : group.panels[Math.min(current.index, group.panels.length - 1)]!.id;

  const normalized = normalize(next);
  if (wasActive) {
    const active = findGroup(normalized.root, normalized.activeGroupId);
    if (!active || active.panels.length === 0) {
      const fallback =
        findRoleGroup(normalized.root, "primary") ?? listGroups(normalized.root)[0];
      if (fallback) normalized.activeGroupId = fallback.id;
    }
  }
  return normalized;
}

export function pinPanel(layout: LayoutState, panelIdToPin: string): LayoutState {
  const hit = findPanel(layout.root, panelIdToPin);
  if (!hit || !hit.panel.preview) return layout;
  const next = cloneLayout(layout);
  const current = findPanel(next.root, panelIdToPin);
  if (!current) return layout;
  current.panel.preview = false;
  return next;
}

export function setPanelLabel(
  layout: LayoutState,
  panelIdToLabel: string,
  label: string,
): LayoutState {
  const hit = findPanel(layout.root, panelIdToLabel);
  if (!hit) return layout;
  if ((hit.panel.label ?? "") === label) return layout;
  const next = cloneLayout(layout);
  const current = findPanel(next.root, panelIdToLabel);
  if (!current) return layout;
  if (label) current.panel.label = label;
  else delete current.panel.label;
  return next;
}

export function activatePanel(layout: LayoutState, panelIdToActivate: string): LayoutState {
  const hit = findPanel(layout.root, panelIdToActivate);
  if (!hit) return layout;
  if (
    layout.activeGroupId === hit.group.id &&
    hit.group.activePanelId === panelIdToActivate
  ) {
    return layout;
  }
  const next = cloneLayout(layout);
  const current = findPanel(next.root, panelIdToActivate);
  if (!current) return layout;
  current.group.activePanelId = panelIdToActivate;
  next.activeGroupId = current.group.id;
  return next;
}

export function activateGroup(layout: LayoutState, groupId: string): LayoutState {
  const group = findGroup(layout.root, groupId);
  if (!group) return layout;
  if (layout.activeGroupId === groupId) return layout;
  const next = cloneLayout(layout);
  const target = findGroup(next.root, groupId);
  if (!target) return layout;
  target.activePanelId =
    target.panels.some((panel) => panel.id === target.activePanelId)
      ? target.activePanelId
      : (target.panels[0]?.id ?? null);
  next.activeGroupId = target.id;
  return next;
}

export function hasPanel(layout: LayoutState, panelIdToFind: string): boolean {
  return findPanel(layout.root, panelIdToFind) !== null;
}

// ---------------------------------------------------------------------------
// Move / split
// ---------------------------------------------------------------------------

/**
 * Moves a tab into `groupId` at `index` (center drop). Same-group drops that
 * do not change the position are no-ops; other same-group drops reorder.
 * The moved panel becomes active in its new group.
 */
export function movePanel(
  layout: LayoutState,
  panelIdToMove: string,
  groupId: string,
  index: number,
): LayoutState {
  const hit = findPanel(layout.root, panelIdToMove);
  const target = findGroup(layout.root, groupId);
  if (!hit || !target) return layout;

  const targetIndex = Math.min(
    Math.max(Number.isFinite(index) ? Math.trunc(index) : 0, 0),
    target.panels.length,
  );
  const sameGroup = hit.group.id === groupId;
  if (sameGroup && (targetIndex === hit.index || targetIndex === hit.index + 1)) {
    return layout;
  }

  const next = cloneLayout(layout);
  const current = findPanel(next.root, panelIdToMove);
  const destination = findGroup(next.root, groupId);
  if (!current || !destination) return layout;

  const source = current.group;
  source.panels.splice(current.index, 1);
  source.activePanelId =
    source.panels.length === 0
      ? null
      : source.panels[Math.min(current.index, source.panels.length - 1)]!.id;

  if (sameGroup) {
    const adjusted = targetIndex > current.index ? targetIndex - 1 : targetIndex;
    destination.panels.splice(Math.min(adjusted, destination.panels.length), 0, current.panel);
  } else {
    destination.panels.splice(Math.min(targetIndex, destination.panels.length), 0, current.panel);
  }
  destination.activePanelId = current.panel.id;
  next.activeGroupId = destination.id;
  return normalize(next);
}

/**
 * Edge drop: splits `groupId` in the direction of `edge` and puts the panel
 * into the new group. A matching parent split hosts the new sibling directly;
 * otherwise the target group is wrapped in a fresh split. The new group gets
 * `defaultSplitSizes(direction)[1]` of the target's share, the target keeps
 * the remaining `[0]` share.
 */
export function splitPanel(
  layout: LayoutState,
  panelIdToSplit: string,
  groupId: string,
  edge: SplitEdge,
): LayoutState {
  const direction: SplitDirection | null =
    edge === "left" || edge === "right"
      ? "row"
      : edge === "top" || edge === "bottom"
        ? "column"
        : null;
  if (!direction) return layout;
  const before = edge === "left" || edge === "top";

  const hit = findPanel(layout.root, panelIdToSplit);
  if (!hit || !findGroup(layout.root, groupId)) return layout;

  const next = cloneLayout(layout);
  const current = findPanel(next.root, panelIdToSplit);
  if (!current) return layout;

  const source = current.group;
  source.panels.splice(current.index, 1);
  source.activePanelId =
    source.panels.length === 0
      ? null
      : source.panels[Math.min(current.index, source.panels.length - 1)]!.id;

  const newGroup: GroupNode = {
    kind: "group",
    id: randomId("group"),
    panels: [current.panel],
    activePanelId: current.panel.id,
  };
  const location = locateGroup(next.root, groupId);
  if (!location) return layout;

  const defaults = defaultSplitSizes(direction);
  const targetShare = defaults[0]!;
  const newShare = defaults[1]!;
  const parent = location.parent;

  if (parent && parent.direction === direction) {
    const share = isFiniteNumber(parent.sizes[location.index])
      ? parent.sizes[location.index]!
      : 1 / parent.children.length;
    const keep = share * targetShare;
    const added = share * newShare;
    if (before) {
      parent.children.splice(location.index, 0, newGroup);
      parent.sizes.splice(location.index, 1, added, keep);
    } else {
      parent.children.splice(location.index + 1, 0, newGroup);
      parent.sizes[location.index] = keep;
      parent.sizes.splice(location.index + 1, 0, added);
    }
  } else {
    const split: SplitNode = {
      kind: "split",
      id: randomId("split"),
      direction,
      children: before ? [newGroup, location.group] : [location.group, newGroup],
      sizes: before ? [newShare, targetShare] : [targetShare, newShare],
    };
    next.root = replaceGroupNode(next.root, groupId, split);
  }

  next.activeGroupId = newGroup.id;
  return normalize(next);
}

export function setSizes(
  layout: LayoutState,
  splitId: string,
  sizes: readonly number[],
): LayoutState {
  const split = findSplit(layout.root, splitId);
  if (!split || sizes.length !== split.children.length) return layout;
  const cleaned = sizes.map((value) =>
    isFiniteNumber(value) && value > 0 ? value : 0,
  );
  const total = cleaned.reduce((sum, value) => sum + value, 0);
  const nextSizes = total > 0 ? cleaned.map((value) => value / total) : equalShares(sizes.length);
  if (sameNumbers(split.sizes, nextSizes)) return layout;
  const next = cloneLayout(layout);
  const target = findSplit(next.root, splitId);
  if (!target) return layout;
  target.sizes = nextSizes;
  return next;
}

/** Double-click reset: two children restore the default ratio, N split evenly. */
export function resetSizes(layout: LayoutState, splitId: string): LayoutState {
  const split = findSplit(layout.root, splitId);
  if (!split) return layout;
  const sizes =
    split.children.length === 2
      ? defaultSplitSizes(split.direction)
      : equalShares(split.children.length);
  return setSizes(layout, splitId, sizes);
}

export function maximizeGroup(
  layout: LayoutState,
  groupId: string | null,
): LayoutState {
  const nextId =
    typeof groupId === "string" && findGroup(layout.root, groupId) ? groupId : null;
  if (layout.maximizedGroupId === nextId) return layout;
  const next = cloneLayout(layout);
  next.maximizedGroupId = nextId;
  return next;
}

// ---------------------------------------------------------------------------
// Canonical role groups
// ---------------------------------------------------------------------------

/**
 * Recreates a missing canonical dock.
 *
 * - `secondary`: right of primary — inserted into the primary's row parent,
 *   otherwise the primary is wrapped in a new row split.
 * - `bottom`: appended to the whole-tree column split, otherwise the whole
 *   tree is wrapped in a new column split.
 * - `primary`: inserted as the leading main area.
 */
export function ensureRoleGroup(layout: LayoutState, role: GroupRole): LayoutState {
  if (findRoleGroup(layout.root, role)) return layout;
  let next = cloneLayout(layout);

  // A group carrying the canonical id but no role adopts it instead of
  // creating a duplicate id.
  const canonical = findGroup(next.root, GROUP_ID[role]);
  if (canonical && !canonical.role) {
    canonical.role = role;
    return next;
  }

  if (role === "primary") {
    const group = freshRoleGroup(next.root, "primary");
    next.root = insertPrimary(next.root, group);
    if (!findGroup(next.root, next.activeGroupId)) next.activeGroupId = group.id;
    return next;
  }

  if (role === "secondary") {
    if (!findRoleGroup(next.root, "primary")) next = ensureRoleGroup(next, "primary");
    const primary = findRoleGroup(next.root, "primary");
    if (!primary) return next;
    const group = freshRoleGroup(next.root, "secondary");
    const location = locateGroup(next.root, primary.id);
    if (!location) return next;
    if (location.parent && location.parent.direction === "row") {
      insertChildAt(
        location.parent,
        location.index + 1,
        group,
        ROLE_DEFAULT_SIZE.secondary,
      );
    } else {
      const split: SplitNode = {
        kind: "split",
        id: randomId("split"),
        direction: "row",
        children: [primary, group],
        sizes: [1 - ROLE_DEFAULT_SIZE.secondary, ROLE_DEFAULT_SIZE.secondary],
      };
      next.root = replaceGroupNode(next.root, primary.id, split);
    }
    return next;
  }

  const group = freshRoleGroup(next.root, "bottom");
  if (next.root.kind === "split" && next.root.direction === "column") {
    insertChildAt(next.root, next.root.children.length, group, ROLE_DEFAULT_SIZE.bottom);
  } else {
    next.root = {
      kind: "split",
      id: randomId("split"),
      direction: "column",
      children: [next.root, group],
      sizes: [1 - ROLE_DEFAULT_SIZE.bottom, ROLE_DEFAULT_SIZE.bottom],
    };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Terminal reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconciles backend-owned PTY sessions into terminal tabs in the bottom dock.
 * Missing sessions are appended, labels follow the backend, and tabs whose
 * session disappeared are removed. Focus never moves: `activeGroupId` is not
 * touched (normalize only falls back if the active group itself vanished) and
 * new tabs are never previews.
 */
export function syncTerminalPanels(
  layout: LayoutState,
  sessions: readonly { id: string; label: string }[],
): LayoutState {
  const wanted = new Map<string, string>();
  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    if (wanted.has(session.id)) continue;
    wanted.set(session.id, typeof session.label === "string" ? session.label : "");
  }

  // Preflight: most syncs (focus changes, identical session pushes) change
  // nothing, and returning the same tree avoids a re-render and a pref write.
  const claimed = new Set<string>();
  let changed = false;
  for (const group of listGroups(layout.root)) {
    for (const panel of group.panels) {
      if (panel.kind !== "terminal") continue;
      const sessionId =
        panel.resource.type === "terminal" ? panel.resource.sessionId : "";
      if (!wanted.has(sessionId) || claimed.has(panel.id)) {
        changed = true;
        continue;
      }
      claimed.add(panel.id);
      const label = wanted.get(sessionId) ?? "";
      const desiredLabel = label.length > 0 ? label : undefined;
      if (panel.preview !== false || panel.label !== desiredLabel) changed = true;
    }
  }
  const missing = [...wanted].filter(
    ([sessionId]) => !claimed.has(panelId.terminal(sessionId)),
  );
  if (missing.length > 0) changed = true;
  if (!changed) return layout;

  let next = cloneLayout(layout);
  const existing = new Map<string, PanelRef>();

  for (const group of listGroups(next.root)) {
    const kept: PanelRef[] = [];
    for (const panel of group.panels) {
      if (panel.kind !== "terminal") {
        kept.push(panel);
        continue;
      }
      const sessionId =
        panel.resource.type === "terminal" ? panel.resource.sessionId : "";
      // Unknown session, or a duplicate id already claimed earlier in the tree.
      if (!wanted.has(sessionId) || existing.has(panel.id)) continue;
      const label = wanted.get(sessionId) ?? "";
      panel.preview = false;
      if (label) panel.label = label;
      else delete panel.label;
      existing.set(panel.id, panel);
      kept.push(panel);
    }
    group.panels = kept;
    if (!group.panels.some((panel) => panel.id === group.activePanelId)) {
      group.activePanelId = group.panels[0]?.id ?? null;
    }
  }

  if (missing.length > 0) {
    if (!findRoleGroup(next.root, "bottom")) {
      next = ensureRoleGroup(next, "bottom");
    }
    const bottom = findRoleGroup(next.root, "bottom");
    if (bottom) {
      for (const [sessionId, label] of missing) {
        const panel = makePanel(
          { type: "terminal", sessionId },
          { ...(label ? { label } : {}) },
        );
        panel.preview = false;
        bottom.panels.push(panel);
        existing.set(panel.id, panel);
      }
      if (bottom.activePanelId === null && bottom.panels.length > 0) {
        bottom.activePanelId = bottom.panels[0]!.id;
      }
    }
  }

  return normalize(next);
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** Active page view; falls back to the primary dock's first page, else "bugs". */
export function activeView(layout: LayoutState): PageView {
  const activeGroup = findGroup(layout.root, layout.activeGroupId);
  const activePanel = activeGroup?.panels.find(
    (panel) => panel.id === activeGroup.activePanelId,
  );
  if (activePanel?.kind === "page" && activePanel.resource.type === "page") {
    return activePanel.resource.view;
  }
  const primary = findRoleGroup(layout.root, "primary");
  const primaryPage = primary?.panels.find(
    (panel) => panel.kind === "page" && panel.resource.type === "page",
  );
  if (primaryPage?.resource.type === "page") return primaryPage.resource.view;
  return "bugs";
}
