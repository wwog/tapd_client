/**
 * Layout operation tests. Run from `apps/desktop`:
 *   node --test src/workbench/layout/ops.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GROUP_ID,
  MAIN_SPLIT_ID,
  ROLE_DEFAULT_SIZE,
  ROOT_SPLIT_ID,
  createGroup,
  defaultLayout,
  defaultSidebarWidth,
  groupMinSize,
} from "./defaults.ts";
import { dragPair, minSizesPx } from "./geometry.ts";
import {
  activateGroup,
  activatePanel,
  activeView,
  closePanel,
  ensureRoleGroup,
  findSplit,
  hasPanel,
  maximizeGroup,
  movePanel,
  normalize,
  openPage,
  openPanel,
  pinPanel,
  resetSizes,
  setPanelLabel,
  setSizes,
  splitPanel,
  syncTerminalPanels,
} from "./ops.ts";
import {
  LAYOUT_PREF,
  initialPrefs,
  loadPrefs,
  savePrefs,
} from "./persist.ts";
import {
  findGroup,
  findPanel,
  findRoleGroup,
  listGroups,
  makePanel,
  panelId,
} from "./types.ts";
import { writePref } from "../../lib/uiPrefs.ts";
import type {
  GroupNode,
  LayoutNode,
  LayoutState,
  PanelOpenSpec,
  PanelRef,
  PanelResource,
  SplitEdge,
  SplitNode,
} from "./types.ts";

// `writePref` needs a timer API; the actual config write is never invoked in
// these tests because the fake timer never fires.
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approx(actual: number, expected: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= 1e-9,
    message ?? `${actual} ≈ ${expected}`,
  );
}

function approxArray(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => approx(value, expected[index]!));
}

const file = (path: string): PanelResource => ({
  type: "file",
  workspaceId: "ws",
  path,
});
const bug = (bugId: string): PanelResource => ({
  type: "bug",
  workspaceId: "ws",
  bugId,
});
const explorer: PanelResource = { type: "explorer", workspaceId: "ws" };

function open(
  layout: LayoutState,
  resource: PanelResource,
  extra: Omit<PanelOpenSpec, "resource"> = {},
): LayoutState {
  return openPanel(layout, { resource, ...extra }, layout.activeGroupId).layout;
}

function countPanels(layout: LayoutState): number {
  return listGroups(layout.root).reduce(
    (count, group) => count + group.panels.length,
    0,
  );
}

type GroupLocation = { group: GroupNode; parent: SplitNode | null; index: number };

/** Mirrors the private locator in ops.ts so tests can assert tree position. */
function locate(
  node: LayoutNode,
  id: string,
  parent: SplitNode | null = null,
): GroupLocation | null {
  if (node.kind === "group") {
    if (node.id !== id) return null;
    return { group: node, parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  for (const child of node.children) {
    const hit = locate(child, id, node);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Open / activate
// ---------------------------------------------------------------------------

test("openPanel activates, dedupes by id, and pins an existing preview on demand", () => {
  let layout = defaultLayout();
  const first = openPanel(layout, { resource: bug("1"), label: "#1" }, layout.activeGroupId);
  assert.equal(first.panelId, "bug:ws:1");
  layout = first.layout;

  const secondary = findRoleGroup(layout.root, "secondary")!;
  assert.deepEqual(secondary.panels.map((panel) => panel.id), ["bug:ws:1"]);
  assert.equal(secondary.activePanelId, "bug:ws:1");
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(findPanel(layout.root, "bug:ws:1")!.panel.label, "#1");

  const again = openPanel(layout, { resource: bug("1") }, layout.activeGroupId);
  assert.equal(countPanels(again.layout), countPanels(layout));
  assert.equal(again.panelId, "bug:ws:1");
  assert.equal(again.layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(again.layout, layout);

  // Focusing primary and reopening the same panel moves focus back.
  layout = activateGroup(again.layout, GROUP_ID.primary);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  const refocused = openPanel(layout, { resource: bug("1") }, layout.activeGroupId);
  assert.equal(refocused.layout.activeGroupId, GROUP_ID.secondary);

  // preview:false pins an existing preview.
  let previewLayout = defaultLayout();
  previewLayout = open(
    previewLayout,
    file("a.ts"),
    { preview: true },
  );
  assert.equal(findPanel(previewLayout.root, "file:ws:a.ts")!.panel.preview, true);
  const pinned = openPanel(
    previewLayout,
    { resource: file("a.ts"), preview: false },
    previewLayout.activeGroupId,
  );
  assert.equal(findPanel(pinned.layout.root, "file:ws:a.ts")!.panel.preview, false);
});

test("preview tabs replace the previous preview of the same kind in the target group", () => {
  let layout = defaultLayout();
  layout = open(layout, file("a.ts"), { preview: true });
  layout = open(layout, file("b.ts"), { preview: true });

  let secondary = findRoleGroup(layout.root, "secondary")!;
  assert.deepEqual(secondary.panels.map((panel) => panel.id), ["file:ws:b.ts"]);
  assert.equal(secondary.panels[0]!.preview, true);

  // A pinned tab does not get replaced; the preview slot moves to it.
  layout = open(layout, file("c.ts"));
  layout = open(layout, file("d.ts"), { preview: true });
  secondary = findRoleGroup(layout.root, "secondary")!;
  assert.deepEqual(secondary.panels.map((panel) => panel.id), [
    "file:ws:d.ts",
    "file:ws:c.ts",
  ]);
  assert.equal(secondary.activePanelId, "file:ws:d.ts");
  assert.equal(secondary.panels[0]!.preview, true);
  assert.equal(secondary.panels[1]!.preview, false);
});

test("bug panels are singleton by kind and retarget in place", () => {
  let layout = defaultLayout();
  layout = open(layout, bug("1"), { label: "one" });
  layout = open(layout, bug("2"), { label: "two" });

  const bugs = listGroups(layout.root).flatMap((group) =>
    group.panels.filter((panel) => panel.kind === "bug"),
  );
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0]!.id, "bug:ws:2");
  assert.equal(bugs[0]!.resource.type === "bug" ? bugs[0]!.resource.bugId : "", "2");
  assert.equal(bugs[0]!.label, "two");
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(findRoleGroup(layout.root, "secondary")!.activePanelId, "bug:ws:2");
});

test("page tabs are permanent and openPage brings a page back into primary", () => {
  const base = defaultLayout();
  assert.equal(closePanel(base, panelId.page("bugs")), base);

  let layout = openPage(base, "settings");
  let primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), [
    "page:bugs",
    "page:settings",
  ]);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.equal(activeView(layout), "settings");

  // Opening the page again activates the existing tab without duplicating it.
  layout = openPage(layout, "settings");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.equal(primary.panels.length, 2);

  // Even if moved away, openPage moves the page tab back into primary.
  layout = movePanel(layout, panelId.page("settings"), GROUP_ID.secondary, 0);
  assert.equal(
    findPanel(layout.root, panelId.page("settings"))!.group.id,
    GROUP_ID.secondary,
  );
  layout = openPage(layout, "settings");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), [
    "page:bugs",
    "page:settings",
  ]);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.equal(activeView(layout), "settings");
});

