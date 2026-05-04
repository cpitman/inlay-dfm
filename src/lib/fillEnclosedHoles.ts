import type { Layer, VectorData } from '@/types';
import { layerToStandaloneSvg, parseViewBox } from './svgLayers';
import { findEnclosedHoles } from './morphology';
import { maskToSvgPath } from './maskToPath';
import { distanceTransform } from './distanceTransform';

const DEFAULT_RASTER_WIDTH = 1200;
// Mirror of dfmAnalysis's per-layer mask threshold (luma < 220 == "in layer").
const MASK_BRIGHTNESS_MAX = 220;
// Dilate the region traced into a polygon by this many pixels so the appended
// path overshoots into the original mask (or covering later layers), bridging
// the inherent half-pixel inset from marching squares + Douglas-Peucker drift.
// Same-color overlap with the original is invisible; later-layer overlap is
// hidden by z-order.
const TRACE_OVERSHOOT_PX = 2;

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

  // Per-layer rasterization for every layer at and after the target — we
  // need the target's mask and the later layers' masks (their union for
  // coverage check).
  const masksByIndex: Uint8Array[] = [];
  for (let i = targetIndex; i < order.length; i++) {
    const layer = vector.layers.find(l => l.colorHex === order[i]);
    if (!layer) { masksByIndex.push(new Uint8Array(n)); continue; }
    const oc = new OffscreenCanvas(canvasW, canvasH);
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const svg = layerToStandaloneSvg(layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, canvasW, canvasH); resolve(); };
        img.onerror = reject;
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    const { data } = ctx.getImageData(0, 0, canvasW, canvasH);
    const mask = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const r = data[k * 4], g = data[k * 4 + 1], b = data[k * 4 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < MASK_BRIGHTNESS_MAX) mask[k] = 1;
    }
    masksByIndex.push(mask);
  }

  const targetMask = masksByIndex[0];
  // Union of all strictly-later layers' masks.
  const laterUnion = new Uint8Array(n);
  for (let i = 1; i < masksByIndex.length; i++) {
    const m = masksByIndex[i];
    for (let k = 0; k < n; k++) if (m[k]) laterUnion[k] = 1;
  }

  // Detect covered holes and accumulate them into a single fill mask.
  const holes = findEnclosedHoles(targetMask, canvasW, canvasH);
  const fillMask = new Uint8Array(n);
  let filledHoleCount = 0, filledPixelCount = 0;
  for (const hole of holes) {
    let covered = true;
    for (const k of hole.pixels) {
      if (!laterUnion[k]) { covered = false; break; }
    }
    if (!covered) continue;
    for (const k of hole.pixels) fillMask[k] = 1;
    filledHoleCount++;
    filledPixelCount += hole.pixels.length;
  }
  if (filledHoleCount === 0) {
    return { layers: vector.layers, filledHoleCount: 0, filledAreaSqIn: 0 };
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
