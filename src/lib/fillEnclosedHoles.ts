import type { Layer, VectorData } from '@/types';
import {
  multiPolygonCanonicalize,
  multiPolygonDifference,
  multiPolygonOffset,
  multiPolygonUnion,
  multiPolygonUnionAll,
  stripPolygonHoles,
  walkPolygonHoles,
} from './clipperOps';
import {
  multiPolygonArea,
  multiPolygonIsEmpty,
  pointInMultiPolygon,
  type MultiPolygon,
  type Point,
  type Ring,
} from './polygon';
import {
  svgFragmentToMultiPolygon,
  multiPolygonToSvgFragment,
} from './polygonParser';

/**
 * Bit clearance margin used by the partial-fill path. The grown-NCU
 * (= non-covered-region union, inflated by this much) is the
 * "danger zone" the simplified hole H′ must enclose so the V-bit
 * stays at least this far from any actually-uncovered sliver.
 */
const HOLE_MARGIN_INCHES = 0.13;

interface FillResult {
  /** New layers array with the target layer's fragment replaced by
   *  the post-fill polygon. */
  layers: Layer[];
  /** Number of holes that were fully absorbed by the union. */
  filledHoleCount: number;
  /** Total area filled in (sq inches) by full-hole absorption. */
  filledAreaSqIn: number;
  /** Number of holes whose boundaries were simplified (partial fill). */
  partiallyFilledHoleCount: number;
  /** Total area absorbed (sq inches) by partial-fill simplification. */
  partiallyFilledAreaSqIn: number;
}

/**
 * Replace the target hole `holeRing` with a simplified hole H′
 * whose boundary hugs the inflated danger zone (`grownNCU`) and
 * uses straight chords across the safe stretches.
 *
 * Per-edge classification: the edge `(holeRing[i], holeRing[i+1])`
 * is INSIDE iff its midpoint lies inside `grownNCU`. A vertex is
 * KEPT iff at least one adjacent edge is INSIDE; SKIPPED iff both
 * adjacent edges are OUTSIDE (= middle of a safe run, collapsed
 * into a chord).
 *
 * Degenerate cases (no boundary crossings between H and grown-NCU):
 *   - all edges OUTSIDE  → grown-NCU is fully internal to H. Return
 *     grown-NCU's outer rings as the new holes.
 *   - all edges INSIDE   → H is entirely inside the danger zone.
 *     No simplification possible; return [holeRing] unchanged.
 *
 * The midpoint test mis-classifies edges that genuinely cross
 * grown-NCU's boundary mid-edge, but the polygon parser flattens
 * to ≤0.05 chord error so edges are short and crossings rare. The
 * final `multiPolygonCanonicalize` repairs any self-intersection
 * the kept-vertex polyline might produce.
 */
function partiallyFillHoleRing(
  holeRing: Ring,
  grownNCU: MultiPolygon,
): MultiPolygon {
  if (multiPolygonIsEmpty(grownNCU)) return [holeRing];
  const n = holeRing.length;
  if (n < 3) return [holeRing];

  const edgeInside: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = holeRing[i];
    const b = holeRing[(i + 1) % n];
    const mid: Point = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    edgeInside[i] = pointInMultiPolygon(mid, grownNCU);
  }

  let anyInside  = false;
  let anyOutside = false;
  for (const e of edgeInside) {
    if (e) anyInside = true; else anyOutside = true;
  }
  if (!anyInside)  return grownNCU;          // grown-NCU fully internal to H
  if (!anyOutside) return [holeRing];        // H fully inside grown-NCU

  const kept: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    if (edgeInside[prev] || edgeInside[i]) kept.push(holeRing[i]);
  }
  if (kept.length < 3) return [holeRing];

  const canonical = multiPolygonCanonicalize([kept]);
  return multiPolygonIsEmpty(canonical) ? [holeRing] : canonical;
}