test("activeView falls back from the active tab to primary's first page", () => {
  let layout = defaultLayout();
  layout = open(layout, bug("1"));
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(activeView(layout), "bugs");

  layout = activateGroup(layout, GROUP_ID.primary);
  layout = openPage(layout, "projects");
  assert.equal(activeView(layout), "projects");
});

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

test("closing the last tab in a non-role group removes the group", () => {
  let layout = defaultLayout();
  layout = open(layout, explorer);
  layout = splitPanel(layout, "explorer:ws", GROUP_ID.secondary, "right");

  const newGroup = findPanel(layout.root, "explorer:ws")!.group;
  assert.equal(newGroup.role, undefined);
  const before = listGroups(layout.root).length;

  layout = closePanel(layout, "explorer:ws");
  assert.equal(listGroups(layout.root).length, before - 1);
  assert.equal(findPanel(layout.root, "explorer:ws"), null);
  assert.equal(findRoleGroup(layout.root, "secondary")!.panels.length, 0);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
});

test("closing the last tab in a role group keeps the dock and refocuses primary", () => {
  let layout = defaultLayout();
  layout = open(layout, explorer);
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);

  layout = closePanel(layout, "explorer:ws");
  const secondary = findRoleGroup(layout.root, "secondary")!;
  assert.equal(secondary.panels.length, 0);
  assert.equal(secondary.activePanelId, null);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
});

