import type { Layer, VectorData } from '@/types';
import { parseViewBox, rasterizeLayerToBinaryMask } from './svgLayers';
import { findEnclosedHoles } from './morphology';
import { maskToSvgPath } from './maskToPath';
import { distanceTransform } from './distanceTransform';
import { constrainedDistanceTransform } from './constrainedDistance';
import { dilateMask } from './maskOps';

const DEFAULT_RASTER_WIDTH = 1200;
/**
 * Minimum fraction of a hole's pixels that must be covered by later
 * layers for it to qualify as fillable. Set tight (99.5%) so we still
 * preserve genuinely-uncovered features like whiskers and eye sclera
 * gaps but tolerate the small (sub-1%) sub-pixel-boundary stragglers
 * that even a perfect rasterization can't avoid when adjacent layers
 * meet at a sub-pixel-aligned boundary.
 */
const HOLE_COVERAGE_THRESHOLD = 0.995;
// Dilate the region traced into a polygon by this many pixels so the appended
// path overshoots into the original mask (or covering later layers), bridging
// the inherent half-pixel inset from marching squares + Douglas-Peucker drift.
// Same-color overlap with the original is invisible; later-layer overlap is
// hidden by z-order.
const TRACE_OVERSHOOT_PX = 2;
/**
 * Clearance-bit margin to keep around earlier-layer (lower-z, drawn-
 * first) boundaries. Fill is excluded from a 0.3"-wide band centered
 * on every earlier-layer edge so the bit cutting the fill region has
 * room to clear earlier-layer wood without crashing into its edge.
 * 0.3" sits comfortably above the 1/4" clearance bit standard.
 */
const EARLIER_BOUNDARY_MARGIN_INCHES = 0.3;

interface FillResult {
  /** New layers array with the target layer's fragment extended (fill path appended). */
  layers: Layer[];
  /** Number of holes that were filled. */
  filledHoleCount: number;
  /** Total area filled in (sq inches). */
  filledAreaSqIn: number;
}

/**
 * Fill enclosed holes in `targetColorHex`'s pocket that are fully covered
 * by the union of later inlay layers. The resulting design is visually
 * identical (the holes were hidden by later layers anyway) but the V-bit
 * no longer has to trace the hole perimeter on either side, saving time.
 */
export async function fillEnclosedHoles(
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
    // No later layers exist, so no hole can be "covered" by later inlays.
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = rasterWidth;
  const canvasH = Math.max(1, Math.round(rasterWidth * aspect));
  const pixelsPerInch = canvasW / designWidthInches;
  const n = canvasW * canvasH;

  // Per-layer rasterization for every layer (target, earlier, later).
  // Earlier-layer masks feed the boundary danger-zone check; later-
  // layer masks feed the original coverage check.
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
  // Union of all strictly-later layers' masks.
  const laterUnion = new Uint8Array(n);
  for (let i = targetIndex + 1; i < masksByIndex.length; i++) {
    const m = masksByIndex[i];
    for (let k = 0; k < n; k++) if (m[k]) laterUnion[k] = 1;
  }
  // Danger source for the boundary clearance check: earlier-layer
  // union (intact wood the bit must clear) ∪ background-visible
  // pixels (raw board the bit must clear). The bit cutting the fill
  // region needs ~0.3" clearance from the boundary of EITHER, so we
  // treat them uniformly.
  //
  // Background-visible is computed from `NOT (allLayers dilated by
  // 1 px)` rather than `NOT allLayers` directly. The dilation
  // absorbs the 1-pixel-wide stragglers that adjacent layers'
  // rasterizations leave at their shared boundaries — we already
  // tolerate them in the per-hole coverage threshold, but if we
  // didn't filter them out here they'd each seed their own ~36-px
  // exclusion ring in the constrained-DT pass and produce splotchy
  // donut-shaped holes inside the resulting fill.
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

  // Detect mostly-covered holes and accumulate them into a single
  // fill mask. A hole qualifies when its later-layer-covered fraction
  // is ≥ HOLE_COVERAGE_THRESHOLD (99.5%) — tolerates the sub-pixel
  // boundary stragglers that adjacent-layer rasterizations always
  // produce, while still preserving genuinely-uncovered features.
  const holes = findEnclosedHoles(targetMask, canvasW, canvasH);
  const fillMask = new Uint8Array(n);
  let filledHoleCount = 0, filledPixelCount = 0;
  for (const hole of holes) {
    let coveredPx = 0;
    for (const k of hole.pixels) {
      if (laterUnion[k]) coveredPx++;
    }
    if (coveredPx / hole.pixels.length < HOLE_COVERAGE_THRESHOLD) continue;
    for (const k of hole.pixels) fillMask[k] = 1;
    filledHoleCount++;
    filledPixelCount += hole.pixels.length;
  }
  if (filledHoleCount === 0) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
  }

  // Subtract the danger zone from the fill so we don't extend layer
  // K's pocket to within a clearance bit's diameter of any boundary
  // the bit must clear. Constrained distance transform with
  // `target.mask` as a barrier ensures each NOT-target connected
  // component is evaluated independently — danger sources on the
  // opposite side of target.mask from a candidate fill pixel are
  // physically unreachable to the bit at that position, so they
  // don't pull the candidate into the danger zone.
  const marginPx = EARLIER_BOUNDARY_MARGIN_INCHES * pixelsPerInch;
  if (marginPx > 0) {
    // Seeds: only danger-source pixels OUTSIDE the target. Pixels
    // inside target are part of the bit's playing field — they're
    // cut as part of the layer's pocket, not adjacent obstacles.
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

  // Trace ONLY the fill region and APPEND it to the existing layer
  // fragment. Don't trace the union and replace the fragment — that
  // round-trips the entire layer through pixel space, and the resulting
  // marching-squares + Douglas-Peucker polygon drifts the original Bezier
  // boundaries by ~1 px in places, eating into thin background gaps
  // between adjacent regions on the same layer.
  //
  // Dilate fillMask by TRACE_OVERSHOOT_PX before tracing so the appended
  // polygon overshoots into the original layer mask, bridging the half-
  // pixel inset of marching squares and any DP drift. Holes are bounded
  // by targetMask topologically (a "hole" is by definition not connected
  // to the canvas edge through non-targetMask), so dilation lands strictly
  // inside targetMask — no risk of painting outside the layer.
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

  return {
    layers: newLayers,
    filledHoleCount,
    filledAreaSqIn: filledPixelCount / (pixelsPerInch * pixelsPerInch),
  };
}
