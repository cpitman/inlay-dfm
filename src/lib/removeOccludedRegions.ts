import type { Layer, VectorData } from '@/types';
import { parseViewBox, rasterizeLayerToBinaryMask } from './svgLayers';
import { findMaskComponents } from './maskComponents';
import { maskToSvgPath } from './maskToPath';
import { dilateMask } from './maskOps';

const DEFAULT_RASTER_WIDTH = 1200;
/**
 * Dilate the kept-component mask by this many pixels before re-
 * tracing. Bridges the half-pixel inset that marching squares +
 * Douglas-Peucker introduce against the original Bezier boundary —
 * without it, the replacement polygon ends up ~1 px inside the
 * original geometry and adjacent untouched layers see a thin
 * background-revealing gap (the "aliasing seam"). 2 px overshoot
 * lands inside the original layer's painted region (or inside a
 * later layer that hides it via z-order), so it's invisible.
 */
const TRACE_OVERSHOOT_PX = 2;
/**
 * Dilate `laterUnion` by this many pixels before the per-component
 * coverage check. Compensates for the cumulative trace-overshoot
 * expansion that earlier fill passes apply to the target — a single
 * `TRACE_OVERSHOOT_PX = 2` pass plus the marching-squares + DP
 * polygon round-trip can effectively expand a component by 4–6 px
 * past its original geometry, dropping a previously-100%-covered
 * component to ~88–93% covered. Empirically calibrated on Pika
 * (3 × TRACE_OVERSHOOT_PX); without it, components like the eye
 * outline rings and ear C-shapes that are clearly fully occluded
 * get rejected by the coverage check.
 *
 * Trade-off: a value too large could mark genuinely-visible
 * components as covered. The 0%-vs-100% gap on Pika is huge
 * (next-largest uncovered fraction is 0%), so this has plenty of
 * headroom for the kind of clipart this app targets.
 */
const COVERAGE_DILATION_PX = 3 * TRACE_OVERSHOOT_PX;
/**
 * Minimum fraction of a component's pixels that must be covered by
 * later layers for it to qualify as fully occluded. A handful of
 * sub-pixel boundary stragglers (the same ones `HOLE_COVERAGE_THRESHOLD`
 * in `fillEnclosedHoles.ts` tolerates) would otherwise pin the binary
 * check at 99.99% and reject removal, leaving visibly-occluded
 * components in the carved geometry. Set tighter than the 99.5% fill
 * threshold because removal is destructive — the cost of keeping an
 * almost-fully-covered component is a small wasted v-bit pass; the
 * cost of removing a partially-visible component is a visible defect.
 */
const COMPONENT_COVERAGE_THRESHOLD = 0.999;

interface RemoveResult {
  /** New layers array with the target's fragment replaced by the
   *  shrunken geometry. Untouched if nothing was removed. */
  layers: Layer[];
  removedComponentCount: number;
  removedAreaSqIn: number;
}

/**
 * Strip every connected component of the target layer's mask that is
 * fully covered by the union of later inlay layers. The component
 * contributes zero visible pixels (the later layers paint over every
 * one of them) but still costs V-bit perimeter + clearance time —
 * removing it is pure cost reduction with no visual effect.
 *
 * Mirror of `fillEnclosedHoles` in shape, but the OPPOSITE direction:
 * fill grows the layer mask where coverage hides empty pockets;
 * remove shrinks the layer mask where coverage hides filled regions.
 *
 * Designed to run AFTER any optimization that grows or merges
 * components (`fillEnclosedHoles`, `fillConvexHullCovered`, future
 * bridge passes). A grown component might newly satisfy "fully
 * covered by later layers" and get correctly dropped here.
 *
 * Replaces the layer's `svgFragment` (vs. `fillEnclosedHoles`'s
 * append) since we're SHRINKING geometry. Bezier fidelity is lost on
 * the kept regions — same tradeoff as the parser's CAM-friendly export.
 */