test("closing a tab activates its next or previous neighbor", () => {
  let layout = defaultLayout();
  layout = open(layout, file("a.ts"));
  layout = open(layout, file("b.ts"));
  assert.equal(findRoleGroup(layout.root, "secondary")!.activePanelId, "file:ws:b.ts");

  layout = closePanel(layout, "file:ws:b.ts");
  assert.equal(findRoleGroup(layout.root, "secondary")!.activePanelId, "file:ws:a.ts");

  layout = closePanel(layout, "file:ws:a.ts");
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.equal(findRoleGroup(layout.root, "secondary")!.activePanelId, null);
});

// ---------------------------------------------------------------------------
// Move / split / sizes
// ---------------------------------------------------------------------------

test("movePanel moves tabs across groups and reorders within one", () => {
  let layout = defaultLayout();
  layout = open(layout, file("a.ts"));
  layout = open(layout, file("b.ts"));

  layout = movePanel(layout, "file:ws:a.ts", GROUP_ID.primary, 1);
  const primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), [
    "page:bugs",
    "file:ws:a.ts",
  ]);
  assert.equal(primary.activePanelId, "file:ws:a.ts");
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.deepEqual(
    findRoleGroup(layout.root, "secondary")!.panels.map((panel) => panel.id),
    ["file:ws:b.ts"],
  );

  // Dropping a tab onto itself is a no-op (same reference, no state churn).
  assert.equal(movePanel(layout, "file:ws:a.ts", GROUP_ID.primary, 1), layout);

  layout = movePanel(layout, "file:ws:b.ts", GROUP_ID.primary, 2);
  assert.deepEqual(primaryIds(layout), ["page:bugs", "file:ws:a.ts", "file:ws:b.ts"]);

  layout = movePanel(layout, "file:ws:a.ts", GROUP_ID.primary, 3);
  assert.deepEqual(primaryIds(layout), ["page:bugs", "file:ws:b.ts", "file:ws:a.ts"]);
  assert.equal(findRoleGroup(layout.root, "secondary")!.panels.length, 0);
});

function primaryIds(layout: LayoutState): string[] {
  return findRoleGroup(layout.root, "primary")!.panels.map((panel) => panel.id);
}

const EDGES: readonly SplitEdge[] = ["left", "right", "top", "bottom"];

for (const edge of EDGES) {
  test(`splitPanel creates the new group on the ${edge} edge`, () => {
    let layout = defaultLayout();
    layout = open(layout, explorer);
    const next = splitPanel(layout, "explorer:ws", GROUP_ID.secondary, edge);

    const hit = findPanel(next.root, "explorer:ws")!;
    const newLocation = locate(next.root, hit.group.id)!;
    const targetLocation = locate(next.root, GROUP_ID.secondary)!;

    assert.equal(hit.group.role, undefined);
    assert.match(hit.group.id, /^group:/);
    assert.equal(next.activeGroupId, hit.group.id);
    assert.ok(newLocation.parent);
    assert.equal(newLocation.parent, targetLocation.parent);

    const isRow = edge === "left" || edge === "right";
    const before = edge === "left" || edge === "top";
    assert.equal(newLocation.parent!.direction, isRow ? "row" : "column");
    assert.equal(
      before
        ? newLocation.index < targetLocation.index
        : newLocation.index > targetLocation.index,
      true,
    );

    const parent = newLocation.parent!;
    approx(parent.sizes.reduce((sum, value) => sum + value, 0), 1);
    if (isRow) {
      // `split-main` is [0.66, 0.34]; the new sibling gets 34% of the target.
      approx(parent.sizes[newLocation.index]!, 0.34 * 0.34);
      approx(parent.sizes[targetLocation.index]!, 0.34 * 0.66);
    } else {
      // The target is wrapped in a new column split with the default ratio.
      assert.equal(parent.children.length, 2);
      approx(parent.sizes[0]!, before ? 0.32 : 0.68);
      approx(parent.sizes[1]!, before ? 0.68 : 0.32);
    }
  });
}

