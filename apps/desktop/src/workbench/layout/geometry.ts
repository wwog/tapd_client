/**
 * Pure geometry for the split tree: fraction -> pixel conversion, per-child
 * minimums, sash clamping and corner (cross / T-junction) detection.
 *
 * Nothing here touches React or mutates a layout; `ops.ts` owns tree
 * transforms and the view layer only measures DOM rectangles.
 */
import { groupHasBody } from "./defaults.ts";
import type {
  GroupNode,
  LayoutNode,
  PanelSize,
  SplitDirection,
  SplitNode,
} from "./types.ts";

/** `true` for a real, finite number (rejects NaN / Infinity / non-numbers). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Converts fractions to integer pixels along one axis.
 *
 * Every child except the last is rounded independently; the last child takes
 * whatever is left so the result always sums to the rounded container size
 * (no 1px drift from independently rounding all fractions).
 */
export function resolvePx(sizes: readonly number[], totalPx: number): number[] {
  const count = sizes.length;
  if (count === 0) return [];
  const total = isFiniteNumber(totalPx) ? Math.max(0, Math.round(totalPx)) : 0;
  const out = new Array<number>(count);
  let used = 0;
  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      out[i] = Math.max(0, total - used);
    } else {
      const fraction = isFiniteNumber(sizes[i]) && sizes[i]! > 0 ? sizes[i]! : 0;
      const px = Math.min(Math.max(0, Math.round(total * fraction)), Math.max(0, total - used));
      out[i] = px;
      used += px;
    }
  }
  return out;
}

/**
 * Minimum extent of a node along `axis` (`row` = horizontal / width,
 * `column` = vertical / height).
 *
 * A nested split contributes the sum of its children when it divides along
 * the same axis, and the maximum when it stacks across it (the widest child
 * sets the width of a column, just like a flexbox cross axis).
 */
function minExtent(
  node: LayoutNode,
  axis: SplitDirection,
  groupMinSize: (group: GroupNode) => PanelSize,
): number {
  if (node.kind === "group") {
    const size = groupMinSize(node);
    const value = axis === "row" ? size.width : size.height;
    return isFiniteNumber(value) && value > 0 ? value : 0;
  }
  const mins = node.children.map((child) => minExtent(child, axis, groupMinSize));
  if (node.direction === axis) return mins.reduce((sum, value) => sum + value, 0);
  return mins.reduce((max, value) => Math.max(max, value), 0);
}

/** Per-child minimum size in px along the split's own main axis. */
export function minSizesPx(
  split: SplitNode,
  groupMinSize: (group: GroupNode) => PanelSize,
): number[] {
  return split.children.map((child) => minExtent(child, split.direction, groupMinSize));
}

/**
 * Clamps the boundary between `sizes[index]` and `sizes[index + 1]` so both
 * keep at least their minimum size. The pair keeps its combined fraction, all
 * other children are untouched, and the returned array is a new copy.
 *
 * `minPx` may be either the full per-child minimum array (aligned with
 * `sizes`, as returned by `minSizesPx`) or a two-entry `[before, after]` pair.
 *
 * When the pair is too small to satisfy both minima, the available fraction is
 * split in the same ratio as the minima: the minimums cannot all hold, but the
 * layout total (and therefore every other child) stays balanced.
 */
