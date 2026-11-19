/**
 * Pure geometry tests. Run from `apps/desktop`:
 *   node --test src/workbench/layout/geometry.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAIN_SPLIT_ID,
  createGroup,
  defaultLayout,
  groupHasBody,
  groupMinSize,
} from "./defaults.ts";
import {
  SASH_CORNER_TOLERANCE,
  activeChildren,
  clampPair,
  dragPair,
  hasContent,
  intersectSashes,
  minSizesPx,
  renderFractions,
  resolvePx,
  sashPositions,
  storedFractions,
} from "./geometry.ts";
import { findGroup, makePanel } from "./types.ts";
import type { GroupNode, SplitNode } from "./types.ts";

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

const pageGroup = (): GroupNode =>
  createGroup("primary", [makePanel({ type: "page", view: "bugs" })]);
const emptyGroup = (): GroupNode => createGroup("bottom");
const bugGroup = (): GroupNode =>
  createGroup("secondary", [
    makePanel({ type: "bug", workspaceId: "ws", bugId: "1" }),
  ]);

// ---------------------------------------------------------------------------
// resolvePx
// ---------------------------------------------------------------------------

test("resolvePx rounds each child and lets the last absorb the remainder", () => {
  assert.deepEqual(resolvePx([], 500), []);
  assert.deepEqual(resolvePx([1], 640), [640]);
  assert.deepEqual(resolvePx([0.5, 0.5], 1001), [501, 500]);
  assert.deepEqual(resolvePx([1 / 3, 1 / 3, 1 / 3], 100), [33, 33, 34]);
  assert.deepEqual(resolvePx([0, 1], 800), [0, 800]);
});

test("resolvePx tolerates invalid fractions and totals", () => {
  assert.deepEqual(resolvePx([Number.NaN, 1], 100), [0, 100]);
  assert.deepEqual(resolvePx([-1, 1], 100), [0, 100]);
  assert.deepEqual(resolvePx([0.5, 0.5], 0), [0, 0]);
  assert.deepEqual(resolvePx([0.5, 0.5], Number.POSITIVE_INFINITY), [0, 0]);
});

// ---------------------------------------------------------------------------
// minSizesPx
// ---------------------------------------------------------------------------

test("minSizesPx uses width along rows and height along columns", () => {
  const row: SplitNode = {
    kind: "split",
    id: "row",
    direction: "row",
    children: [pageGroup(), emptyGroup()],
    sizes: [0.5, 0.5],
  };
  assert.deepEqual(minSizesPx(row, groupMinSize), [460, 0]);

  const column: SplitNode = { ...row, id: "column", direction: "column" };
  assert.deepEqual(minSizesPx(column, groupMinSize), [320, 0]);
});

test("minSizesPx takes the max across a nested cross axis and the sum along it", () => {
  const nestedColumn: SplitNode = {
    kind: "split",
    id: "nested-column",
    direction: "column",
    children: [bugGroup(), emptyGroup()],
    sizes: [0.5, 0.5],
  };
  const parentRow: SplitNode = {
    kind: "split",
    id: "parent-row",
    direction: "row",
    children: [nestedColumn, pageGroup()],
    sizes: [0.7, 0.3],
  };
  // bug is 360 wide, so the stacked column is 360 wide; page is 460 wide.
  assert.deepEqual(minSizesPx(parentRow, groupMinSize), [360, 460]);

  const nestedRow: SplitNode = {
    kind: "split",
    id: "nested-row",
    direction: "row",
    children: [bugGroup(), emptyGroup()],
    sizes: [0.5, 0.5],
  };
  const parentColumn: SplitNode = {
    kind: "split",
    id: "parent-column",
    direction: "column",
    children: [nestedRow, pageGroup()],
    sizes: [0.5, 0.5],
  };
  assert.deepEqual(minSizesPx(parentColumn, groupMinSize), [240, 320]);
});

test("minSizesPx treats empty canonical docks as zero", () => {
  const split: SplitNode = {
    kind: "split",
    id: "s",
    direction: "row",
    children: [emptyGroup(), emptyGroup()],
    sizes: [0.5, 0.5],
  };
  assert.deepEqual(minSizesPx(split, groupMinSize), [0, 0]);
});

// ---------------------------------------------------------------------------
// clampPair / dragPair
// ---------------------------------------------------------------------------

test("clampPair enforces minima in both drag directions", () => {
  const sizes = [0.7, 0.3];
  const mins = [460, 240];
  const total = 1000;

  const draggedRight = dragPair(sizes, 0, 600, total, mins);
  approxArray(draggedRight, [0.76, 0.24]);

  const draggedLeft = dragPair(sizes, 0, -600, total, mins);
  approxArray(draggedLeft, [0.46, 0.54]);
});

test("clampPair uses the split axis minimums for columns", () => {
  const out = dragPair([0.5, 0.5], 0, -400, 600, [320, 140]);
  approx(out[0]!, 320 / 600);
  approx(out[1]!, 1 - 320 / 600);
  approx(out[0]! + out[1]!, 1);
});

test("clampPair leaves other children untouched", () => {
  const out = clampPair([0.2, 0.7, 0.1], 1, 1000, [0, 460, 240]);
  approx(out[0]!, 0.2);
  approx(out[1]!, 0.56);
  approx(out[2]!, 0.24);
  approx(out[1]! + out[2]!, 0.8);
  approx(out[0]! + out[1]! + out[2]!, 1);
});

test("clampPair accepts a two-entry pair as well as the full minimum array", () => {
  approxArray(clampPair([0.9, 0.1], 0, 1000, [460, 240]), [0.76, 0.24]);
});

test("clampPair keeps the total when both minima cannot fit", () => {
  const out = clampPair([0.2, 0.2, 0.6], 0, 1000, [460, 460]);
  approx(out[0]! + out[1]!, 0.4);
  approx(out[0]!, 0.2);
  approx(out[1]!, 0.2);
  approx(out[2]!, 0.6);
});

test("clampPair and dragPair guard invalid boundaries", () => {
  const sizes = [0.5, 0.5];
  assert.deepEqual(clampPair(sizes, 5, 1000, [0, 0]), sizes);
  assert.deepEqual(clampPair(sizes, 0, 0, [0, 0]), sizes);
  assert.deepEqual(dragPair(sizes, 0, Number.NaN, 1000, [0, 0]), sizes);
});

test("dragPair applies the total delta from the snapshot, without accumulating", () => {
  const snapshot = [0.7, 0.3];
  const first = dragPair(snapshot, 0, 120, 1000, [0, 0]);
  const second = dragPair(snapshot, 0, 120, 1000, [0, 0]);
  approx(first[0]!, 0.82);
  approx(first[1]!, 0.18);
  assert.deepEqual(first, second);
  assert.deepEqual(snapshot, [0.7, 0.3]);

  const doubled = dragPair(snapshot, 0, 240, 1000, [0, 0]);
  approx(doubled[0]!, 0.94);
});

test("corner drag combines a row and a column clamp from independent snapshots", () => {
  const vSnapshot = [0.66, 0.34];
  const hSnapshot = [0.68, 0.32];
  const vertical = dragPair(vSnapshot, 0, 80, 1200, [0, 0]);
  const horizontal = dragPair(hSnapshot, 0, -50, 700, [0, 0]);
  approx(vertical[0]!, 0.66 + 80 / 1200);
  approx(vertical[1]!, 0.34 - 80 / 1200);
  approx(horizontal[0]!, 0.68 - 50 / 700);
  approx(horizontal[1]!, 0.32 + 50 / 700);
  approx(vertical[0]! + vertical[1]!, 1);
  approx(horizontal[0]! + horizontal[1]!, 1);
});

// ---------------------------------------------------------------------------
// Sashes
// ---------------------------------------------------------------------------

test("hasContent counts groups with a body, recursively", () => {
  assert.equal(hasContent(emptyGroup()), false);
  assert.equal(hasContent(pageGroup()), true);
  const split: SplitNode = {
    kind: "split",
    id: "s",
    direction: "row",
    children: [emptyGroup(), pageGroup()],
    sizes: [0.5, 0.5],
  };
  assert.equal(hasContent(split), true);
});

test("an empty primary dock keeps its body and the page minimum", () => {
  const primary = createGroup("primary");
  // The welcome page is the only content, so the dock never collapses.
  assert.equal(groupHasBody(primary), true);
  assert.equal(hasContent(primary), true);
  assert.deepEqual(groupMinSize(primary), { width: 460, height: 320 });

  assert.equal(groupHasBody(emptyGroup()), false);
  assert.deepEqual(groupMinSize(emptyGroup()), { width: 0, height: 0 });
});

test("sashPositions uses cumulative pixels and skips boundaries with an empty side", () => {
  const layout = defaultLayout();
  const split = findSplitById(layout.root, MAIN_SPLIT_ID)!;

  // Secondary is empty in the default tree: no sash to draw.
  assert.deepEqual(sashPositions(split, resolvePx(split.sizes, 1000)), []);

  const secondary = findGroup(layout.root, "group-secondary")!;
  secondary.panels.push(makePanel({ type: "file", workspaceId: "ws", path: "a.ts" }));
  const withContent = sashPositions(split, resolvePx(split.sizes, 1000));
  assert.deepEqual(withContent, [{ index: 0, offsetPx: 660 }]);
});

test("sashPositions emits one sash per boundary between content children", () => {
  const split: SplitNode = {
    kind: "split",
    id: "s",
    direction: "row",
    children: [pageGroup(), createGroup("secondary"), emptyGroup()],
    sizes: [0.33, 0.34, 0.33],
  };
  const sizesPx = resolvePx(split.sizes, 1000);
  assert.deepEqual(sashPositions(split, sizesPx), []);

  split.children[1] = createGroup("secondary", [
    makePanel({ type: "terminal", sessionId: "t1" }),
  ]);
  assert.deepEqual(sashPositions(split, sizesPx), [
    { index: 0, offsetPx: sizesPx[0]! },
  ]);

  split.children[2] = createGroup("bottom", [
    makePanel({ type: "terminal", sessionId: "t2" }),
  ]);
  assert.deepEqual(sashPositions(split, sizesPx), [
    { index: 0, offsetPx: sizesPx[0]! },
    { index: 1, offsetPx: sizesPx[0]! + sizesPx[1]! },
  ]);
});

test("sashPositions honors a caller-provided visibility predicate", () => {
  const split: SplitNode = {
    kind: "split",
    id: "s",
    direction: "column",
    children: [pageGroup(), bugGroup()],
    sizes: [0.5, 0.5],
  };
  assert.deepEqual(sashPositions(split, [300, 300], () => false), []);
  assert.deepEqual(sashPositions(split, [300, 300], () => true), [
    { index: 0, offsetPx: 300 },
  ]);
});

// ---------------------------------------------------------------------------
// intersectSashes
// ---------------------------------------------------------------------------

const verticalSash = (splitId: string, left: number, top: number, height: number) => ({
  splitId,
  index: 0,
  direction: "row" as const,
  rect: { left, top, width: 8, height },
});

const horizontalSash = (splitId: string, left: number, top: number, width: number) => ({
  splitId,
  index: 0,
  direction: "column" as const,
  rect: { left, top, width, height: 8 },
});

test("intersectSashes finds a crossing and its overlap centre", () => {
  const corners = intersectSashes([
    verticalSash("v", 656, 100, 400),
    horizontalSash("h", 100, 296, 800),
  ]);
  assert.equal(corners.length, 1);
  assert.deepEqual(corners[0], {
    vertical: { splitId: "v", index: 0 },
    horizontal: { splitId: "h", index: 0 },
    x: 660,
    y: 300,
  });
});

test("intersectSashes includes T junctions within the 2px tolerance", () => {
  const touching = intersectSashes([
    verticalSash("v", 656, 100, 200),
    horizontalSash("h", 0, 300, 1000),
  ]);
  assert.equal(touching.length, 1);
  assert.deepEqual(touching[0]!.vertical, { splitId: "v", index: 0 });
  const tinyGap = intersectSashes([
    verticalSash("v", 656, 100, 200),
    horizontalSash("h", 0, 300 + SASH_CORNER_TOLERANCE, 1000),
  ]);
  assert.equal(tinyGap.length, 1);
});

test("intersectSashes ignores gaps wider than the tolerance", () => {
  const corners = intersectSashes([
    verticalSash("v", 656, 100, 200),
    horizontalSash("h", 0, 300 + SASH_CORNER_TOLERANCE + 1, 1000),
  ]);
  assert.deepEqual(corners, []);
});

test("intersectSashes ignores parallel sashes and finds a 2x2 grid", () => {
  assert.deepEqual(
    intersectSashes([verticalSash("v1", 100, 0, 500), verticalSash("v2", 200, 0, 500)]),
    [],
  );
  const corners = intersectSashes([
    verticalSash("v1", 100, 0, 500),
    verticalSash("v2", 300, 0, 500),
    horizontalSash("h1", 0, 100, 800),
    horizontalSash("h2", 0, 400, 800),
  ]);
  assert.equal(corners.length, 4);
  assert.deepEqual(
    corners.map((corner) => `${corner.vertical.splitId}/${corner.horizontal.splitId}`),
    ["v1/h1", "v1/h2", "v2/h1", "v2/h2"],
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSplitById(
  node: import("./types.ts").LayoutNode,
  id: string,
): SplitNode | null {
  if (node.kind === "group") return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findSplitById(child, id);
    if (hit) return hit;
  }
  return null;
}

test("a sash drag follows the pointer when an empty dock is a sibling", () => {
  // [primary, newGroup, secondary(empty)] with stored sizes that include the
  // empty dock's share. The renderer drops the empty dock and renormalizes the
  // first two over 0.66, so dragging stored fractions moved the divider the
  // wrong way; dragging rendered fractions moves it with the pointer.
  const snapshot = [0.436, 0.224, 0.34];
  const mins = [100, 100, 0];
  const total = 1000;
  const primary = pageGroup();
  const middle = makePanel({ type: "page", view: "coworker" });
  const bottom = createGroup("bottom", [middle]);
  const secondary = createGroup("secondary");
  const split: SplitNode = {
    kind: "split",
    id: "split-main",
    direction: "row",
    children: [primary, bottom, secondary],
    sizes: snapshot,
  };

  const active = activeChildren(split, groupMinSize);
  assert.deepEqual(active, [0, 1]);

  const rendered = renderFractions(snapshot, active);
  approxArray(rendered, [0.436 / 0.66, 0.224 / 0.66, 0]);

  const dragged = dragPair(rendered, 0, 100, total, mins);
  const stored = storedFractions(snapshot, dragged, active);
  const moved = renderFractions(stored, active);

  // +100px at 1000px width is exactly +0.1 in rendered space.
  approx(moved[0]!, 0.436 / 0.66 + 0.1);
  approx(moved[1]!, 0.224 / 0.66 - 0.1);
  // The empty dock keeps its share of the container.
  approx(stored[2]!, 0.34);
});