test("setSizes and resetSizes repair ratios", () => {
  let layout = defaultLayout();
  const set = setSizes(layout, MAIN_SPLIT_ID, [0.5, 0.5]);
  approxArray(findSplit(set.root, MAIN_SPLIT_ID)!.sizes, [0.5, 0.5]);
  assert.equal(setSizes(layout, MAIN_SPLIT_ID, [1]), layout);

  const reset = resetSizes(set, MAIN_SPLIT_ID);
  approxArray(findSplit(reset.root, MAIN_SPLIT_ID)!.sizes, [0.66, 0.34]);

  layout = open(layout, explorer);
  layout = splitPanel(layout, "explorer:ws", GROUP_ID.secondary, "right");
  const three = findSplit(layout.root, MAIN_SPLIT_ID)!;
  assert.equal(three.children.length, 3);
  const even = resetSizes(layout, MAIN_SPLIT_ID);
  for (const size of findSplit(even.root, MAIN_SPLIT_ID)!.sizes) {
    approx(size, 1 / 3);
  }
});

test("corner drag composes a row and a column split update", () => {
  let layout = defaultLayout();
  layout = open(layout, bug("1"));

  const main = findSplit(layout.root, MAIN_SPLIT_ID)!;
  const root = findSplit(layout.root, ROOT_SPLIT_ID)!;
  const vSizes = dragPair(main.sizes, 0, 40, 2000, minSizesPx(main, groupMinSize));
  const hSizes = dragPair(root.sizes, 0, -30, 700, minSizesPx(root, groupMinSize));

  const next = setSizes(
    setSizes(layout, MAIN_SPLIT_ID, vSizes),
    ROOT_SPLIT_ID,
    hSizes,
  );
  approx(findSplit(next.root, MAIN_SPLIT_ID)!.sizes[0]!, 0.66 + 40 / 2000);
  approx(findSplit(next.root, ROOT_SPLIT_ID)!.sizes[0]!, 0.68 - 30 / 700);
  approx(
    findSplit(next.root, MAIN_SPLIT_ID)!.sizes[0]! +
      findSplit(next.root, MAIN_SPLIT_ID)!.sizes[1]!,
    1,
  );
  approx(
    findSplit(next.root, ROOT_SPLIT_ID)!.sizes[0]! +
      findSplit(next.root, ROOT_SPLIT_ID)!.sizes[1]!,
    1,
  );
});

// ---------------------------------------------------------------------------
// Helpers and role docks
// ---------------------------------------------------------------------------

test("panel helpers: pin, label, activate, hasPanel, maximize", () => {
  let layout = defaultLayout();
  layout = open(layout, file("a.ts"), { preview: true });
  assert.equal(hasPanel(layout, "file:ws:a.ts"), true);
  assert.equal(hasPanel(layout, "file:ws:none"), false);

  const pinned = pinPanel(layout, "file:ws:a.ts");
  assert.equal(findPanel(pinned.root, "file:ws:a.ts")!.panel.preview, false);
  assert.equal(pinPanel(pinned, "file:ws:a.ts"), pinned);

  const labelled = setPanelLabel(pinned, "file:ws:a.ts", "A.ts");
  assert.equal(findPanel(labelled.root, "file:ws:a.ts")!.panel.label, "A.ts");
  const unlabelled = setPanelLabel(labelled, "file:ws:a.ts", "");
  assert.equal("label" in findPanel(unlabelled.root, "file:ws:a.ts")!.panel, false);

  layout = activateGroup(labelled, GROUP_ID.primary);
  const activated = activatePanel(layout, "file:ws:a.ts");
  assert.equal(activated.activeGroupId, GROUP_ID.secondary);
  assert.equal(findRoleGroup(activated.root, "secondary")!.activePanelId, "file:ws:a.ts");
  assert.equal(activatePanel(activated, "missing"), activated);

  const maximized = maximizeGroup(labelled, GROUP_ID.secondary);
  assert.equal(maximized.maximizedGroupId, GROUP_ID.secondary);
  assert.equal(maximizeGroup(maximized, null).maximizedGroupId, null);
  assert.equal(maximizeGroup(labelled, "missing").maximizedGroupId, null);
});