export async function removeFullyOccludedRegions(
  vector: VectorData,
  targetColorHex: string,
  designWidthInches: number,
  colorOrder?: string[],
  rasterWidth: number = DEFAULT_RASTER_WIDTH,
): Promise<RemoveResult> {
  const order = colorOrder ?? vector.detectedColors;
  const targetIndex = order.indexOf(targetColorHex);
  if (targetIndex < 0) {
    throw new Error(`Target color ${targetColorHex} not found in layer order.`);
  }
  if (targetIndex === order.length - 1) {
    // No later layers exist, so nothing can be "covered by later inlays".
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
  }

  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = rasterWidth;
  const canvasH = Math.max(1, Math.round(rasterWidth * aspect));
  const pixelsPerInch = canvasW / designWidthInches;
  const n = canvasW * canvasH;

  // Rasterize the target layer + every strictly-later layer (the
  // later-layer union feeds the per-component coverage check).
  // Earlier layers are intentionally NOT consulted: a region of
  // layer K that's fully occluded by some K+1..N layer is invisible
  // and unconditionally safe to remove, regardless of where layer
  // K-1's wood sits — the higher layer physically covers the spot.
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
  // Dilate laterUnion by `COVERAGE_DILATION_PX` so the coverage
  // check tolerates the cumulative trace-overshoot expansion that
  // earlier fill passes apply to the target. Without this, a
  // component that was 100% covered in the original geometry drops
  // to ~88% covered after its own hull-fill pushes it ~5 px into
  // earlier-layer territory. The dilation only affects WHICH
  // components qualify as "fully covered"; it doesn't change the
  // geometry that gets re-traced.
  const laterUnionDilated = dilateMask(laterUnion, canvasW, canvasH, COVERAGE_DILATION_PX);

  const { keepMask, removedComponentCount, removedPixelCount } =
    findFullyCoveredComponents(targetMask, laterUnionDilated, canvasW, canvasH);

  if (removedComponentCount === 0) {
    return { layers: vector.layers, removedComponentCount: 0, removedAreaSqIn: 0 };
  }

  // Dilate the kept mask outward by `TRACE_OVERSHOOT_PX` pixels so
  // the replacement polygon overshoots the original boundary slightly
  // — fixes the aliasing seam where the re-traced polygon would
  // otherwise sit ~1 px inside the original Bezier geometry. The
  // overshoot lands inside the original layer's painted region (or
  // inside a later layer's mask) and is hidden by z-order.
  const tracedMask = dilateMask(keepMask, canvasW, canvasH, TRACE_OVERSHOOT_PX);

  // Re-trace the kept mask. REPLACE (not append) the layer's
  // svgFragment — we're explicitly shrinking, and any retained
  // original Bezier paths would still draw the removed components.
  const scaleX = vector.naturalWidth  / canvasW;
  const scaleY = vector.naturalHeight / canvasH;
  const vb = parseViewBox(vector.viewBox);
  const newPath = maskToSvgPath(tracedMask, canvasW, canvasH, {
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
    return { ...l, svgFragment: newPath ?? '' };
  });

  return {
    layers: newLayers,
    removedComponentCount,
    removedAreaSqIn: removedPixelCount / (pixelsPerInch * pixelsPerInch),
  };
}

/**
 * Pure mask-only stage: identify connected components of `targetMask`
 * whose every pixel lies inside `laterUnion`, return a `keepMask`
 * containing only the components NOT fully covered. Exported for
 * unit testing — exercises the geometric decision without the
 * canvas/SVG pipeline.
 */
export function findFullyCoveredComponents(
  targetMask: Uint8Array,
  laterUnion: Uint8Array,
  w: number,
  h: number,
): { keepMask: Uint8Array; removedComponentCount: number; removedPixelCount: number } {
  const n = w * h;
  const keepMask = new Uint8Array(n);
  let removedComponentCount = 0;
  let removedPixelCount = 0;
  const components = findMaskComponents(targetMask, w, h);
  for (const comp of components) {
    let coveredPx = 0;
    for (const k of comp.pixels) {
      if (laterUnion[k]) coveredPx++;
    }
    const coveredFrac = comp.pixels.length > 0
      ? coveredPx / comp.pixels.length
      : 1;
    if (coveredFrac >= COMPONENT_COVERAGE_THRESHOLD) {
      removedComponentCount++;
      removedPixelCount += comp.pixels.length;
    } else {
      for (const k of comp.pixels) keepMask[k] = 1;
    }
  }
  return { keepMask, removedComponentCount, removedPixelCount };
}
