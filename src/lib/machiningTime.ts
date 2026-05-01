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
  /**
   * Optional perimeter (in linear inches) for the V-bit feed-rate pass. When
   * omitted, the pixel-boundary length of `mask` is used. The plug operation
   * supplies its pocket's perimeter here, since the V-bit only traces the
   * plug's *shape* boundary — the outer edge of the stock isn't a precise
   * pass.
   */
  perimeterInOverride?: number,
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
  let perimeterIn: number;
  if (perimeterInOverride !== undefined) {
    perimeterIn = perimeterInOverride;
  } else {
    const boundary = computeBoundary(mask, canvasW, canvasH);
    let boundaryPixels = 0;
    for (let k = 0; k < n; k++) if (boundary[k]) boundaryPixels++;
    perimeterIn = boundaryPixels / pixelsPerInch;
  }

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
 * Reuses each layer's already-computed pocket and plug-carved masks plus
 * their `dist1` EDTs, so the only extra cost vs. computing one combination
 * is one morphological-opening EDT per (layer × clearance × side) — the
 * V-bit dimension is pure arithmetic.
 *
 * Per cell: sum over layers of `pocketTime + plugTime`, where each side is
 *   `clearanceArea·depth / clearanceMRR + vbitArea·depth / vbitMRR + perim / vbitFeed`
 * and `perim` is the pocket's perimeter (same for both — the plug's V-bit
 * pass traces the plug's *shape* boundary, not the outer stock edge).
 */
export function buildMachiningTimeMatrix(params: {
  layers: {
    pocketMask: Uint8Array;
    pocketDist1: Float32Array;
    plugCarvedMask: Uint8Array;
    plugDist1: Float32Array;
    pocketPerimeterIn: number;
  }[];
  canvasW: number;
  canvasH: number;
  pixelsPerInch: number;
  inlayDepthInches: number;
  clearanceBits: { diameterInches: number; mrr: number }[];
  vbits: import('@/types').MachiningTimeMatrix['vbits'];
}): import('@/types').MachiningTimeMatrix {
  const { layers, canvasW, canvasH, pixelsPerInch, inlayDepthInches,
          clearanceBits, vbits } = params;
  const ppiSq = pixelsPerInch * pixelsPerInch;

  type Areas = { clearanceAreaSqIn: number; vbitAreaSqIn: number };
  type AreasBoth = { pocket: Areas; plug: Areas };

  const computeAreas = (mask: Uint8Array, dist1: Float32Array, radiusPx: number): Areas => {
    const opened = morphologicalOpening(mask, dist1, radiusPx, canvasW, canvasH);
    let openedPx = 0, totalPx = 0;
    for (let k = 0; k < opened.length; k++) {
      if (opened[k]) openedPx++;
      if (mask[k]) totalPx++;
    }
    return {
      clearanceAreaSqIn: openedPx / ppiSq,
      vbitAreaSqIn: (totalPx - openedPx) / ppiSq,
    };
  };

  // For each layer × each clearance bit, compute pocket and plug areas.
  const areasPerLayerPerClearance: AreasBoth[][] = layers.map(layer =>
    clearanceBits.map(c => {
      const radiusPx = (c.diameterInches * pixelsPerInch) / 2;
      return {
        pocket: computeAreas(layer.pocketMask,     layer.pocketDist1, radiusPx),
        plug:   computeAreas(layer.plugCarvedMask, layer.plugDist1,   radiusPx),
      };
    })
  );

  // Combine areas + bit rates → total time per (clearance, V-bit) cell.
  // Infeasible V-bits yield NaN.
  const times: number[][] = clearanceBits.map((c, ci) =>
    vbits.map(v => {
      if (!v.feasible) return NaN;
      let total = 0;
      for (let li = 0; li < layers.length; li++) {
        const a = areasPerLayerPerClearance[li][ci];
        const perim = layers[li].pocketPerimeterIn;
        const sideTime = (areas: Areas): number => {
          const tClear    = c.mrr  > 0 ? areas.clearanceAreaSqIn * inlayDepthInches / c.mrr : 0;
          const tVbitArea = v.mrr  > 0 ? areas.vbitAreaSqIn      * inlayDepthInches / v.mrr : 0;
          const tPerim    = v.feed > 0 ? perim                                          / v.feed : 0;
          return tClear + tVbitArea + tPerim;
        };
        total += sideTime(a.pocket) + sideTime(a.plug);
      }
      return total;
    })
  );

  return { clearanceBits, vbits, times };
}

export interface FastestFeasibleCell {
  clearanceIdx: number;
  vbitIdx: number;
  totalTimeMinutes: number;
  clearanceDiameterInches: number;
  vbitAngleDegrees: number;
}

/**
 * Locate the fastest feasible (clearance, v-bit) combination in a matrix.
 * "Feasible" means the v-bit's column is feasible AND the cell time is
 * finite. Used by both BitMatrixTable (to highlight the green cell) and
 * RecommendedSetupCard (to surface the recommendation prominently).
 *
 * Returns null when no combination is feasible — in that case the design
 * needs widening before manufacturing is possible at any preset.
 */
export function findFastestFeasibleCell(
  matrix: import('@/types').MachiningTimeMatrix,
): FastestFeasibleCell | null {
  let best: FastestFeasibleCell | null = null;
  for (let ci = 0; ci < matrix.times.length; ci++) {
    for (let vi = 0; vi < matrix.times[ci].length; vi++) {
      if (!matrix.vbits[vi].feasible) continue;
      const t = matrix.times[ci][vi];
      if (!isFinite(t)) continue;
      if (best === null || t < best.totalTimeMinutes) {
        best = {
          clearanceIdx: ci,
          vbitIdx: vi,
          totalTimeMinutes: t,
          clearanceDiameterInches: matrix.clearanceBits[ci].diameterInches,
          vbitAngleDegrees: matrix.vbits[vi].angleDegrees,
        };
      }
    }
  }
  return best;
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