test("ensureRoleGroup recreates secondary and bottom in their canonical positions", () => {
  let layout = defaultLayout();
  const main = findSplit(layout.root, MAIN_SPLIT_ID)!;
  main.children = [main.children[0]!];
  main.sizes = [1];
  layout = ensureRoleGroup(layout, "secondary");
  const mainAfter = findSplit(layout.root, MAIN_SPLIT_ID)!;
  assert.equal(mainAfter.children.length, 2);
  assert.equal((mainAfter.children[1] as GroupNode).role, "secondary");
  approx(mainAfter.sizes[1]!, ROLE_DEFAULT_SIZE.secondary);

  let bottomLayout = defaultLayout();
  const root = findSplit(bottomLayout.root, ROOT_SPLIT_ID)!;
  root.children = [root.children[0]!];
  root.sizes = [1];
  bottomLayout = ensureRoleGroup(bottomLayout, "bottom");
  const rootAfter = findSplit(bottomLayout.root, ROOT_SPLIT_ID)!;
  assert.equal(rootAfter.children.length, 2);
  assert.equal((rootAfter.children[1] as GroupNode).role, "bottom");
  approx(rootAfter.sizes[1]!, ROLE_DEFAULT_SIZE.bottom);

  const only: LayoutState = {
    version: 1,
    root: createGroup("secondary", [makePanel(file("x"))]),
    activeGroupId: GROUP_ID.secondary,
    maximizedGroupId: null,
  };
  const withPrimary = ensureRoleGroup(only, "primary");
  const primary = findRoleGroup(withPrimary.root, "primary")!;
  assert.ok(primary.panels.some((panel) => panel.kind === "page"));
});

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

test("normalize repairs empty groups, single-child splits, sizes and pointers", () => {
  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary", [makePanel({ type: "page", view: "bugs" })]),
        {
          kind: "split",
          id: "single",
          direction: "column",
          children: [createGroup("bottom")],
          sizes: [1],
        },
        { kind: "group", id: "empty", panels: [], activePanelId: null },
      ],
      sizes: [Number.NaN, -1, 2],
    },
    activeGroupId: "empty",
    maximizedGroupId: "empty",
  };

  const next = normalize(layout);
  assert.equal(findGroup(next.root, "empty"), null);
  assert.equal(findSplit(next.root, "single"), null);
  assert.equal(findGroup(next.root, GROUP_ID.bottom)!.role, "bottom");
  assert.equal(next.activeGroupId, GROUP_ID.primary);
  assert.equal(next.maximizedGroupId, null);

  if (next.root.kind !== "split") assert.fail("root should stay a split");
  assert.equal(next.root.sizes.length, next.root.children.length);
  approx(next.root.sizes.reduce((sum, value) => sum + value, 0), 1);
  for (const size of next.root.sizes) {
    assert.ok(Number.isFinite(size) && size >= 0);
  }
});

test("normalize creates a primary dock when it is missing", () => {
  const layout: LayoutState = {
    version: 1,
    root: createGroup("secondary", [makePanel(file("a.ts"))]),
    activeGroupId: GROUP_ID.secondary,
    maximizedGroupId: null,
  };
  const next = normalize(layout);
  const primary = findRoleGroup(next.root, "primary")!;
  assert.ok(primary);
  assert.ok(primary.panels.some((panel) => panel.id === panelId.page("bugs")));
  assert.ok(findPanel(next.root, "file:ws:a.ts"));
  assert.equal(next.activeGroupId, GROUP_ID.secondary);
});

