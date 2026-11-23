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
  activePage,
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
  retargetPage,
  resetSizes,
  setPanelLabel,
  setSizes,
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
  LayoutState,
  PanelOpenSpec,
  PanelRef,
  PanelResource,
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

test("the main view keeps one fixed page tab and openPage switches it", () => {
  const base = defaultLayout();
  assert.equal(closePanel(base, panelId.page("bugs")), base);

  let layout = openPage(base, "settings");
  let primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:settings"]);
  assert.equal(findPanel(layout.root, panelId.page("bugs")), null);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.equal(activeView(layout), "settings");

  // Opening the page again activates the existing tab without duplicating it.
  layout = openPage(layout, "settings");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.equal(primary.panels.length, 1);

  // Even if dragged away, the page tab comes back into the primary dock.
  layout = movePanel(layout, panelId.page("settings"), GROUP_ID.secondary, 0);
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:settings"]);
  assert.equal(findPanel(layout.root, panelId.page("settings"))!.group.id, GROUP_ID.primary);

  // Visiting another view replaces the tab instead of appending one.
  layout = openPage(layout, "projects");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:projects"]);
  assert.equal(findPanel(layout.root, panelId.page("settings")), null);
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.equal(activeView(layout), "projects");
});

test("project pages open as tabs beside each other; global pages share one", () => {
  let layout = openPage(defaultLayout(), "bugs", "ws-1");
  let primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:bugs:ws-1"]);

  layout = openPage(layout, "local", "local-1", "Local One");
  layout = openPage(layout, "bugs", "ws-2", "Project Two");
  primary = findRoleGroup(layout.root, "primary")!;
  // Local project tabs lead the strip; TAPD project tabs follow.
  assert.deepEqual(
    primary.panels.map((panel) => panel.id),
    ["page:local:local-1", "page:bugs:ws-1", "page:bugs:ws-2"],
  );
  assert.deepEqual(activePage(layout), { view: "bugs", projectId: "ws-2" });

  // Focusing an existing project tab does not duplicate it.
  layout = openPage(layout, "bugs", "ws-1");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.equal(primary.panels.length, 3);
  assert.deepEqual(activePage(layout), { view: "bugs", projectId: "ws-1" });

  // Global navigation only ever owns one tab, and it coexists with projects.
  layout = openPage(layout, "settings");
  layout = openPage(layout, "account");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), [
    "page:local:local-1",
    "page:bugs:ws-1",
    "page:bugs:ws-2",
    "page:account",
  ]);

  // Every tab is closable, project pages and the navigation tab alike.
  layout = closePanel(layout, panelId.page("bugs", "ws-2"));
  assert.equal(findPanel(layout.root, panelId.page("bugs", "ws-2")), null);
  layout = closePanel(layout, panelId.page("account"));
  assert.equal(findPanel(layout.root, panelId.page("account")), null);
});

test("project pages and the shared navigation tab coexist", () => {
  // Opening a project from the projects page keeps both tabs.
  let layout = openPage(defaultLayout(), "projects");
  layout = openPage(layout, "bugs", "ws-1");
  let primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(
    primary.panels.map((panel) => panel.id),
    ["page:projects", "page:bugs:ws-1"],
  );

  // Switching the navigation tab retargets it in place, project tab stays.
  layout = openPage(layout, "account");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(
    primary.panels.map((panel) => panel.id),
    ["page:account", "page:bugs:ws-1"],
  );

  // Focusing the project tab no longer drops the navigation tab.
  layout = activatePanel(layout, panelId.page("bugs", "ws-1"));
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(
    primary.panels.map((panel) => panel.id),
    ["page:account", "page:bugs:ws-1"],
  );
  assert.equal(primary.activePanelId, panelId.page("bugs", "ws-1"));
});