/**
 * Fill enclosed holes in `targetColorHex`'s polygon and partially
 * simplify the boundaries of holes that are only fractionally
 * covered. Both modes shrink the V-bit's traversal — full fills
 * eliminate the hole entirely; partial fills replace the safe
 * portions of a hole's perimeter with straight chords, leaving
 * the danger arcs (within 0.13" of an actually-uncovered sliver)
 * intact.
 *
 * Polygon-native, BFS-through-PolyTree implementation:
 *   1. Parse target + every later layer's svgFragment to a
 *      MultiPolygon (Bezier-flattened).
 *   2. Build `allLayersUnion = target ∪ laterUnion`. Including
 *      `target` here is the key: same-layer islands sitting inside
 *      a hole are part of the layer's mass and shouldn't count as
 *      "uncovered" when judging hole coverage.
 *   3. BFS-walk the target's PolyTree. For each hole `H`:
 *      - If `[H_ring] ⊆ allLayersUnion` (= no uncovered area
 *        inside H), full-fill: stage `H_ring` for union into the
 *        target. Skip descending — nested geometry is absorbed.
 *      - Else, partial-fill: grow the uncovered region by the hole
 *        margin, strip its holes, run `partiallyFillHoleRing` to
 *        compute H′, and stage `[H_ring] − H′` for union into the
 *        target. Still descend so nested holes can be checked too.
 *   4. Final union: target ∪ (full-fill rings) ∪ (partial-fill
 *      mass-added). The result has H replaced by H′ for partial
 *      fills, with H′'s rings re-emerging as holes of the resulting
 *      polygon under even-odd.
 */
