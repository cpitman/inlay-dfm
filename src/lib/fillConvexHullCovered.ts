import type { Layer, VectorData } from '@/types';
import { parseViewBox, rasterizeLayerToBinaryMask } from './svgLayers';
import { findMaskComponents } from './maskComponents';
import { computeBoundary } from './morphology';
import { convexHull, rasterizeConvexPolygon } from './plugStock';
import { maskToSvgPath } from './maskToPath';
import { distanceTransform } from './distanceTransform';
import { constrainedDistanceTransform } from './constrainedDistance';
import { dilateMask } from './maskOps';

const DEFAULT_RASTER_WIDTH = 1200;
const TRACE_OVERSHOOT_PX = 2;
/**
 * Clearance-bit margin to keep around earlier-layer (lower-z, drawn-
 * first) boundaries. Hull-fill pixels are excluded from a 0.3"-wide
 * band around every earlier-layer edge so the bit cutting the
 * extended pocket has clearance against earlier-layer wood. See
 * `fillEnclosedHoles.ts` for the full rationale.
 */
const EARLIER_BOUNDARY_MARGIN_INCHES = 0.3;
/**
 * Skip per-component fills smaller than this many covered hull-added
 * pixels. Tuned for a 120 ppi lite raster — at that scale, 16 pixels
 * is roughly a 0.13" × 0.13" square. Smaller fills aren't worth the
 * boundary complexity they introduce.
 */
const MIN_FILL_PIXELS = 16;

interface FillResult {
  /** New layers array with the target layer's fragment extended (fill path appended). */
  layers: Layer[];
  /** Number of layer components that received a fill. */
  filledHoleCount: number;
  /** Total area filled in (sq inches). */
  filledAreaSqIn: number;
}

/**
 * Aggressive companion to `fillEnclosedHoles`: for each connected
 * component of the target layer's mask, compute the convex hull and
 * fill any "added" pixels (hull − component) that are covered by the
 * union of later inlay layers. Generalizes the simple closed-hole
 * case `fillEnclosedHoles` handles to *open concavities* —
 * U-shapes, C-shapes, etc. — where the original layer has no
 * enclosed hole at all but later layers still cover the concavity.
 *
 * The visual result is unchanged (added pixels are by construction
 * covered by later layers and therefore invisible) but the layer's
 * carved geometry simplifies dramatically — a thin C-shape becomes
 * a near-disk, a stroke layer's outlines becomes a solid blob,
 * and the V-bit no longer has to trace each concavity's perimeter.
 *
 * Mirrors `fillEnclosedHoles` end-to-end: same rasterize-then-trace
 * shape, same per-color call, same APPEND-to-svgFragment policy
 * (preserves Bezier fidelity for the original geometry).
 */
