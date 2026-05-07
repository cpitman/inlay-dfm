/**
 * Typed wrapper around `clipper-lib` for polygon boolean operations
 * and Minkowski offsetting. Clipper internally uses INT64 arithmetic
 * for numerical robustness — we scale our floating-point design
 * coordinates by `CLIPPER_SCALE` on input and rescale on output.
 *
 * Why a wrapper:
 *   - `clipper-lib` ships untyped, pre-class-syntax JS. The wrapper
 *     pins the surface we use to a small, typed API and hides the
 *     int-scaling so call sites stay in design units.
 *   - Even-odd fill rule is enforced consistently. The pipeline
 *     relies on it for hole interpretation and to match SVG semantics.
 *   - All operations return canonical `MultiPolygon`s (no degenerate
 *     rings, no zero-length edges, simplified by Clipper internally).
 */

import ClipperLib, { type PolyNode } from 'clipper-lib';
import type { MultiPolygon, Ring } from './polygon';

/**
 * Float → int multiplier for Clipper's integer-arithmetic core.
 * Resolution = 1 / CLIPPER_SCALE design units. At 1e6 with typical
 * SVG viewBox dimensions (~300 user units = ~12.6"), this gives
 * ~1.3e-8 inch resolution — far below any meaningful tolerance.
 *
 * The choice trades resolution against safe int range. Clipper's
 * IntPoint coordinates must fit in 53 effective bits (JS number).
 * 1e6 × 1e3 design units = 1e9 ≪ 2^53 — comfortable headroom.
 */
const CLIPPER_SCALE = 1e6;

/** Convert one ring to Clipper's `Path` of integer points. */
function ringToClipperPath(ring: Ring): { X: number; Y: number }[] {
  const out: { X: number; Y: number }[] = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    out[i] = {
      X: Math.round(ring[i].x * CLIPPER_SCALE),
      Y: Math.round(ring[i].y * CLIPPER_SCALE),
    };
  }
  return out;
}

/** Convert a MultiPolygon to Clipper's `Paths`. */
function multiPolygonToClipperPaths(mp: MultiPolygon): { X: number; Y: number }[][] {
  return mp.map(ringToClipperPath);
}

/** Convert one Clipper integer ring back to a float-coord ring. */
function clipperPathToRing(path: { X: number; Y: number }[]): Ring {
  const out: Ring = new Array(path.length);
  for (let i = 0; i < path.length; i++) {
    out[i] = {
      x: path[i].X / CLIPPER_SCALE,
      y: path[i].Y / CLIPPER_SCALE,
    };
  }
  return out;
}

function clipperPathsToMultiPolygon(paths: { X: number; Y: number }[][]): MultiPolygon {
  return paths
    .map(clipperPathToRing)
    .filter(r => r.length >= 3);
}

type ClipType = 'union' | 'intersection' | 'difference' | 'xor';

const CLIP_TYPE_MAP = {
  union:        ClipperLib.ClipType.ctUnion,
  intersection: ClipperLib.ClipType.ctIntersection,
  difference:   ClipperLib.ClipType.ctDifference,
  xor:          ClipperLib.ClipType.ctXor,
};

/**
 * Run a boolean operation between two `MultiPolygon`s. Both inputs
 * are interpreted with even-odd fill. The result is canonical
 * (deduplicated, non-self-intersecting, valid topology under
 * even-odd).
 *
 * `subject` is the "left" operand (e.g., `subject - clip` for
 * difference); `clip` is the "right". For commutative ops (union,
 * intersection, xor), order doesn't matter.
 */
export function clipperBoolean(
  op: ClipType,
  subject: MultiPolygon,
  clip: MultiPolygon,
): MultiPolygon {
  const subj = multiPolygonToClipperPaths(subject);
  const clp  = multiPolygonToClipperPaths(clip);
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clp,  ClipperLib.PolyType.ptClip,    true);
  const solution: { X: number; Y: number }[][] = [];
  c.Execute(
    CLIP_TYPE_MAP[op],
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  );
  return clipperPathsToMultiPolygon(solution);
}

/** Convenience: `a ∪ b`. */
export function multiPolygonUnion(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  return clipperBoolean('union', a, b);
}

/** Convenience: `a ∩ b`. */
export function multiPolygonIntersection(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  return clipperBoolean('intersection', a, b);
}

/** Convenience: `a − b`. */
export function multiPolygonDifference(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  return clipperBoolean('difference', a, b);
}