export async function fillEnclosedHoles(
  vector: VectorData,
  targetColorHex: string,
  designWidthInches: number,
  colorOrder?: string[],
  // Kept for signature compatibility with the optimizer call site
  // and any tests that pass it. The polygon implementation has no
  // raster step. Underscore prefix silences unused-arg lint.
  _rasterWidth?: number,
): Promise<FillResult> {
  void _rasterWidth;
  const order = colorOrder ?? vector.detectedColors;
  const targetIndex = order.indexOf(targetColorHex);
  if (targetIndex < 0) {
    throw new Error(`Target color ${targetColorHex} not found in layer order.`);
  }
  if (targetIndex === order.length - 1) {
    return {
      layers: vector.layers,
      filledHoleCount: 0,
      filledAreaSqIn: 0,
      partiallyFilledHoleCount: 0,
      partiallyFilledAreaSqIn: 0,
    };
  }

  // sq inches per (svg-user-unit)². Polygon coords come straight
  // from the source SVG viewBox.
  const inchesPerUnit = designWidthInches / vector.naturalWidth;
  const sqInchesPerSqUnit = inchesPerUnit * inchesPerUnit;
  const holeMarginUnits = HOLE_MARGIN_INCHES / inchesPerUnit;

  const targetLayer = vector.layers.find(l => l.colorHex === targetColorHex);
  if (!targetLayer) {
    return {
      layers: vector.layers,
      filledHoleCount: 0,
      filledAreaSqIn: 0,
      partiallyFilledHoleCount: 0,
      partiallyFilledAreaSqIn: 0,
    };
  }
  const target = svgFragmentToMultiPolygon(targetLayer.svgFragment);
  if (multiPolygonIsEmpty(target)) {
    return {
      layers: vector.layers,
      filledHoleCount: 0,
      filledAreaSqIn: 0,
      partiallyFilledHoleCount: 0,
      partiallyFilledAreaSqIn: 0,
    };
  }

  const laterParts: MultiPolygon[] = [];
  for (let i = targetIndex + 1; i < order.length; i++) {
    const layer = vector.layers.find(l => l.colorHex === order[i]);
    if (!layer) continue;
    const mp = svgFragmentToMultiPolygon(layer.svgFragment);
    if (!multiPolygonIsEmpty(mp)) laterParts.push(mp);
  }
  const laterUnion = multiPolygonUnionAll(laterParts);
  const allLayersUnion = multiPolygonUnion(target, laterUnion);

  let filledHoleCount = 0;
  let filledAreaSqUnits = 0;
  let partiallyFilledHoleCount = 0;
  let partiallyFilledAreaSqUnits = 0;
  const fillRings: Ring[] = [];
  const partialMassAdded: MultiPolygon[] = [];

  // Diagnostic: dump per-hole decisions to the dev-mode browser
  // console. Statically inlined at build time so production bundles
  // are untouched. Lets the user reproduce a hole-fill regression
  // and share the log without us re-instrumenting on each iteration.
  const DEBUG_FILLS = process.env.NODE_ENV === 'development';
  let holeIndex = 0;

  walkPolygonHoles(target, holeRing => {
    const holeMP: MultiPolygon = [holeRing];
    const holeArea = multiPolygonArea(holeMP);
    const uncovered = multiPolygonDifference(holeMP, allLayersUnion);
    const uncoveredArea = multiPolygonArea(uncovered);
    const idx = holeIndex++;

    if (multiPolygonIsEmpty(uncovered)) {
      fillRings.push(holeRing);
      filledHoleCount++;
      filledAreaSqUnits += holeArea;
      if (DEBUG_FILLS) {
        console.log(
          `[fillHoles ${targetColorHex} h${idx}] FULL: holeArea=${holeArea.toFixed(2)} sq.u uncovered=0`,
        );
      }
      return true; // skip descending — full-fill absorbs nested geometry
    }

    // Partial-fill: grow uncovered, strip holes, simplify H.
    const grown = multiPolygonOffset(uncovered, holeMarginUnits, { joinType: 'round' });
    const grownNoHoles = stripPolygonHoles(grown);
    if (multiPolygonIsEmpty(grownNoHoles)) {
      if (DEBUG_FILLS) {
        console.log(
          `[fillHoles ${targetColorHex} h${idx}] PARTIAL-NOOP (grown collapsed): holeArea=${holeArea.toFixed(2)} sq.u uncovered=${uncoveredArea.toFixed(2)} sq.u`,
        );
      }
      return false;
    }
    const newHoleMP = partiallyFillHoleRing(holeRing, grownNoHoles);
    const massAdded = multiPolygonDifference(holeMP, newHoleMP);
    const massAddedArea = multiPolygonArea(massAdded);
    if (!multiPolygonIsEmpty(massAdded)) {
      partialMassAdded.push(massAdded);
      partiallyFilledHoleCount++;
      partiallyFilledAreaSqUnits += massAddedArea;
    }
    if (DEBUG_FILLS) {
      const grownArea = multiPolygonArea(grownNoHoles);
      console.log(
        `[fillHoles ${targetColorHex} h${idx}] PARTIAL: holeArea=${holeArea.toFixed(2)} sq.u uncovered=${uncoveredArea.toFixed(2)} sq.u grownNCU=${grownArea.toFixed(2)} sq.u massAdded=${massAddedArea.toFixed(2)} sq.u`,
      );
    }
    return false; // descend so nested holes can be checked too
  });

  if (filledHoleCount === 0 && partiallyFilledHoleCount === 0) {
    return {
      layers: vector.layers,
      filledHoleCount: 0,
      filledAreaSqIn: 0,
      partiallyFilledHoleCount: 0,
      partiallyFilledAreaSqIn: 0,
    };
  }

  let filledTarget = target;
  if (fillRings.length > 0) filledTarget = multiPolygonUnion(filledTarget, fillRings);
  if (partialMassAdded.length > 0) {
    const partialUnion = multiPolygonUnionAll(partialMassAdded);
    filledTarget = multiPolygonUnion(filledTarget, partialUnion);
  }

  const newFragment = multiPolygonToSvgFragment(filledTarget, targetColorHex);
  const newLayers = vector.layers.map(l =>
    l.colorHex === targetColorHex ? { ...l, svgFragment: newFragment } : l,
  );

  return {
    layers: newLayers,
    filledHoleCount,
    filledAreaSqIn: filledAreaSqUnits * sqInchesPerSqUnit,
    partiallyFilledHoleCount,
    partiallyFilledAreaSqIn: partiallyFilledAreaSqUnits * sqInchesPerSqUnit,
  };
}
