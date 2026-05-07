import type { Layer, VectorData } from '@/types';
import {
  multiPolygonComponents,
  componentsToMultiPolygon,
  multiPolygonUnion,
  multiPolygonUnionAll,
  multiPolygonIntersection,
  multiPolygonDifference,
  type PolygonComponent,
} from './clipperOps';
import {
  multiPolygonArea,
  multiPolygonIsEmpty,
  type MultiPolygon,
} from './polygon';
import { convexHull } from './plugStock';
import {
  svgFragmentToMultiPolygon,
  multiPolygonToSvgFragment,
} from './polygonParser';

interface FillResult {
  /** New layers array with the target layer's fragment replaced. */
  layers: Layer[];
  /** Number of layer components that received a fill. */
  filledHoleCount: number;
  /** Total area filled in (sq inches). */
  filledAreaSqIn: number;
}

/**
 * Aggressive companion to `fillEnclosedHoles`: for each connected
 * component of the target layer's polygon, compute its convex hull
 * and fill any hull-added region that is covered by the union of
 * later inlay layers. Generalizes the simple closed-hole case to
 * *open concavities* — U-, C-shapes, etc. — where the original
 * layer has no enclosed hole at all but later layers still cover
 * the concavity.
 *
 * The visual result is unchanged (added pixels are by construction
 * covered by later layers and therefore invisible) but the layer's
 * carved geometry simplifies dramatically — a thin C-shape becomes
 * a near-disk where the inner concavity is covered, and the V-bit
 * no longer has to trace each concavity's perimeter.
 *
 * Polygon-native implementation:
 *   1. Parse target + every later layer to a MultiPolygon.
 *   2. Build `laterUnion`.
 *   3. Decompose target into per-component (outer + holes).
 *   4. For each component:
 *      - Build the component's polygon.
 *      - Compute the outer ring's convex hull.
 *      - `added = (hull − component) ∩ laterUnion` — the hull-added
 *        region restricted to where later layers cover it.
 *      - Merge component with `added`, decompose, and KEEP ONLY
 *        merged-components that overlap the original component.
 *        Disjoint fillable pieces (not adjacent to the original
 *        component) are dropped — they'd otherwise form a new
 *        isolated mass on the layer that the bit can't reach
 *        without crossing target.
 *   5. Reassemble target and emit the new svgFragment.
 *
 * No AA tolerance, no danger zone, no trace overshoot, no separate
 * "isolated region" filter — polygon ops produce valid topology
 * directly, and the merged-components check above handles isolation.
 */
export async function fillConvexHullCovered(
  vector: VectorData,
  targetColorHex: string,
  designWidthInches: number,
  colorOrder?: string[],
  _rasterWidth?: number,
): Promise<FillResult> {
  void _rasterWidth;
  const order = colorOrder ?? vector.detectedColors;
  const targetIndex = order.indexOf(targetColorHex);
  if (targetIndex < 0) {
    throw new Error(`Target color ${targetColorHex} not found in layer order.`);
  }
  if (targetIndex === order.length - 1) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  const inchesPerUnit = designWidthInches / vector.naturalWidth;
  const sqInchesPerSqUnit = inchesPerUnit * inchesPerUnit;

  const targetLayer = vector.layers.find(l => l.colorHex === targetColorHex);
  if (!targetLayer) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }
  const target = svgFragmentToMultiPolygon(targetLayer.svgFragment);
  if (multiPolygonIsEmpty(target)) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  const laterParts: MultiPolygon[] = [];
  for (let i = targetIndex + 1; i < order.length; i++) {
    const layer = vector.layers.find(l => l.colorHex === order[i]);
    if (!layer) continue;
    const mp = svgFragmentToMultiPolygon(layer.svgFragment);
    if (!multiPolygonIsEmpty(mp)) laterParts.push(mp);
  }
  const laterUnion = multiPolygonUnionAll(laterParts);
  if (multiPolygonIsEmpty(laterUnion)) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  const components = multiPolygonComponents(target);
  let filledHoleCount = 0;
  let filledAreaSqUnits = 0;

  const newComponents: PolygonComponent[] = [];
  for (const c of components) {
    const componentMp: MultiPolygon = [c.outer, ...c.holes.map(h => h.ring)];
    const componentArea = multiPolygonArea(componentMp);

    // Hull of the component's outer ring. Holes are concavities
    // that hull-fill is supposed to FILL, so we ignore them when
    // computing the hull.
    const hullPts = convexHull(c.outer);
    if (hullPts.length < 3) {
      newComponents.push(c);
      continue;
    }
    const hullMp: MultiPolygon = [hullPts];

    // Hull-added pixels = hull − component. Then restrict to
    // later-covered region.
    const added = multiPolygonDifference(hullMp, componentMp);
    const fillable = multiPolygonIntersection(added, laterUnion);

    if (multiPolygonIsEmpty(fillable)) {
      newComponents.push(c);
      continue;
    }

    // Merge component + fillable. Decompose. Keep ALL merged
    // components that overlap the original component (= are inside
    // its outer ring's interior). Disjoint fill pieces fully
    // outside c.outer are dropped (they'd create new isolated
    // mass on the layer).
    //
    // Multiple kept components are common: when `fillable` consists
    // of disconnected pieces inside c's holes (because the holes
    // contain uncovered material like layer-1 stroke islands that
    // separate the covered portion), the union with c's mass keeps
    // those fillable pieces as separate components inside c's
    // outer extent. They all belong to c — keeping only the first
    // (or only the largest) would silently drop the bulk of c's
    // post-fill geometry, including the original c's outer mass
    // when fillable inside holes happens to be discovered first.
    const merged = multiPolygonUnion(componentMp, fillable);
    const mergedComponents = multiPolygonComponents(merged);

    const kept: PolygonComponent[] = [];
    for (const mc of mergedComponents) {
      const mcMp: MultiPolygon = [mc.outer, ...mc.holes.map(h => h.ring)];
      const overlap = multiPolygonIntersection(mcMp, [c.outer]);
      if (multiPolygonArea(overlap) > 0) {
        kept.push(mc);
      }
    }

    if (kept.length === 0) {
      // No merged component overlaps c — every fillable piece was
      // disjoint from c. Keep c unchanged.
      newComponents.push(c);
      continue;
    }

    let keptArea = 0;
    for (const mc of kept) {
      keptArea += multiPolygonArea([mc.outer, ...mc.holes.map(h => h.ring)]);
      newComponents.push(mc);
    }
    const fillArea = keptArea - componentArea;
    if (fillArea > 0) {
      filledHoleCount++;
      filledAreaSqUnits += fillArea;
    }
  }

  if (filledHoleCount === 0) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  const filledTarget = componentsToMultiPolygon(newComponents);
  const newFragment = multiPolygonToSvgFragment(filledTarget, targetColorHex);

  const newLayers = vector.layers.map(l =>
    l.colorHex === targetColorHex ? { ...l, svgFragment: newFragment } : l,
  );

  return {
    layers: newLayers,
    filledHoleCount,
    filledAreaSqIn: filledAreaSqUnits * sqInchesPerSqUnit,
  };
}