/**
 * Union a list of `MultiPolygon`s, treating each as a complete
 * even-odd polygon. Pairwise reduction via `multiPolygonUnion`.
 *
 * NOTE: a single-pass approach (add every part as subject, run
 * `ctUnion` once with EvenOdd) does NOT work — under EvenOdd, two
 * overlapping subject parts CANCEL in the overlap (XOR semantics),
 * producing the symmetric difference instead of the true union.
 * The pairwise reduction is correct because each `multiPolygonUnion`
 * call runs `ctUnion` against subject (= accumulator) and clip (=
 * next part), where the subject's interior is ALL of the
 * accumulator (not split across multiple subjects).
 */
export function multiPolygonUnionAll(parts: MultiPolygon[]): MultiPolygon {
  if (parts.length === 0) return [];
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) {
    acc = clipperBoolean('union', acc, parts[i]);
  }
  return acc;
}

/**
 * Minkowski offset (inflate / deflate) by `delta` in design units.
 * Positive `delta` grows the polygon outward; negative shrinks it
 * inward (with rings that fully erode disappearing from the output).
 *
 * `joinType` controls how convex corners are handled. Round is the
 * default for v-carve work since the bit's tip is round and the
 * full-depth contour rolls smoothly around corners.
 *
 * `arcTolerance` controls round-corner segment density (in design
 * units). Default is `delta / 100`, which gives sub-pixel-accurate
 * arcs at typical scales. A tighter value adds vertices.
 */
export function multiPolygonOffset(
  mp: MultiPolygon,
  delta: number,
  options?: {
    joinType?: 'round' | 'square' | 'miter';
    arcTolerance?: number;
    miterLimit?: number;
  },
): MultiPolygon {
  if (mp.length === 0) return [];

  const joinType = options?.joinType ?? 'round';
  const miterLimit = options?.miterLimit ?? 2.0;
  // Clipper's arc tolerance is in INT-scaled units. Default to a
  // small fraction of |delta| to keep arc segments below 1% chord
  // error.
  const arcToleranceDesign = options?.arcTolerance ?? Math.max(Math.abs(delta) / 100, 1e-4);
  const arcToleranceInt = arcToleranceDesign * CLIPPER_SCALE;

  const co = new ClipperLib.ClipperOffset(miterLimit, arcToleranceInt);
  const paths = multiPolygonToClipperPaths(mp);
  const jt = joinType === 'round'  ? ClipperLib.JoinType.jtRound
           : joinType === 'square' ? ClipperLib.JoinType.jtSquare
           :                          ClipperLib.JoinType.jtMiter;
  co.AddPaths(paths, jt, ClipperLib.EndType.etClosedPolygon);

  const solution: { X: number; Y: number }[][] = [];
  co.Execute(solution, delta * CLIPPER_SCALE);
  return clipperPathsToMultiPolygon(solution);
}

/**
 * One inner-ring (hole) of a polygon component. Carries the ring
 * itself plus a flag indicating whether the hole contains any
 * nested rings (= islands of the same layer). A leaf hole is one
 * with no nested rings; its interior is uniformly outside the
 * layer. A non-leaf hole has structure inside (more islands and
 * possibly more holes within those) — filling it via "absorb the
 * ring's interior into the layer" would also absorb the islands,
 * which is destructive when those islands are meaningful (e.g.,
 * stroke segments inside the body-interior hole of the synthesized
 * stroke layer).
 */
export interface PolygonHole {
  ring: Ring;
  hasIslands: boolean;
}

/**
 * One connected component of a polygon: a single outer ring (the
 * "shell") plus zero or more inner rings ("holes") that lie inside
 * it. Holes do not lie inside other holes — nested outer rings
 * (islands within holes) are returned as their own separate
 * components. This matches the typical SVG-and-CAM intuition.
 */
export interface PolygonComponent {
  outer: Ring;
  holes: PolygonHole[];
}

/**
 * Decompose a `MultiPolygon` into connected components, each with
 * its outer ring and its inner holes. Walks Clipper's PolyTree:
 *   - Top-level non-hole nodes → outer rings of separate components.
 *   - Their direct hole children → holes belonging to that
 *     component, each tagged with `hasIslands` for whether nested
 *     same-layer geometry sits inside the hole.
 *   - Hole children of a hole (= nested island) → outer rings of
 *     yet more separate components, recursively.
 */
