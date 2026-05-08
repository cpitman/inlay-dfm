import type { Layer, VectorData } from '@/types';
import {
  multiPolygonComponents,
  componentsToMultiPolygon,
  multiPolygonUnionAll,
  multiPolygonDifference,
  type PolygonComponent,
} from './clipperOps';
import {
  multiPolygonArea,
  multiPolygonIsEmpty,
  type MultiPolygon,
} from './polygon';
import {
  svgFragmentToMultiPolygon,
  multiPolygonToSvgFragment,
} from './polygonParser';

interface RemoveResult {
  /** New layers array with the target's fragment replaced by the
   *  shrunken geometry. Untouched if nothing was removed. */
  layers: Layer[];
  removedComponentCount: number;
  removedAreaSqIn: number;
}

/**
 * Strip every connected component of the target layer's polygon
 * that is fully covered by the union of later inlay layers. The
 * component contributes zero visible pixels (the later layers paint
 * over every one of them) but still costs V-bit perimeter +
 * clearance time — removing it is pure cost reduction with no
 * visual effect.
 *
 * Polygon-native implementation:
 *   1. Parse target + every later layer to a MultiPolygon.
 *   2. Build `laterUnion`.
 *   3. Decompose target into components.
 *   4. For each component: keep iff `(component − laterUnion)` is
 *      non-empty (= the component has at least some uncovered area).
 *   5. Reassemble target.
 *
 * No coverage threshold, no laterUnion dilation, no danger zone —
 * polygon ops are exact, and earlier layers don't enter the
 * calculation (a region fully occluded by a HIGHER layer is safe to
 * remove regardless of lower-layer wood, per the manufacturing
 * model where the higher layer physically sits on top).
 */
export async function removeFullyOccludedRegions(
  vector: VectorData,
  targetColorHex: string,
  designWidthInches: number,
  colorOrder?: string[],
): Promise<RemoveResult> {
  const order = colorOrder ?? vector.detectedColors;
  const targetIndex = order.indexOf(targetColorHex);
  if (targetIndex < 0) {
    throw new Error(`Target color ${targetColorHex} not found in layer order.`);
  }
  if (targetIndex === order.length - 1) {
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
  }

  const inchesPerUnit = designWidthInches / vector.naturalWidth;
  const sqInchesPerSqUnit = inchesPerUnit * inchesPerUnit;

  const targetLayer = vector.layers.find(l => l.colorHex === targetColorHex);
  if (!targetLayer) {
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
  }
  const target = svgFragmentToMultiPolygon(targetLayer.svgFragment);
  if (multiPolygonIsEmpty(target)) {
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
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
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
  }

  const components = multiPolygonComponents(target);
  let removedComponentCount = 0;
  let removedAreaSqUnits = 0;
  const keptComponents: PolygonComponent[] = [];

  for (const c of components) {
    const componentMp: MultiPolygon = [c.outer, ...c.holes.map(h => h.ring)];
    const uncovered = multiPolygonDifference(componentMp, laterUnion);
    if (multiPolygonIsEmpty(uncovered)) {
      // Fully occluded — remove this component.
      removedComponentCount++;
      removedAreaSqUnits += multiPolygonArea(componentMp);
    } else {
      keptComponents.push(c);
    }
  }

  if (removedComponentCount === 0) {
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
  }

  const shrunkTarget = componentsToMultiPolygon(keptComponents);
  const newFragment = multiPolygonToSvgFragment(shrunkTarget, targetColorHex);

  const newLayers = vector.layers.map(l =>
    l.colorHex === targetColorHex ? { ...l, svgFragment: newFragment } : l,
  );

  return {
    layers: newLayers,
    removedComponentCount,
    removedAreaSqIn: removedAreaSqUnits * sqInchesPerSqUnit,
  };
}
