import { computeBoundary, morphologicalOpening } from './morphology';

export interface MachiningTimeResult {
  /** Square inches the clearance bit can clear (morphological opening of the mask). */
  clearanceAreaSqIn: number;
  /** Square inches the clearance bit cannot reach — the V-bit handles this. */
  vbitAreaSqIn: number;
  /** Length of the cut perimeter, in inches (V-bit traces this at its feed rate). */
  perimeterIn: number;

  clearanceTimeMin: number;
  vbitAreaTimeMin: number;
  vbitPerimeterTimeMin: number;
  totalTimeMin: number;
}

/**
 * Estimate machining time for one carved area (e.g. one layer's pocket).
 *
 * Model:
 *   - A clearance bit of diameter `clearanceDiameterInches` clears the bulk;
 *     it can carve any pixel within a disc of its radius that fits inside the
 *     mask. That set is the morphological opening of the mask.
 *   - The V-bit handles the remaining strip (mask − opening) and traces the
 *     full perimeter once for clean edges.
 *
 *   clearanceTime = clearanceArea × depth / clearanceMRR
 *   vbitAreaTime  = (mask − clearanceArea) × depth / vbitMRR
 *   perimeterTime = perimeter / vbitFeed
 *
 * `dist1` is the EDT of the mask (distance from each mask pixel to the
 * nearest non-mask pixel) — `analyzeMask` already produces this for every
 * layer's pocket, so we accept it pre-computed instead of paying for another
 * EDT pass here.
 */
export function machiningTimeForMask(
  mask: Uint8Array,
  dist1: Float32Array,
  canvasW: number,
  canvasH: number,
  pixelsPerInch: number,
  inlayDepthInches: number,
  clearanceDiameterInches: number,
  clearanceMRR: number,
  vbitMRR: number,
  vbitFeed: number,
): MachiningTimeResult {
  const n = canvasW * canvasH;
  const clearanceRadiusPx = (clearanceDiameterInches * pixelsPerInch) / 2;
  const ppiSq = pixelsPerInch * pixelsPerInch;

  // What the clearance bit can clear inside the mask.
  const opened = morphologicalOpening(mask, dist1, clearanceRadiusPx, canvasW, canvasH);

  let clearancePixels = 0, totalMaskPixels = 0;
  for (let k = 0; k < n; k++) {
    if (mask[k]) totalMaskPixels++;
    if (opened[k]) clearancePixels++;
  }
  const vbitPixels = totalMaskPixels - clearancePixels;

  const clearanceAreaSqIn = clearancePixels / ppiSq;
  const vbitAreaSqIn      = vbitPixels      / ppiSq;

  // Perimeter — pixel boundary length divided by ppi gives an approximate
  // perimeter in inches. The estimate is fine for time approximation since
  // each boundary pixel ≈ one linear pixel of perimeter at this resolution.
  const boundary = computeBoundary(mask, canvasW, canvasH);
  let boundaryPixels = 0;
  for (let k = 0; k < n; k++) if (boundary[k]) boundaryPixels++;
  const perimeterIn = boundaryPixels / pixelsPerInch;

  // Time components, all in minutes.
  const clearanceTimeMin     = clearanceMRR > 0 ? clearanceAreaSqIn * inlayDepthInches / clearanceMRR : 0;
  const vbitAreaTimeMin      = vbitMRR      > 0 ? vbitAreaSqIn      * inlayDepthInches / vbitMRR      : 0;
  const vbitPerimeterTimeMin = vbitFeed     > 0 ? perimeterIn / vbitFeed                              : 0;
  const totalTimeMin = clearanceTimeMin + vbitAreaTimeMin + vbitPerimeterTimeMin;

  return {
    clearanceAreaSqIn,
    vbitAreaSqIn,
    perimeterIn,
    clearanceTimeMin,
    vbitAreaTimeMin,
    vbitPerimeterTimeMin,
    totalTimeMin,
  };
}

/**
 * Build the (clearance × V-bit) total-time comparison matrix for one design.
 * Reuses each layer's already-computed pocket mask and `dist1` EDT, so the
 * only extra cost vs. computing one combination is one morphological-opening
 * EDT per (layer × clearance bit) — the V-bit dimension is just arithmetic.
 *
 * Per cell: total = sum over layers of `(clearanceTime + vbitAreaTime + perimeterTime) × 2`,
 * where `× 2` accounts for both the pocket cut and the plug cut (modeled
 * identically to the pocket — same shape, same depth).
 */
export function buildMachiningTimeMatrix(params: {
  layers: { mask: Uint8Array; dist1: Float32Array }[];
  canvasW: number;
  canvasH: number;
  pixelsPerInch: number;
  inlayDepthInches: number;
  clearanceBits: { diameterInches: number; mrr: number }[];
  vbits: { angleDegrees: number; mrr: number; feed: number; feasible: boolean }[];
}): import('@/types').MachiningTimeMatrix {
  const { layers, canvasW, canvasH, pixelsPerInch, inlayDepthInches,
          clearanceBits, vbits } = params;
  const ppiSq = pixelsPerInch * pixelsPerInch;

  // Per-layer perimeter — independent of bit choice, so compute once.
  const perimeters = layers.map(l => {
    const boundary = computeBoundary(l.mask, canvasW, canvasH);
    let count = 0;
    for (let k = 0; k < boundary.length; k++) if (boundary[k]) count++;
    return count / pixelsPerInch;
  });

  // Per-layer × per-clearance bit: opened (clearance) area and remaining V-bit area.
  type Areas = { clearanceAreaSqIn: number; vbitAreaSqIn: number };
  const areasPerLayerPerClearance: Areas[][] = layers.map(layer =>
    clearanceBits.map(c => {
      const radiusPx = (c.diameterInches * pixelsPerInch) / 2;
      const opened = morphologicalOpening(layer.mask, layer.dist1, radiusPx, canvasW, canvasH);
      let openedPx = 0, totalPx = 0;
      for (let k = 0; k < opened.length; k++) {
        if (opened[k]) openedPx++;
        if (layer.mask[k]) totalPx++;
      }
      return {
        clearanceAreaSqIn: openedPx / ppiSq,
        vbitAreaSqIn: (totalPx - openedPx) / ppiSq,
      };
    })
  );

  // Combine: total time per (clearance, V-bit) cell. Infeasible V-bits
  // yield NaN — the design wouldn't actually be cuttable with that angle,
  // so reporting a number would be misleading.
  const times: number[][] = clearanceBits.map((c, ci) =>
    vbits.map(v => {
      if (!v.feasible) return NaN;
      let total = 0;
      for (let li = 0; li < layers.length; li++) {
        const a = areasPerLayerPerClearance[li][ci];
        const tClear     = c.mrr  > 0 ? a.clearanceAreaSqIn * inlayDepthInches / c.mrr : 0;
        const tVbitArea  = v.mrr  > 0 ? a.vbitAreaSqIn      * inlayDepthInches / v.mrr : 0;
        const tPerim     = v.feed > 0 ? perimeters[li]                              / v.feed : 0;
        total += (tClear + tVbitArea + tPerim) * 2; // pocket + plug
      }
      return total;
    })
  );

  return { clearanceBits, vbits, times };
}

/** Format a duration in minutes as "Hh MMm" or "MM min" depending on size. */
export function formatMinutes(minutes: number): string {
  if (!isFinite(minutes) || minutes <= 0) return '0 min';
  if (minutes < 1) return `${(minutes * 60).toFixed(0)} s`;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
