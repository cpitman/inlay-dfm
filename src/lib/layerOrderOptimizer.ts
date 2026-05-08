import type { VectorData } from '@/types';
import { svgFragmentToMultiPolygon } from './polygonParser';
import { multiPolygonIntersection, multiPolygonOffset } from './clipperOps';
import { multiPolygonArea, multiPolygonIsEmpty } from './polygon';

/**
 * Erosion radius applied to each layer polygon before pairwise
 * overlap testing. Strips shared-boundary near-touches from counting
 * as a constraint — only inlays whose carved regions ACTUALLY
 * overlap (not just kiss along an edge) get a precedence constraint.
 *
 * The bitmap predecessor used 1 px at 60 ppi = ~0.017"; this preserves
 * the same tolerance in inches.
 */
const OVERLAP_EROSION_INCHES = 1 / 60;

export interface PreAnalysisResult {
  /** Total carved area per inlay color, in². Used as the topological
   *  sort's tiebreaker (smallest goes first within constraints). */
  areaSqInByColor: Map<string, number>;
  /** Color-hex pairs (a, b) where a precedes b in `initialOrder` AND
   *  their inlays really overlap (more than just a shared boundary).
   *  The carving order MUST keep a before b. */
  overlapConstraints: Array<[string, string]>;
}

/**
 * Cheap pre-pass that collects everything `topoSortByArea` needs to
 * pick the carving order: per-layer surface area + which pairs of
 * layers overlap in the user's artwork.
 *
 * Polygon-native: parses each layer's `svgFragment` directly, computes
 * area via `multiPolygonArea`, and tests overlap via Clipper boolean
 * intersection on inward-eroded copies. Faster and more accurate than
 * the prior 60-ppi rasterize + pixel-AND path — no anti-aliasing
 * artifacts to erode away, no per-pixel sweeps over a half-MB mask.
 */
export async function preAnalyzeLayerOrder(
  vector: VectorData,
  designWidthInches: number,
  initialOrder: string[],
): Promise<PreAnalysisResult> {
  const inchesPerUnit = designWidthInches / vector.naturalWidth;
  const sqInchesPerSqUnit = inchesPerUnit * inchesPerUnit;
  const erosionUnits = OVERLAP_EROSION_INCHES / inchesPerUnit;

  // Parse each layer in `initialOrder` to a MultiPolygon.
  const polygonByColor = new Map<string, ReturnType<typeof svgFragmentToMultiPolygon>>();
  for (const colorHex of initialOrder) {
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    if (!layer) {
      polygonByColor.set(colorHex, []);
      continue;
    }
    polygonByColor.set(colorHex, svgFragmentToMultiPolygon(layer.svgFragment));
  }

  // Per-color area in square inches.
  const areaSqInByColor = new Map<string, number>();
  for (const [colorHex, mp] of polygonByColor) {
    areaSqInByColor.set(colorHex, multiPolygonArea(mp) * sqInchesPerSqUnit);
  }

  // Pairwise overlap on inward-eroded polygons. The erosion strips
  // shared-boundary near-touches (≈ a 0.017" tolerance) so only inlays
  // with real interior overlap emit a precedence constraint. Iterate
  // in `initialOrder` so any constraint (a, b) means `a` precedes `b`.
  const erodedByColor = new Map<string, ReturnType<typeof svgFragmentToMultiPolygon>>();
  for (const [colorHex, mp] of polygonByColor) {
    if (multiPolygonIsEmpty(mp) || erosionUnits <= 0) {
      erodedByColor.set(colorHex, mp);
    } else {
      erodedByColor.set(colorHex, multiPolygonOffset(mp, -erosionUnits, { joinType: 'round' }));
    }
  }
  const overlapConstraints: Array<[string, string]> = [];
  for (let i = 0; i < initialOrder.length; i++) {
    const a = initialOrder[i];
    const eA = erodedByColor.get(a);
    if (!eA || multiPolygonIsEmpty(eA)) continue;
    for (let j = i + 1; j < initialOrder.length; j++) {
      const b = initialOrder[j];
      const eB = erodedByColor.get(b);
      if (!eB || multiPolygonIsEmpty(eB)) continue;
      const inter = multiPolygonIntersection(eA, eB);
      if (!multiPolygonIsEmpty(inter)) overlapConstraints.push([a, b]);
    }
  }

  return { areaSqInByColor, overlapConstraints };
}

/**
 * Pick a carving order: smallest-area-first where the topology
 * allows, but always preserve the user's relative order between
 * pairs that overlap (their stack determines which inlay sits on
 * top of which after carving). Kahn's algorithm with a smallest-
 * area-first picker; ties broken by user's original index.
 *
 * Throws when `overlapConstraints` describes a cycle — which can't
 * happen in practice since constraints are derived from the user's
 * (linear) layer stack, but defensive for callers that pass arbitrary
 * input.
 */
export function topoSortByArea(
  initialOrder: readonly string[],
  areaSqInByColor: Map<string, number>,
  overlapConstraints: ReadonlyArray<readonly [string, string]>,
): string[] {
  const indexOf = new Map<string, number>();
  initialOrder.forEach((c, i) => indexOf.set(c, i));

  const successors = new Map<string, string[]>();
  const inDegree   = new Map<string, number>();
  for (const c of initialOrder) {
    successors.set(c, []);
    inDegree.set(c, 0);
  }
  for (const [a, b] of overlapConstraints) {
    if (!indexOf.has(a) || !indexOf.has(b)) continue;
    successors.get(a)!.push(b);
    inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
  }

  const pool: string[] = [];
  for (const c of initialOrder) if (inDegree.get(c) === 0) pool.push(c);

  const out: string[] = [];
  while (pool.length > 0) {
    // Pick smallest area; ties → earliest in original order.
    let bestIdx = 0;
    for (let i = 1; i < pool.length; i++) {
      const ai = areaSqInByColor.get(pool[i])    ?? Infinity;
      const ab = areaSqInByColor.get(pool[bestIdx]) ?? Infinity;
      if (ai < ab || (ai === ab && (indexOf.get(pool[i]) ?? 0) < (indexOf.get(pool[bestIdx]) ?? 0))) {
        bestIdx = i;
      }
    }
    const next = pool.splice(bestIdx, 1)[0];
    out.push(next);
    for (const succ of successors.get(next) ?? []) {
      const d = (inDegree.get(succ) ?? 0) - 1;
      inDegree.set(succ, d);
      if (d === 0) pool.push(succ);
    }
  }

  if (out.length !== initialOrder.length) {
    throw new Error('topoSortByArea: cycle in overlap constraints');
  }
  return out;
}