export async function fillConvexHullCovered(
  vector: VectorData,
  targetColorHex: string,
  designWidthInches: number,
  colorOrder?: string[],
  rasterWidth: number = DEFAULT_RASTER_WIDTH,
): Promise<FillResult> {
  const order = colorOrder ?? vector.detectedColors;
  const targetIndex = order.indexOf(targetColorHex);
  if (targetIndex < 0) {
    throw new Error(`Target color ${targetColorHex} not found in layer order.`);
  }
  if (targetIndex === order.length - 1) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = rasterWidth;
  const canvasH = Math.max(1, Math.round(rasterWidth * aspect));
  const pixelsPerInch = canvasW / designWidthInches;
  const n = canvasW * canvasH;

  // Rasterize EVERY layer — earlier-layer masks feed the boundary
  // danger-zone check; later-layer masks feed the convex-hull
  // coverage check.
  const masksByIndex: Uint8Array[] = [];
  for (let i = 0; i < order.length; i++) {
    const layer = vector.layers.find(l => l.colorHex === order[i]);
    if (!layer) { masksByIndex.push(new Uint8Array(n)); continue; }
    const mask = await rasterizeLayerToBinaryMask(
      layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight,
      canvasW, canvasH,
    );
    masksByIndex.push(mask);
  }

  const targetMask = masksByIndex[targetIndex];
  const laterUnion = new Uint8Array(n);
  for (let i = targetIndex + 1; i < masksByIndex.length; i++) {
    const m = masksByIndex[i];
    for (let k = 0; k < n; k++) if (m[k]) laterUnion[k] = 1;
  }
  // Danger source: earlier-layer union (intact wood the bit must
  // clear) ∪ background-visible pixels (raw board the bit must
  // clear). Background-visible is computed against `dilateMask(
  // allLayers, 1)` rather than allLayers directly so 1-pixel
  // boundary stragglers between adjacent layers don't seed
  // separate danger zones. See `fillEnclosedHoles.ts` for the
  // longer rationale.
  const allLayers = new Uint8Array(n);
  for (const m of masksByIndex) {
    for (let k = 0; k < n; k++) if (m[k]) allLayers[k] = 1;
  }
  const allLayersDilated = dilateMask(allLayers, canvasW, canvasH, 1);

  const dangerSource = new Uint8Array(n);
  for (let i = 0; i < targetIndex; i++) {
    const m = masksByIndex[i];
    for (let k = 0; k < n; k++) if (m[k]) dangerSource[k] = 1;
  }
  for (let k = 0; k < n; k++) {
    if (!dangerSource[k] && !allLayersDilated[k]) dangerSource[k] = 1;
  }

  const fillMask = computeHullFillMask(targetMask, laterUnion, canvasW, canvasH);
  let filledPixelCount = popcount(fillMask);
  if (filledPixelCount === 0) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  // Subtract the danger zone from the fill so the hull extension
  // doesn't extend layer K's pocket to within a clearance bit's
  // diameter of any boundary the bit must clear. Constrained
  // distance transform with `target.mask` as a barrier evaluates
  // each NOT-target connected component independently — danger
  // sources on the opposite side of target.mask from a hull-fill
  // candidate are physically unreachable to the bit at that
  // position, so they don't pull the candidate into the danger zone.
  const marginPx = EARLIER_BOUNDARY_MARGIN_INCHES * pixelsPerInch;
  if (marginPx > 0) {
    const seeds = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (dangerSource[k] && !targetMask[k]) seeds[k] = 1;
    }
    const distFromDanger = constrainedDistanceTransform(seeds, targetMask, canvasW, canvasH);
    let dangerExcluded = 0;
    for (let k = 0; k < n; k++) {
      if (fillMask[k] && distFromDanger[k] <= marginPx) {
        fillMask[k] = 0;
        dangerExcluded++;
      }
    }
    filledPixelCount -= dangerExcluded;
    if (filledPixelCount <= 0) {
      return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
    }
  }

  // Drop fill pixels that form NEW isolated mask regions — fragments
  // disconnected from the original target geometry. Per-component
  // hull-fill produces hull(A) ∖ A pixels which are bordered by A
  // and merge with A on append; but laterUnion + danger-zone
  // filtering can split that fill into pieces, some of which lose
  // their adjacency to A. A floating fill blob in pixel space adds
  // a separate carved island the bit must reach without crossing
  // target.mask, so it's not a useful concavity extension. Find
  // components of (target ∪ fill) and remove any component whose
  // pixels are entirely fill.
  const combined = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (targetMask[k] || fillMask[k]) combined[k] = 1;
  }
  const combinedComponents = findMaskComponents(combined, canvasW, canvasH);
  let isolatedDropped = 0;
  for (const comp of combinedComponents) {
    let touchesTarget = false;
    for (const k of comp.pixels) {
      if (targetMask[k]) { touchesTarget = true; break; }
    }
    if (touchesTarget) continue;
    for (const k of comp.pixels) {
      if (fillMask[k]) { fillMask[k] = 0; isolatedDropped++; }
    }
  }
  filledPixelCount -= isolatedDropped;
  if (filledPixelCount <= 0) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  // Dilate by TRACE_OVERSHOOT_PX so the appended polygon overshoots into
  // the original mask (and into the covering later layers, which is
  // hidden by z-order). Bridges marching-squares half-pixel inset.
  const fillSeeds = new Uint8Array(n);
  for (let k = 0; k < n; k++) fillSeeds[k] = fillMask[k] ? 0 : 1;
  const distFromFill = distanceTransform(fillSeeds, canvasW, canvasH);
  const tracedMask = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (distFromFill[k] <= TRACE_OVERSHOOT_PX) tracedMask[k] = 1;
  }

  const scaleX = vector.naturalWidth  / canvasW;
  const scaleY = vector.naturalHeight / canvasH;
  const vb = parseViewBox(vector.viewBox);
  const fillPath = maskToSvgPath(tracedMask, canvasW, canvasH, {
    fill: targetColorHex,
    scaleX,
    scaleY,
    offsetX: vb.x,
    offsetY: vb.y,
    simplifyEpsilonPx: 1,
    minAreaPx: 4,
  });

  const newLayers = vector.layers.map(l => {
    if (l.colorHex !== targetColorHex) return l;
    const sep = l.svgFragment ? '\n' : '';
    return { ...l, svgFragment: `${l.svgFragment}${sep}${fillPath}` };
  });

  // Count how many components actually contributed — for the optimizer log.
  // Recomputing via `findMaskComponents` on `fillMask` returns one component
  // per filled patch, the equivalent number to `filledHoleCount` in
  // `fillEnclosedHoles`.
  const filledComponents = findMaskComponents(fillMask, canvasW, canvasH);

  return {
    layers: newLayers,
    filledHoleCount: filledComponents.length,
    filledAreaSqIn: filledPixelCount / (pixelsPerInch * pixelsPerInch),
  };
}

/**
 * Pure mask-only stage: given the target layer's mask and the union
 * of later layers' masks, returns a mask of pixels that should be
 * added to the target. Exported for unit testing — exercising this
 * without the canvas/SVG pipeline lets us assert the geometric
 * behavior cleanly.
 */
export function computeHullFillMask(
  targetMask: Uint8Array,
  laterUnion: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;
  const fillMask = new Uint8Array(n);

  const components = findMaskComponents(targetMask, w, h);
  for (const comp of components) {
    // Build a per-component mask so computeBoundary returns ONLY this
    // component's boundary, not interior boundaries between components.
    const compMask = new Uint8Array(n);
    for (const k of comp.pixels) compMask[k] = 1;

    const boundary = computeBoundary(compMask, w, h);
    const points: { x: number; y: number }[] = [];
    for (let k = 0; k < n; k++) {
      if (boundary[k]) {
        const x = k % w;
        points.push({ x, y: (k - x) / w });
      }
    }
    if (points.length < 3) continue;

    const hullVertices = convexHull(points);
    if (hullVertices.length < 3) continue;

    const hullMask = rasterizeConvexPolygon(hullVertices, w, h);

    // added = hullMask AND NOT componentMask. Filter by laterUnion.
    let coveredCount = 0;
    const compFill = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (hullMask[k] && !compMask[k] && laterUnion[k]) {
        compFill[k] = 1;
        coveredCount++;
      }
    }
    if (coveredCount < MIN_FILL_PIXELS) continue;

    for (let k = 0; k < n; k++) if (compFill[k]) fillMask[k] = 1;
  }

  return fillMask;
}

function popcount(mask: Uint8Array): number {
  let c = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k]) c++;
  return c;
}