export function multiPolygonComponents(mp: MultiPolygon): PolygonComponent[] {
  if (mp.length === 0) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(multiPolygonToClipperPaths(mp), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  );

  const out: PolygonComponent[] = [];

  // Recursive walker. Each non-hole node is an outer ring of a
  // component; its direct hole-children belong to it. Hole's own
  // non-hole grandchildren are nested islands → recurse.
  const walk = (node: PolyNode): void => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        // New component: this node is the outer.
        const outer = clipperPathToRing(child.Contour());
        const holes: PolygonHole[] = [];
        for (const hole of child.Childs()) {
          if (hole.IsHole()) {
            const ring = clipperPathToRing(hole.Contour());
            if (ring.length >= 3) {
              holes.push({ ring, hasIslands: hole.Childs().length > 0 });
            }
            // Holes' grandchildren (nested islands) → separate components.
            walk(hole);
          }
        }
        if (outer.length >= 3) out.push({ outer, holes });
      } else {
        // Top-level holes are unusual (PolyTree root has no contour),
        // but we still recurse to find islands inside them.
        walk(child);
      }
    }
  };
  walk(tree);
  return out;
}

/**
 * Walk a polygon's even-odd hierarchy in BFS order, calling
 * `visit` for each hole ring (= depth-1, 3, 5… in the PolyTree:
 * holes inside top-level outers, holes inside islands inside
 * holes, etc.).
 *
 * `visit(holeRing)` returns `true` to SKIP descending into the
 * hole's nested geometry (= its same-layer islands and their
 * own holes). Returns `false` to descend.
 *
 * Used by `fillEnclosedHoles` to fill top-level fully-covered
 * holes without wasting work on their nested geometry (which is
 * absorbed by the eventual polygon union), while still descending
 * into UN-filled holes to consider their islands' holes.
 */
export function walkPolygonHoles(
  mp: MultiPolygon,
  visit: (holeRing: Ring) => boolean,
): void {
  if (mp.length === 0) return;
  const c = new ClipperLib.Clipper();
  c.AddPaths(multiPolygonToClipperPaths(mp), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  );

  // BFS queue of "outer" nodes whose direct hole-children we have
  // yet to process. The PolyTree root is virtual; its top-level
  // children are the outer rings of the polygon's components.
  const queue: PolyNode[] = [];
  for (const child of tree.Childs()) {
    if (!child.IsHole()) queue.push(child);
    // (Top-level holes shouldn't happen — root has no contour —
    //  but if Clipper hands us one, walk into it for safety.)
    else queue.push(child);
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const child of node.Childs()) {
      if (child.IsHole()) {
        const holeRing = clipperPathToRing(child.Contour());
        if (holeRing.length < 3) continue;
        const skipNested = visit(holeRing);
        if (!skipNested) {
          // Descend: queue islands inside this hole so their own
          // holes get visited next.
          for (const island of child.Childs()) {
            if (!island.IsHole()) queue.push(island);
          }
        }
      } else {
        // A non-hole child of a non-hole — unusual under a single-
        // polygon ctUnion, but be defensive.
        queue.push(child);
      }
    }
  }
}

/**
 * Strip every inner hole from a `MultiPolygon`, leaving only the
 * outer rings of each connected component. Used to "fill in" any
 * voids inside a multi-polygon — e.g., the user's partial-fill
 * algorithm inflates non-covered slivers and then needs the
 * resulting region as a solid (not a polygon-with-holes) to act as
 * the danger-zone mask.
 */
export function stripPolygonHoles(mp: MultiPolygon): MultiPolygon {
  return multiPolygonComponents(mp).map(c => c.outer);
}

/**
 * Inverse of `multiPolygonComponents`: reassemble components back
 * into a flat ring list.
 */
export function componentsToMultiPolygon(components: PolygonComponent[]): MultiPolygon {
  const out: MultiPolygon = [];
  for (const c of components) {
    out.push(c.outer);
    for (const h of c.holes) out.push(h.ring);
  }
  return out;
}

/**
 * Canonicalize: union the input with itself to produce a clean
 * polygon (deduplicated rings, no self-intersections, even-odd
 * topology). Used to repair source SVGs that have overlapping or
 * self-intersecting paths before any other op.
 */
export function multiPolygonCanonicalize(mp: MultiPolygon): MultiPolygon {
  if (mp.length === 0) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(multiPolygonToClipperPaths(mp), ClipperLib.PolyType.ptSubject, true);
  const solution: { X: number; Y: number }[][] = [];
  c.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  );
  return clipperPathsToMultiPolygon(solution);
}