export function clampPair(
  sizes: readonly number[],
  index: number,
  totalPx: number,
  minPx: readonly number[],
): number[] {
  const out = sizes.slice();
  const count = out.length;
  if (!Number.isInteger(index) || index < 0 || index >= count - 1) return out;
  if (!isFiniteNumber(totalPx) || totalPx <= 0) return out;

  const pairMinA =
    minPx.length === count ? (minPx[index] ?? 0) : (minPx[0] ?? 0);
  const pairMinB =
    minPx.length === count ? (minPx[index + 1] ?? 0) : (minPx[1] ?? 0);

  const a = isFiniteNumber(out[index]) ? out[index]! : 0;
  const b = isFiniteNumber(out[index + 1]) ? out[index + 1]! : 0;
  const pairSum = a + b;
  if (!(pairSum > 0)) return out;

  const minA = Math.max(0, (isFiniteNumber(pairMinA) ? pairMinA : 0) / totalPx);
  const minB = Math.max(0, (isFiniteNumber(pairMinB) ? pairMinB : 0) / totalPx);
  const minSum = minA + minB;

  let nextA: number;
  if (minSum >= pairSum) {
    nextA = minSum > 0 ? pairSum * (minA / minSum) : pairSum / 2;
  } else {
    nextA = Math.min(Math.max(a, minA), pairSum - minB);
  }
  out[index] = nextA;
  out[index + 1] = pairSum - nextA;
  return out;
}

/**
 * Applies a drag delta (total px from the pointer-down origin) to one
 * boundary and clamps the resulting pair. Because the caller passes the
 * snapshot taken at drag start, repeated moves never accumulate rounding
 * drift.
 */
export function dragPair(
  sizes: readonly number[],
  index: number,
  deltaPx: number,
  totalPx: number,
  minPx: readonly number[],
): number[] {
  const out = sizes.slice();
  if (!isFiniteNumber(deltaPx) || !isFiniteNumber(totalPx) || totalPx <= 0) return out;
  if (!Number.isInteger(index) || index < 0 || index >= out.length - 1) return out;
  const delta = deltaPx / totalPx;
  out[index] = (isFiniteNumber(out[index]) ? out[index]! : 0) + delta;
  out[index + 1] = (isFiniteNumber(out[index + 1]) ? out[index + 1]! : 0) - delta;
  return clampPair(out, index, totalPx, minPx);
}

/**
 * Whether a subtree renders a body (panels, or the welcome page of an empty
 * primary dock). Empty side docks do not count.
 */
export function hasContent(node: LayoutNode): boolean {
  if (node.kind === "group") return groupHasBody(node);
  return node.children.some(hasContent);
}

/**
 * Children the renderer actually lays out: empty canonical docks collapse to
 * 0px, so they neither take a share nor offer a sash.
 */
export function activeChildren(
  split: SplitNode,
  groupMinSize: (group: GroupNode) => PanelSize,
): number[] {
  const mins = minSizesPx(split, groupMinSize);
  return split.children
    .map((_, index) => index)
    .filter((index) => (mins[index] ?? 0) > 0 && hasContent(split.children[index]!));
}

/**
 * Stored fractions as the renderer sees them: only the active children share
 * the container, so they are renormalized over their own sum.
 *
 * Sash dragging must use this space. Dragging stored fractions while the
 * renderer renormalizes over the filled children makes the divider jump or
 * refuse to move as soon as an empty dock is a sibling.
 */
export function renderFractions(
  sizes: readonly number[],
  active: readonly number[],
): number[] {
  const sum = active.reduce(
    (total, index) => total + Math.max(0, sizes[index] ?? 0),
    0,
  );
  return sizes.map((value, index) =>
    active.includes(index) && sum > 0 ? Math.max(0, value) / sum : 0,
  );
}

/**
 * Maps dragged rendered fractions back to stored sizes.
 *
 * Empty docks keep their share of the container, and the active children split
 * the rest by their dragged fractions, so a re-render reproduces exactly the
 * pixels the pointer asked for.
 */
export function storedFractions(
  snapshot: readonly number[],
  dragged: readonly number[],
  active: readonly number[],
): number[] {
  const next = snapshot.slice();
  // A single filled child takes the whole container; rewriting its slot to 1
  // would leave a dock that is reopened later with zero width.
  if (active.length < 2) return next;
  const allTotal = snapshot.reduce(
    (total, value) => total + Math.max(0, isFiniteNumber(value) ? value : 0),
    0,
  );
  const activeTotal = active.reduce(
    (total, index) => total + Math.max(0, snapshot[index] ?? 0),
    0,
  );
  if (!(allTotal > 0) || !(activeTotal > 0)) return next;
  const activeShare = activeTotal / allTotal;
  for (const index of active) {
    next[index] = (dragged[index] ?? 0) * activeShare;
  }
  return next;
}

