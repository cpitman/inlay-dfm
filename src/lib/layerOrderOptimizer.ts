import type { VectorData } from '@/types';
import { layerToStandaloneSvg, renderSvgToCanvas } from './svgLayers';
import { erodeMask } from './maskOps';

/**
 * Resolution used by `preAnalyzeLayerOrder`. 60 ppi resolves features
 * down to ~0.017", which is plenty for "do these two layers overlap"
 * and per-layer area. Far cheaper than the production analysis (240
 * ppi) — for an 18" design that's 1080 px wide instead of 4320,
 * roughly 16× less compute.
 */
const PRE_ANALYSIS_PIXELS_PER_INCH = 60;

/**
 * Erosion radius applied to each layer mask before pairwise overlap
 * testing. Strips boundary anti-aliasing without removing real
 * interior overlap — at 60 ppi 1 px = ~0.017", a fair tolerance for
 * "shared boundary" vs "real overlap."
 */
const OVERLAP_EROSION_PX = 1;

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
 * layers overlap in the user's artwork. Runs at a low fixed
 * resolution (60 ppi) so it stays inexpensive even at the production
 * 240-ppi target for the full DFM analysis that comes later.
 */
export async function preAnalyzeLayerOrder(
  vector: VectorData,
  designWidthInches: number,
  initialOrder: string[],
): Promise<PreAnalysisResult> {
  const canvasW = Math.max(1, Math.ceil(designWidthInches * PRE_ANALYSIS_PIXELS_PER_INCH));
  const aspect  = vector.naturalHeight / vector.naturalWidth;
  const canvasH = Math.max(1, Math.round(canvasW * aspect));
  const ppiSq   = PRE_ANALYSIS_PIXELS_PER_INCH * PRE_ANALYSIS_PIXELS_PER_INCH;

  // Rasterize each layer in `initialOrder` to a binary mask. Same
  // pattern as dfmAnalysis: per-layer SVG → canvas → luma threshold.
  const masks = new Map<string, Uint8Array>();
  for (const colorHex of initialOrder) {
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    if (!layer) {
      masks.set(colorHex, new Uint8Array(canvasW * canvasH));
      continue;
    }
    const svg = layerToStandaloneSvg(layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight);
    const oc  = await renderSvgToCanvas(svg, canvasW, canvasH);
    const ctx = oc.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvasW, canvasH).data;
    const mask = new Uint8Array(canvasW * canvasH);
    for (let i = 0; i < canvasW * canvasH; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < 220) mask[i] = 1;
    }
    masks.set(colorHex, mask);
  }

  // Per-color area in square inches.
  const areaSqInByColor = new Map<string, number>();
  for (const [colorHex, mask] of masks) {
    let count = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
    areaSqInByColor.set(colorHex, count / ppiSq);
  }

  // Pairwise overlap (eroded). Iterate in `initialOrder` so any
  // emitted constraint (a, b) implies a precedes b in user's stack.
  const erodedByColor = new Map<string, Uint8Array>();
  for (const [colorHex, mask] of masks) {
    erodedByColor.set(colorHex, erodeMask(mask, canvasW, canvasH, OVERLAP_EROSION_PX));
  }
  const overlapConstraints: Array<[string, string]> = [];
  for (let i = 0; i < initialOrder.length; i++) {
    const a = initialOrder[i];
    const eA = erodedByColor.get(a);
    if (!eA) continue;
    for (let j = i + 1; j < initialOrder.length; j++) {
      const b = initialOrder[j];
      const eB = erodedByColor.get(b);
      if (!eB) continue;
      if (anyIntersection(eA, eB)) overlapConstraints.push([a, b]);
    }
  }

  return { areaSqInByColor, overlapConstraints };
}

function anyIntersection(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] && b[i]) return true;
  return false;
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
