import type { Layer, VectorData } from '@/types';
import { distanceTransform } from './distanceTransform';
import { maskToSvgPath } from './maskToPath';
import { detectAlignmentRisk } from './alignmentRisk';
import { layerToStandaloneSvg, parseViewBox } from './svgLayers';

const DEFAULT_RASTER_WIDTH = 1200;
const ALIGNMENT_THRESHOLD_INCHES = 0.01;
// Extension amount past the original boundary, into the later inlay's region.
// Set well above the detection threshold so the modified polygon is robust to
// marching-squares + Douglas-Peucker simplification slop and to pixel-grid
// rounding when the analysis re-rasterizes the modified SVG.
const EXTENSION_INCHES = 0.05;
const SAFE_MARGIN_INCHES = 0.01;
// Dilate the appended extension polygon by this many pixels so it overshoots
// into the original target mask, bridging the half-pixel inset of marching
// squares and any DP drift. Constrained at use-site to stay inside
// (extensionMask | targetMask | laterUnion) so it can't bleed into open
// background or earlier-layer territory.
const TRACE_OVERSHOOT_PX = 2;

interface RasterContext {
  canvasW: number;
  canvasH: number;
  pixelsPerInch: number;
  masks: Uint8Array[];   // one mask per color in colorOrder, in that order
}

/**
 * Render each layer's standalone SVG to its own canvas and extract a brightness
 * mask. This produces the *physical* extent of each layer (where its plug
 * actually exists) — including any portion that has been extended under a
 * later layer by a previous run of this algorithm.
 *
 * Color-matching from a combined render would instead give the *visible*
 * extent (post z-order), which is wrong for any modified layer because the
 * extension is hidden under the upper layer in the combined image.
 */
async function rasterizePerLayerMasks(
  vector: VectorData,
  designWidthInches: number,
  colorOrder: string[],
  rasterWidth: number,
): Promise<RasterContext> {
  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = rasterWidth;
  const canvasH = Math.max(1, Math.round(rasterWidth * aspect));
  const pixelsPerInch = canvasW / designWidthInches;
  const n = canvasW * canvasH;

  const masks: Uint8Array[] = [];
  for (const colorHex of colorOrder) {
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    if (!layer) { masks.push(new Uint8Array(n)); continue; }

    const oc = new OffscreenCanvas(canvasW, canvasH);
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const layerSvg = layerToStandaloneSvg(
      layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight,
    );
    const blob = new Blob([layerSvg], { type: 'image/svg+xml' });
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
    for (let i = 0; i < n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < 220) mask[i] = 1;
    }
    masks.push(mask);
  }

  return { canvasW, canvasH, pixelsPerInch, masks };
}

interface ExtendResult {
  /** New layers array with the target layer's fragment replaced. */
  layers: Layer[];
  /** Number of pixels added to the target layer's mask. */
  addedPixelCount: number;
  /** Total area added in square inches. */
  addedAreaSqInches: number;
}

/**
 * Extend `targetColorHex`'s geometry to cover staged-alignment risk borders.
 *
 * Algorithm (see also user-facing notes):
 *   1. Rasterize all layers into masks (per-layer rendering, brightness threshold).
 *   2. Identify alignment-risk pixels on the target layer — same logic as
 *      analysis: within `ALIGNMENT_THRESHOLD_INCHES` of a LATER layer with
 *      background between them.
 *   3. Compute extension territory = pixels within (gap + extension) of any risk
 *      pixel, NOT already in the target layer, AND at least
 *      `SAFE_MARGIN_INCHES` away from any earlier layer.
 *   4. Trace just the extension region as an SVG path (marching squares +
 *      Douglas-Peucker) and append it to the target layer's existing
 *      fragment. The original geometry is preserved exactly.
 *
 * Layer order = `colorOrder`, defaults to `vector.detectedColors` (the same
 * order the user can re-arrange in the UI; pass that order to keep "earlier"
 * vs "later" consistent with the analysis view).
 */