test("the queue page owns a singleton tab in the secondary dock", () => {
  // The queue opens beside the navigation tab, in the right-hand dock.
  let layout = openPage(defaultLayout(), "settings");
  layout = openPage(layout, "queue");
  let secondary = findRoleGroup(layout.root, "secondary")!;
  let primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(secondary.panels.map((panel) => panel.id), ["page:queue"]);
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:settings"]);
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(secondary.activePanelId, "page:queue");
  assert.equal(activePage(layout)?.view, "queue");

  // Repeated opens only select the existing tab.
  assert.equal(openPage(layout, "queue"), layout);

  // Focusing another dock and reopening selects it again.
  layout = activateGroup(layout, GROUP_ID.primary);
  assert.notEqual(openPage(layout, "queue"), layout);

  // Other global views retarget the navigation tab without touching the queue.
  const retargeted = openPage(layout, "agent");
  primary = findRoleGroup(retargeted.root, "primary")!;
  secondary = findRoleGroup(retargeted.root, "secondary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:agent"]);
  assert.deepEqual(secondary.panels.map((panel) => panel.id), ["page:queue"]);

  // Closing the singleton and reopening lands it back in the secondary dock.
  layout = closePanel(retargeted, panelId.page("queue"));
  assert.equal(findPanel(layout.root, panelId.page("queue")), null);
  const reopened = openPage(layout, "queue");
  assert.deepEqual(
    findRoleGroup(reopened.root, "secondary")!.panels.map((panel) => panel.id),
    ["page:queue"],
  );
});

test("a migrated queue tab in the primary stays put and refocuses in place", () => {
  // Layouts persisted before the queue owned its tab can carry `page:queue`
  // as the shared navigation tab; it keeps working where it is, and opening
  // the queue again must not resurrect an empty secondary dock.
  // Normalize first so the refocus path's fixpoint can be asserted (normalize
  // collapses the raw input's single-child split).
  const inPrimary = normalize({
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary", [makePanel({ type: "page", view: "queue" })]),
      ],
      sizes: [1],
    },
    activeGroupId: GROUP_ID.primary,
    maximizedGroupId: null,
  });

  // Refocus is in place; no secondary dock is created.
  const refocused = openPage(inPrimary, "queue");
  assert.equal(refocused.activeGroupId, GROUP_ID.primary);
  assert.equal(findRoleGroup(refocused.root, "secondary"), null);
  assert.deepEqual(normalize(refocused).root, refocused.root, "fixpoint");

  // Global navigation pages coexist with the migrated queue tab.
  const withSettings = openPage(inPrimary, "settings");
  const primaryPanels = findRoleGroup(withSettings.root, "primary")!.panels.map(
    (panel) => panel.id,
  );
  assert.ok(primaryPanels.includes("page:queue"));
  assert.ok(primaryPanels.includes("page:settings"));
});

test("normalize keeps the queue page in its dock beside the navigation tab", () => {
  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary", [makePanel({ type: "page", view: "settings" })]),
        createGroup("secondary", [makePanel({ type: "page", view: "queue" })]),
      ],
      sizes: [0.66, 0.34],
    },
    activeGroupId: GROUP_ID.secondary,
    maximizedGroupId: null,
  };

  const next = normalize(layout);
  assert.deepEqual(
    findRoleGroup(next.root, "primary")!.panels.map((panel) => panel.id),
    ["page:settings"],
  );
  assert.deepEqual(
    findRoleGroup(next.root, "secondary")!.panels.map((panel) => panel.id),
    ["page:queue"],
  );
  assert.deepEqual(normalize(next).root, next.root, "normalize is a fixpoint");
});

test("a project page dragged into another dock stays and refocuses there", () => {
  let layout = openPage(defaultLayout(), "bugs", "ws-1");
  layout = openPage(layout, "bugs", "ws-2");
  layout = movePanel(layout, panelId.page("bugs", "ws-1"), GROUP_ID.secondary, 0);

  // normalize does not pull the tab back into the primary.
  const secondary = findRoleGroup(layout.root, "secondary")!;
  assert.deepEqual(secondary.panels.map((panel) => panel.id), ["page:bugs:ws-1"]);
  assert.equal(secondary.activePanelId, "page:bugs:ws-1");
  assert.deepEqual(primaryIds(layout), ["page:bugs:ws-2"]);

  // Reopening the project focuses the tab in place instead of moving it back.
  layout = activateGroup(layout, GROUP_ID.primary);
  layout = openPage(layout, "bugs", "ws-1");
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(
    findPanel(layout.root, panelId.page("bugs", "ws-1"))!.group.id,
    GROUP_ID.secondary,
  );
  assert.deepEqual(primaryIds(layout), ["page:bugs:ws-2"]);
});