export type SashPosition = {
  /** Boundary index: sits between `children[index]` and `children[index + 1]`. */
  index: number;
  /** Offset along the split's main axis, in px from its start edge. */
  offsetPx: number;
};

/**
 * Cumulative pixel offsets (from the start edge) of the sashes that should be
 * drawn for a split. A boundary is emitted only when both adjacent children
 * have content, so an empty canonical dock does not leave a dangling sash.
 */
export function sashPositions(
  split: SplitNode,
  sizesPx: readonly number[],
  hasContentFn: (node: LayoutNode) => boolean = hasContent,
): SashPosition[] {
  const out: SashPosition[] = [];
  const count = split.children.length;
  let offset = 0;
  for (let i = 0; i < count - 1; i += 1) {
    const size = isFiniteNumber(sizesPx[i]) ? Math.max(0, sizesPx[i]!) : 0;
    offset += size;
    const before = split.children[i];
    const after = split.children[i + 1];
    if (before && after && hasContentFn(before) && hasContentFn(after)) {
      out.push({ index: i, offsetPx: offset });
    }
  }
  return out;
}

/** Rectangle shape accepted from `getBoundingClientRect()` or plain objects. */
export type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
};

/** A measured sash: `direction: "row"` sashes are vertical, `"column"` horizontal. */
export type MeasuredSash = {
  splitId: string;
  index: number;
  direction: SplitDirection;
  rect: RectLike;
};

export type SashCorner = {
  /** The vertical sash (from a row split). */
  vertical: { splitId: string; index: number };
  /** The horizontal sash (from a column split). */
  horizontal: { splitId: string; index: number };
  x: number;
  y: number;
};

/** Two rectangles this close count as touching (T junctions, hairline gaps). */
export const SASH_CORNER_TOLERANCE = 2;

type Bounds = { left: number; top: number; right: number; bottom: number };

function rectBounds(rect: RectLike): Bounds | null {
  const left = rect.left;
  const top = rect.top;
  const right =
    isFiniteNumber(rect.right) ? rect.right : left + rect.width;
  const bottom =
    isFiniteNumber(rect.bottom) ? rect.bottom : top + rect.height;
  if (![left, top, right, bottom].every(isFiniteNumber)) return null;
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
  };
}

/**
 * Finds every place a vertical sash (row split) and a horizontal sash
 * (column split) touch or cross. The returned point is the centre of the
 * overlapping rectangle; with a <=2px tolerance that includes T junctions and
 * hairline rendering gaps. Crossings between two vertical or two horizontal
 * sashes are ignored.
 */
export function intersectSashes(rects: readonly MeasuredSash[]): SashCorner[] {
  const verticals = rects.filter((sash) => sash.direction === "row");
  const horizontals = rects.filter((sash) => sash.direction === "column");
  const corners: SashCorner[] = [];
  const tolerance = SASH_CORNER_TOLERANCE;

  for (const vertical of verticals) {
    const v = rectBounds(vertical.rect);
    if (!v) continue;
    for (const horizontal of horizontals) {
      const h = rectBounds(horizontal.rect);
      if (!h) continue;
      // Within tolerance on both axes: crossing, touching corner, or T.
      if (v.left > h.right + tolerance || h.left > v.right + tolerance) continue;
      if (h.top > v.bottom + tolerance || v.top > h.bottom + tolerance) continue;
      const x = (Math.max(v.left, h.left) + Math.min(v.right, h.right)) / 2;
      const y = (Math.max(v.top, h.top) + Math.min(v.bottom, h.bottom)) / 2;
      corners.push({
        vertical: { splitId: vertical.splitId, index: vertical.index },
        horizontal: { splitId: horizontal.splitId, index: horizontal.index },
        x,
        y,
      });
    }
  }
  return corners;
}