export async function extendForRegistration(
  vector: VectorData,
  targetColorHex: string,
  designWidthInches: number,
  colorOrder?: string[],
  rasterWidth: number = DEFAULT_RASTER_WIDTH,
): Promise<ExtendResult> {
  const order = colorOrder ?? vector.detectedColors;
  const targetIndex = order.indexOf(targetColorHex);
  if (targetIndex < 0) {
    throw new Error(`Target color ${targetColorHex} not found in layer order.`);
  }
  if (targetIndex === order.length - 1) {
    throw new Error('Cannot extend the last (topmost) layer — there is no later layer to register against.');
  }

  // Per-layer rasterization so masks reflect each layer's physical extent
  // (matches dfmAnalysis post-refactor — physical extents are required after
  // any prior extension has placed a lower layer under an upper layer).
  const { canvasW, canvasH, pixelsPerInch, masks } = await rasterizePerLayerMasks(
    vector, designWidthInches, order, rasterWidth,
  );

  const n = canvasW * canvasH;
  const alignThresholdPx = ALIGNMENT_THRESHOLD_INCHES * pixelsPerInch;
  const extensionPx       = EXTENSION_INCHES        * pixelsPerInch;
  const safeMarginPx      = SAFE_MARGIN_INCHES      * pixelsPerInch;
  const i = targetIndex;
  const targetMask = masks[i];

  // -----------------------------------------------------------------------
  // 1. Alignment-risk pixels on the target layer. Uses the same shared
  //    detector as the analysis so risk pixels here match exactly what the
  //    user sees flagged in the UI.
  // -----------------------------------------------------------------------
  const riskMask = new Uint8Array(n);
  for (let j = i + 1; j < masks.length; j++) {
    const { riskMask: pairRisk } = detectAlignmentRisk(
      targetMask, masks[j], canvasW, canvasH, alignThresholdPx,
    );
    for (let k = 0; k < n; k++) if (pairRisk[k]) riskMask[k] = 1;
  }

  let riskCount = 0;
  for (let k = 0; k < n; k++) if (riskMask[k]) riskCount++;
  if (riskCount === 0) {
    return { layers: vector.layers, addedPixelCount: 0, addedAreaSqInches: 0 };
  }

  // -----------------------------------------------------------------------
  // 3. Extension candidates: dilate riskMask by (alignThreshold + extension)
  //    so the extension reaches across the gap and 0.01" into the later layer.
  // -----------------------------------------------------------------------
  const reachPx = alignThresholdPx + extensionPx;
  const seedsRisk = new Uint8Array(n);
  for (let k = 0; k < n; k++) seedsRisk[k] = riskMask[k] ? 0 : 1;
  const distToRisk = distanceTransform(seedsRisk, canvasW, canvasH);

  // -----------------------------------------------------------------------
  // 4. Earlier-layer safe-margin distance (skip if target is the first layer).
  // -----------------------------------------------------------------------
  let distToEarlier: Float32Array | null = null;
  if (i > 0) {
    const earlierUnion = new Uint8Array(n);
    for (let kk = 0; kk < i; kk++) {
      for (let k = 0; k < n; k++) if (masks[kk][k]) earlierUnion[k] = 1;
    }
    const seedsEarlier = new Uint8Array(n);
    for (let k = 0; k < n; k++) seedsEarlier[k] = earlierUnion[k] ? 0 : 1;
    distToEarlier = distanceTransform(seedsEarlier, canvasW, canvasH);
  }

  // -----------------------------------------------------------------------
  // 5. Apply constraints to produce the extension-only mask. Pixels in the
  //    original target layer are NOT included — we'll append the new region
  //    as a separate path rather than re-emitting the whole layer (see
  //    step 6 for the rationale).
  // -----------------------------------------------------------------------
  let added = 0;
  const extensionMask = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (targetMask[k]) continue;                                    // already covered
    if (distToRisk[k] >= reachPx) continue;                         // not near a risk site
    if (distToEarlier && distToEarlier[k] < safeMarginPx) continue; // too close to earlier
    extensionMask[k] = 1;
    added++;
  }

  if (added === 0) {
    return { layers: vector.layers, addedPixelCount: 0, addedAreaSqInches: 0 };
  }

  // -----------------------------------------------------------------------
  // 6. Trace ONLY the extension region and APPEND it to the existing
  //    layer fragment. We deliberately don't trace `original ∪ extension`
  //    and replace: that round-trips every Bezier in the layer through
  //    marching squares + Douglas-Peucker, which drifts unrelated edges
  //    by ~1 px and (e.g.) shrinks thin background gaps between adjacent
  //    regions. Appending a separate path leaves the original geometry
  //    byte-identical.
  //
  //    Dilate the extension by TRACE_OVERSHOOT_PX so the appended polygon
  //    overshoots inward (into targetMask) and into later layers — both
  //    invisible (same color / hidden by z-order). Constrain dilation to
  //    (extension | target | laterUnion) so the overshoot can't paint
  //    open background or earlier-layer territory.
  // -----------------------------------------------------------------------
  const laterUnion = new Uint8Array(n);
  for (let j = i + 1; j < masks.length; j++) {
    for (let k = 0; k < n; k++) if (masks[j][k]) laterUnion[k] = 1;
  }
  const overshootAllowed = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    overshootAllowed[k] = (extensionMask[k] || targetMask[k] || laterUnion[k]) ? 1 : 0;
  }
  const seedsExt = new Uint8Array(n);
  for (let k = 0; k < n; k++) seedsExt[k] = extensionMask[k] ? 0 : 1;
  const distFromExt = distanceTransform(seedsExt, canvasW, canvasH);
  const tracedMask = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (overshootAllowed[k] && distFromExt[k] <= TRACE_OVERSHOOT_PX) tracedMask[k] = 1;
  }

  const scaleX = vector.naturalWidth  / canvasW;
  const scaleY = vector.naturalHeight / canvasH;
  const vb = parseViewBox(vector.viewBox);
  const extensionPath = maskToSvgPath(tracedMask, canvasW, canvasH, {
    fill: targetColorHex,
    scaleX,
    scaleY,
    // viewBox origin is non-zero after the parse-time whitespace trim;
    // emit the new path in document coords so it aligns with the
    // unchanged layer fragments.
    offsetX: vb.x,
    offsetY: vb.y,
    simplifyEpsilonPx: 1,
    minAreaPx: 4,
  });

  const newLayers = vector.layers.map(l => {
    if (l.colorHex !== targetColorHex) return l;
    const sep = l.svgFragment ? '\n' : '';
    return { ...l, svgFragment: `${l.svgFragment}${sep}${extensionPath}` };
  });

  return {
    layers: newLayers,
    addedPixelCount: added,
    addedAreaSqInches: added / (pixelsPerInch * pixelsPerInch),
  };
}