test("normalize moves page:bugs back into primary instead of duplicating it", () => {
  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary"),
        createGroup("secondary", [makePanel({ type: "page", view: "bugs" })]),
      ],
      sizes: [0.66, 0.34],
    },
    activeGroupId: GROUP_ID.secondary,
    maximizedGroupId: null,
  };
  const next = normalize(layout);
  const primary = findRoleGroup(next.root, "primary")!;
  const secondary = findRoleGroup(next.root, "secondary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), [panelId.page("bugs")]);
  assert.equal(secondary.panels.length, 0);
  assert.equal(secondary.activePanelId, null);
  assert.equal(
    listGroups(next.root)
      .flatMap((group) => group.panels)
      .filter((panel) => panel.id === panelId.page("bugs")).length,
    1,
  );
});

test("normalize drops duplicate panel ids and unknown panels", () => {
  const duplicate = makePanel(file("a.ts"));
  const unknown = {
    id: "weird",
    kind: "weird",
    resource: { type: "weird" },
    preview: false,
  } as unknown as PanelRef;

  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary", [
          makePanel({ type: "page", view: "bugs" }),
          duplicate,
        ]),
        createGroup("secondary", [duplicate, unknown]),
      ],
      sizes: [0.6, 0.4],
    },
    activeGroupId: GROUP_ID.primary,
    maximizedGroupId: null,
  };

  const next = normalize(layout);
  const allPanels = listGroups(next.root).flatMap((group) => group.panels);
  assert.equal(allPanels.filter((panel) => panel.id === "file:ws:a.ts").length, 1);
  assert.equal(allPanels.some((panel) => panel.id === "weird"), false);
});

test("normalize repairs active pointers and size arrays", () => {
  const layout = defaultLayout();
  const primary = findRoleGroup(layout.root, "primary")!;
  primary.activePanelId = "missing";
  const root = layout.root as SplitNode;
  root.sizes = [0.9];
  layout.activeGroupId = "missing";

  const next = normalize(layout);
  assert.equal(findRoleGroup(next.root, "primary")!.activePanelId, panelId.page("bugs"));
  assert.equal(next.activeGroupId, GROUP_ID.primary);
  const nextRoot = next.root as SplitNode;
  assert.equal(nextRoot.sizes.length, nextRoot.children.length);
  approx(nextRoot.sizes.reduce((sum, value) => sum + value, 0), 1);
});

// ---------------------------------------------------------------------------
// Terminal sync
// ---------------------------------------------------------------------------

test("syncTerminalPanels adds, relabels and removes tabs without stealing focus", () => {
  const empty = defaultLayout();
  assert.equal(syncTerminalPanels(empty, []), empty);

  let layout = defaultLayout();
  layout = activateGroup(layout, GROUP_ID.primary);

  let next = syncTerminalPanels(layout, [
    { id: "t1", label: "Terminal 1" },
    { id: "t2", label: "Terminal 2" },
  ]);
  // Re-syncing the same session list is a no-op (same tree reference).
  assert.equal(
    syncTerminalPanels(next, [
      { id: "t1", label: "Terminal 1" },
      { id: "t2", label: "Terminal 2" },
    ]),
    next,
  );
  let bottom = findRoleGroup(next.root, "bottom")!;
  assert.deepEqual(bottom.panels.map((panel) => panel.id), [
    "terminal:t1",
    "terminal:t2",
  ]);
  assert.equal(bottom.panels[0]!.label, "Terminal 1");
  assert.equal(bottom.panels[0]!.preview, false);
  assert.equal(bottom.activePanelId, "terminal:t1");
  assert.equal(next.activeGroupId, GROUP_ID.primary);

  // t2 disappears, t1 is relabelled, t3 appears.
  next = syncTerminalPanels(next, [
    { id: "t1", label: "build" },
    { id: "t3", label: "Terminal 3" },
  ]);
  bottom = findRoleGroup(next.root, "bottom")!;
  assert.deepEqual(bottom.panels.map((panel) => panel.id), [
    "terminal:t1",
    "terminal:t3",
  ]);
  assert.equal(bottom.panels[0]!.label, "build");
  assert.equal(next.activeGroupId, GROUP_ID.primary);

  // No sessions: terminal tabs go away, the bottom dock (a role group) stays.
  next = syncTerminalPanels(next, []);
  bottom = findRoleGroup(next.root, "bottom")!;
  assert.equal(bottom.panels.length, 0);
  assert.equal(bottom.activePanelId, null);
  assert.equal(next.activeGroupId, GROUP_ID.primary);
});