test("retargetPage adopts a generic page and drops a duplicate", () => {
  // No project tab yet: the generic tab is renamed in place.
  let layout = openPage(defaultLayout(), "bugs");
  layout = retargetPage(layout, "bugs", "ws-9");
  let primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:bugs:ws-9"]);
  assert.deepEqual(activePage(layout), { view: "bugs", projectId: "ws-9" });

  // A project tab already exists: the generic leftover is dropped and the
  // project tab wins the focus.
  layout = openPage(defaultLayout(), "bugs", "ws-1");
  layout = openPage(layout, "bugs");
  layout = retargetPage(layout, "bugs", "ws-1");
  primary = findRoleGroup(layout.root, "primary")!;
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:bugs:ws-1"]);
  assert.equal(findPanel(layout.root, panelId.page("bugs")), null);

  // The project tab may live outside the primary (dragged there); adoption
  // focuses it where it is instead of writing a dangling active pointer.
  let dragged = openPage(defaultLayout(), "bugs", "ws-2");
  dragged = movePanel(dragged, panelId.page("bugs", "ws-2"), GROUP_ID.secondary, 0);
  dragged = openPage(dragged, "bugs");
  dragged = retargetPage(dragged, "bugs", "ws-2");
  const hit = findPanel(dragged.root, panelId.page("bugs", "ws-2"))!;
  assert.equal(hit.group.id, GROUP_ID.secondary);
  assert.equal(dragged.activeGroupId, GROUP_ID.secondary);
  assert.equal(hit.group.activePanelId, panelId.page("bugs", "ws-2"));
  assert.deepEqual(normalize(dragged).root, dragged.root, "fixpoint");
});

test("normalize keeps one global page in primary and project pages where they are", () => {
  const projectA = makePanel({ type: "page", view: "bugs", projectId: "ws-1" });
  const settings = makePanel({ type: "page", view: "settings" });
  const projectB = makePanel({ type: "page", view: "local", projectId: "local-1" });
  const account = makePanel({ type: "page", view: "account" });

  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary"),
        createGroup("secondary", [projectA, settings, projectB, account]),
      ],
      sizes: [0.66, 0.34],
    },
    activeGroupId: GROUP_ID.secondary,
    maximizedGroupId: null,
  };

  const next = normalize(layout);
  const primary = findRoleGroup(next.root, "primary")!;
  const secondary = findRoleGroup(next.root, "secondary")!;
  // Global pages consolidate into one navigation tab in the primary; the
  // project pages stay in the dock the user put them in.
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["page:settings"]);
  assert.deepEqual(secondary.panels.map((panel) => panel.id), [
    "page:bugs:ws-1",
    "page:local:local-1",
  ]);
  assert.ok(
    primary.panels.some((panel) => panel.id === primary.activePanelId),
  );
  assert.deepEqual(normalize(next).root, next.root, "normalize is a fixpoint");
});

test("activeView follows the active tab and is null on an empty primary", () => {
  let layout = defaultLayout();
  layout = open(layout, bug("1"));
  assert.equal(layout.activeGroupId, GROUP_ID.secondary);
  assert.equal(activeView(layout), null);

  layout = activateGroup(layout, GROUP_ID.primary);
  layout = openPage(layout, "projects");
  assert.equal(activeView(layout), "projects");
});

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

test("closing the last page tab leaves the primary dock on the welcome page", () => {
  let layout = openPage(defaultLayout(), "settings");
  layout = closePanel(layout, panelId.page("settings"));
  const primary = findRoleGroup(layout.root, "primary")!;
  assert.equal(primary.panels.length, 0);
  assert.equal(primary.activePanelId, null);
  assert.equal(activePage(layout), null);
  assert.equal(activeView(layout), null);
  assert.deepEqual(normalize(layout).root, layout.root, "normalize is a fixpoint");
});

test("closing the last tab in a non-role group removes the group", () => {
  // A role-less group only survives from a hand-built (persisted) tree now
  // that dragging cannot create one.
  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        createGroup("primary"),
        createGroup("secondary"),
        { kind: "group", id: "group:leftover", panels: [makePanel(explorer)], activePanelId: "explorer:ws" },
      ],
      sizes: [0.6, 0.2, 0.2],
    },
    activeGroupId: "group:leftover",
    maximizedGroupId: null,
  };
  const before = listGroups(layout.root).length;

  const next = closePanel(layout, "explorer:ws");
  assert.equal(listGroups(next.root).length, before - 1);
  assert.equal(findPanel(next.root, "explorer:ws"), null);
  assert.equal(findRoleGroup(next.root, "secondary")!.panels.length, 0);
  assert.equal(next.activeGroupId, GROUP_ID.primary);
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
  assert.deepEqual(primary.panels.map((panel) => panel.id), ["file:ws:a.ts"]);
  assert.equal(primary.activePanelId, "file:ws:a.ts");
  assert.equal(layout.activeGroupId, GROUP_ID.primary);
  assert.deepEqual(
    findRoleGroup(layout.root, "secondary")!.panels.map((panel) => panel.id),
    ["file:ws:b.ts"],
  );

  // Dropping a tab onto itself is a no-op (same reference, no state churn).
  assert.equal(movePanel(layout, "file:ws:a.ts", GROUP_ID.primary, 1), layout);

  layout = movePanel(layout, "file:ws:b.ts", GROUP_ID.primary, 2);
  assert.deepEqual(primaryIds(layout), ["file:ws:a.ts", "file:ws:b.ts"]);

  layout = movePanel(layout, "file:ws:a.ts", GROUP_ID.primary, 3);
  assert.deepEqual(primaryIds(layout), ["file:ws:b.ts", "file:ws:a.ts"]);
  assert.equal(findRoleGroup(layout.root, "secondary")!.panels.length, 0);
});