test("syncTerminalPanels creates the bottom dock only when a session is missing", () => {
  const layout = defaultLayout();
  const root = layout.root as SplitNode;
  root.children = [root.children[0]!];
  root.sizes = [1];

  const next = syncTerminalPanels(layout, [{ id: "t1", label: "T1" }]);
  const bottom = findRoleGroup(next.root, "bottom")!;
  assert.deepEqual(bottom.panels.map((panel) => panel.id), ["terminal:t1"]);
  assert.equal(next.activeGroupId, GROUP_ID.primary);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("persistence round-trips a normalized layout", () => {
  const prefs = {
    version: 1 as const,
    layout: defaultLayout(),
    sidebarWidth: 208,
  };
  savePrefs(prefs);
  const loaded = loadPrefs();
  assert.ok(loaded);
  assert.deepEqual(loaded.layout, prefs.layout);
  assert.equal(loaded.sidebarWidth, 208);
});

test("loadPrefs keeps valid panels and drops unknown ones", () => {
  const layout = defaultLayout();
  const secondary = findRoleGroup(layout.root, "secondary")!;
  secondary.panels.push(
    {
      id: "weird",
      kind: "weird",
      resource: { type: "weird" },
      preview: false,
    } as unknown as PanelRef,
    {
      id: "page:not-a-view",
      kind: "page",
      resource: { type: "page", view: "nope" },
      preview: false,
    } as unknown as PanelRef,
  );

  writePref(LAYOUT_PREF, { version: 1, layout, sidebarWidth: 200 });
  const loaded = loadPrefs();
  assert.ok(loaded);
  assert.equal(findPanel(loaded.layout.root, "weird"), null);
  assert.equal(findPanel(loaded.layout.root, "page:not-a-view"), null);
});

test("loadPrefs rejects malformed envelopes", () => {
  writePref(LAYOUT_PREF, {
    version: 1,
    layout: {
      version: 1,
      root: { kind: "nope" },
      activeGroupId: "x",
      maximizedGroupId: null,
    },
    sidebarWidth: 200,
  });
  assert.equal(loadPrefs(), null);

  writePref(LAYOUT_PREF, { version: 2, layout: defaultLayout(), sidebarWidth: 200 });
  assert.equal(loadPrefs(), null);

  writePref(LAYOUT_PREF, {
    version: 1,
    layout: defaultLayout(),
    sidebarWidth: Number.NaN,
  });
  assert.equal(loadPrefs(), null);
});

test("initialPrefs migrates the legacy terminal height into the bottom split", () => {
  writePref("terminal.panel.v1", { open: true, height: 300 });
  const prefs = initialPrefs(1280, 1000);
  const root = prefs.layout.root as SplitNode;
  assert.equal(root.kind, "split");
  const bottomIndex = root.children.findIndex(
    (child) => child.kind === "group" && child.role === "bottom",
  );
  assert.ok(bottomIndex >= 0);
  approx(root.sizes[bottomIndex]!, 0.3);
  assert.equal(findRoleGroup(prefs.layout.root, "bottom")!.panels.length, 0);
  assert.equal(prefs.sidebarWidth, defaultSidebarWidth(1280));

  writePref("terminal.panel.v1", { open: true, height: 2000 });
  approx((initialPrefs(1280, 1000).layout.root as SplitNode).sizes[1]!, 0.7);

  writePref("terminal.panel.v1", { open: true, height: 10 });
  approx((initialPrefs(1280, 1000).layout.root as SplitNode).sizes[1]!, 0.15);

  writePref("terminal.panel.v1", undefined);
});