function primaryIds(layout: LayoutState): string[] {
  return findRoleGroup(layout.root, "primary")!.panels.map((panel) => panel.id);
}

test("setSizes and resetSizes repair ratios", () => {
  let layout = defaultLayout();
  const set = setSizes(layout, MAIN_SPLIT_ID, [0.5, 0.5]);
  approxArray(findSplit(set.root, MAIN_SPLIT_ID)!.sizes, [0.5, 0.5]);
  assert.equal(setSizes(layout, MAIN_SPLIT_ID, [1]), layout);

  const reset = resetSizes(set, MAIN_SPLIT_ID);
  approxArray(findSplit(reset.root, MAIN_SPLIT_ID)!.sizes, [0.66, 0.34]);

  // A three-way split (e.g. restored from an older layout) resets evenly.
  const three: LayoutState = {
    version: 1,
    root: {
      kind: "split",
      id: MAIN_SPLIT_ID,
      direction: "row",
      children: [
        createGroup("primary"),
        createGroup("secondary", [makePanel(explorer)]),
        { kind: "group", id: "group:third", panels: [makePanel(file("a.ts"))], activePanelId: "file:ws:a.ts" },
      ],
      sizes: [0.5, 0.3, 0.2],
    },
    activeGroupId: GROUP_ID.primary,
    maximizedGroupId: null,
  };
  const even = resetSizes(three, MAIN_SPLIT_ID);
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
  // A fresh primary dock starts on the welcome page (no seeded tab).
  assert.equal(primary.panels.length, 0);
  assert.equal(primary.activePanelId, null);
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
  // No page is seeded; the new primary dock shows the welcome page.
  assert.equal(primary.panels.length, 0);
  assert.equal(primary.activePanelId, null);
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
  // An empty primary dock has no active tab to repair; it shows the welcome.
  assert.equal(findRoleGroup(next.root, "primary")!.activePanelId, null);
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
    sidebarCollapsed: true,
  };
  savePrefs(prefs);
  const loaded = loadPrefs();
  assert.ok(loaded);
  assert.deepEqual(loaded.layout, prefs.layout);
  assert.equal(loaded.sidebarWidth, 208);
  assert.equal(loaded.sidebarCollapsed, true);
});

test("loadPrefs defaults the collapse flag on envelopes that predate it", () => {
  writePref(LAYOUT_PREF, {
    version: 1,
    layout: defaultLayout(),
    sidebarWidth: 200,
  });
  const loaded = loadPrefs();
  assert.ok(loaded);
  assert.equal(loaded.sidebarCollapsed, false);
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

test("normalize keeps one bugs page when it has to create the primary dock", () => {
  // A role-less group carrying the only page: normalize must create a primary
  // and move that page in without duplicating the seeded `page:bugs`.
  const bugs = {
    id: "page:bugs",
    kind: "page" as const,
    resource: { type: "page" as const, view: "bugs" as const },
    preview: false,
  };
  const layout: LayoutState = {
    version: 1,
    root: {
      kind: "group",
      id: "g1",
      panels: [bugs],
      activePanelId: bugs.id,
    },
    activeGroupId: "g1",
    maximizedGroupId: null,
  };

  const next = normalize(layout);
  const primary = findRoleGroup(next.root, "primary")!;
  const ids = primary.panels.map((panel) => panel.id);
  assert.equal(
    ids.filter((id) => id === "page:bugs").length,
    1,
    "exactly one bugs tab",
  );
  assert.equal(new Set(ids).size, ids.length, "panel ids are unique");
  assert.deepEqual(normalize(next).root, next.root, "normalize is a fixpoint");
});
