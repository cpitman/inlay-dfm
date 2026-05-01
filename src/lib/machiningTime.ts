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
 * Estimate machining time for one carved area (e.g. one layer's pocket)
 * using a single clearance bit + v-bit. Used by per-wood machine-time
 * displays on Step 2 / Step 3 — Step 4's matrix uses the strategy-aware
 * `machiningTimeForStrategy` instead.
 *
 * Model:
 *   - A clearance bit of diameter `clearanceDiameterInches` clears the bulk;
 *     it can carve any pixel within a disc of its radius that fits inside the
 *     mask. That set is the morphological opening of the mask.
 *   - The V-bit handles the remaining strip (mask − opening) and traces the
 *     full perimeter once for clean edges.
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
  perimeterInOverride?: number,
): MachiningTimeResult {
  const n = canvasW * canvasH;
  const clearanceRadiusPx = (clearanceDiameterInches * pixelsPerInch) / 2;
  const ppiSq = pixelsPerInch * pixelsPerInch;

  const opened = morphologicalOpening(mask, dist1, clearanceRadiusPx, canvasW, canvasH);

  let clearancePixels = 0, totalMaskPixels = 0;
  for (let k = 0; k < n; k++) {
    if (mask[k]) totalMaskPixels++;
    if (opened[k]) clearancePixels++;
  }
  const vbitPixels = totalMaskPixels - clearancePixels;

  const clearanceAreaSqIn = clearancePixels / ppiSq;
  const vbitAreaSqIn      = vbitPixels      / ppiSq;

  let perimeterIn: number;
  if (perimeterInOverride !== undefined) {
    perimeterIn = perimeterInOverride;
  } else {
    const boundary = computeBoundary(mask, canvasW, canvasH);
    let boundaryPixels = 0;
    for (let k = 0; k < n; k++) if (boundary[k]) boundaryPixels++;
    perimeterIn = boundaryPixels / pixelsPerInch;
  }

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
 * Format a clearance bit diameter as a fractional inch label.
 * 0.125 → 1/8", 0.25 → 1/4", 0.5 → 1/2".
 */
export function clearanceBitLabel(diameter: number): string {
  if (diameter === 0.125) return '1/8"';
  if (diameter === 0.25)  return '1/4"';
  if (diameter === 0.5)   return '1/2"';
  return `${diameter.toFixed(3)}"`;
}

/**
 * Enumerate every subset of `availableBits` as a `ClearanceStrategy`,
 * including the empty subset (v-bit only). Diameters within each strategy
 * are sorted descending (the order they would actually be run on the CNC,
 * since smaller bits fill the residual the larger ones can't reach).
 *
 * Output ordering: by bit count ascending, then by descending-diameter
 * lexicographic order. With three bits {1/2", 1/4", 1/8"} this produces:
 *   0. ∅            (V-bit only)
 *   1. [1/2"]
 *   2. [1/4"]
 *   3. [1/8"]
 *   4. [1/2", 1/4"]
 *   5. [1/2", 1/8"]
 *   6. [1/4", 1/8"]
 *   7. [1/2", 1/4", 1/8"]
 */
export function enumerateClearanceStrategies(
  availableBits: number[],
): import('@/types').ClearanceStrategy[] {
  const sorted = [...availableBits].sort((a, b) => b - a); // descending
  const subsets: number[][] = [[]];
  for (const bit of sorted) {
    const next: number[][] = [];
    for (const s of subsets) {
      next.push([...s, bit]);
    }
    subsets.push(...next);
  }
  // Each subset is in descending order because we appended bits in
  // descending order. Sort the OUTER list by bitCount asc, then by
  // descending-diameter lexicographic.
  subsets.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  });

  return subsets.map(diameters => ({
    diameters,
    label: diameters.length === 0
      ? 'V-bit only'
      : diameters.map(clearanceBitLabel).join(' → '),
    bitCount: diameters.length + 1, // clearance bits + v-bit
  }));
}

/**
 * Total wall time for a (strategy × v-bit) cell, including tool-change
 * overhead. The matrix stores cutting time only so the toolChangeMinutes
 * slider is reactive without recomputing.
 */
export function totalCellTime(
  matrix: import('@/types').MachiningTimeMatrix,
  strategyIdx: number,
  vbitIdx: number,
  toolChangeMinutes: number,
): number {
  const cutting = matrix.cuttingTimes[strategyIdx][vbitIdx];
  if (!isFinite(cutting)) return NaN;
  return cutting + matrix.strategies[strategyIdx].bitCount * toolChangeMinutes;
}

/**
 * Build the (strategy × V-bit) cutting-time comparison matrix for one
 * design. Pre-computes each layer's per-bit opening pixel count once,
 * then each strategy is a cheap reduction:
 *
 *   For strategy with bits [b1 > b2 > b3] (descending):
 *     incremental(b1) = open(b1).area
 *     incremental(b2) = open(b2).area − open(b1).area
 *     incremental(b3) = open(b3).area − open(b2).area
 *     vbitArea        = totalMask.area − open(smallest_in_strategy).area
 *
 *   With ∅ strategy: vbitArea = totalMask.area; no clearance time.
 *
 * Tool-change overhead is NOT included here — `totalCellTime` adds it
 * at render time using the user-set `toolChangeMinutes`.
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
  /** All available clearance bits (each with MRR). The strategies enumerated below are subsets of these. */
  clearanceBits: { diameterInches: number; mrr: number }[];
  vbits: import('@/types').MachiningTimeMatrix['vbits'];
}): import('@/types').MachiningTimeMatrix {
  const { layers, canvasW, canvasH, pixelsPerInch, inlayDepthInches,
          clearanceBits, vbits } = params;
  const ppiSq = pixelsPerInch * pixelsPerInch;
  const mrrByDiameter = new Map(clearanceBits.map(b => [b.diameterInches, b.mrr]));

  const strategies = enumerateClearanceStrategies(clearanceBits.map(b => b.diameterInches));

  // Per-layer pre-computation: for each side and each bit, the opened-area
  // pixel count, plus the total mask pixel count.
  type SideAreas = {
    totalPx: number;
    openedPxByBit: Map<number, number>; // diameter → opened pixel count
  };
  const layerSides: { pocket: SideAreas; plug: SideAreas }[] = layers.map(layer => {
    const compute = (mask: Uint8Array, dist1: Float32Array): SideAreas => {
      let totalPx = 0;
      for (let k = 0; k < mask.length; k++) if (mask[k]) totalPx++;
      const openedPxByBit = new Map<number, number>();
      for (const b of clearanceBits) {
        const radiusPx = (b.diameterInches * pixelsPerInch) / 2;
        const opened = morphologicalOpening(mask, dist1, radiusPx, canvasW, canvasH);
        let openedPx = 0;
        for (let k = 0; k < opened.length; k++) if (opened[k]) openedPx++;
        openedPxByBit.set(b.diameterInches, openedPx);
      }
      return { totalPx, openedPxByBit };
    };
    return {
      pocket: compute(layer.pocketMask,     layer.pocketDist1),
      plug:   compute(layer.plugCarvedMask, layer.plugDist1),
    };
  });

  // For each strategy × vbit, sum cutting time across layers + sides.
  const cuttingTimes: number[][] = strategies.map(strategy =>
    vbits.map(v => {
      if (!v.feasible) return NaN;
      let total = 0;

      const sideTime = (side: SideAreas, perimIn: number): number => {
        // Walk strategy bits descending; each bit clears the residual
        // not yet covered by larger bits. Smaller bits' opens are supersets
        // of larger ones, so incremental = open(b_i) − open(b_{i-1}).
        let prevOpenedPx = 0;
        let clearanceTime = 0;
        for (const d of strategy.diameters) {
          const openedPx = side.openedPxByBit.get(d) ?? 0;
          const incrementalPx = Math.max(0, openedPx - prevOpenedPx);
          const incrementalAreaSqIn = incrementalPx / ppiSq;
          const mrr = mrrByDiameter.get(d) ?? 0;
          if (mrr > 0) clearanceTime += incrementalAreaSqIn * inlayDepthInches / mrr;
          prevOpenedPx = openedPx;
        }
        const vbitPx = side.totalPx - prevOpenedPx;
        const vbitAreaSqIn = vbitPx / ppiSq;
        const tVbitArea = v.mrr  > 0 ? vbitAreaSqIn * inlayDepthInches / v.mrr : 0;
        const tPerim    = v.feed > 0 ? perimIn / v.feed                        : 0;
        return clearanceTime + tVbitArea + tPerim;
      };

      for (let li = 0; li < layers.length; li++) {
        const sides = layerSides[li];
        const perim = layers[li].pocketPerimeterIn;
        total += sideTime(sides.pocket, perim) + sideTime(sides.plug, perim);
      }
      return total;
    })
  );

  return { strategies, vbits, cuttingTimes };
}

export interface FastestFeasibleCell {
  strategyIdx: number;
  vbitIdx: number;
  totalTimeMinutes: number;
  strategyDiameters: number[];
  vbitAngleDegrees: number;
}

/**
 * Locate the fastest feasible (strategy, v-bit) combination in a matrix
 * given the current tool-change overhead. "Feasible" means the v-bit
 * column is feasible AND the cell time is finite. Used by both
 * BitMatrixTable (to highlight the green cell) and RecommendedSetupCard
 * (to surface the recommendation prominently).
 *
 * Returns null when no combination is feasible.
 */
export function findFastestFeasibleCell(
  matrix: import('@/types').MachiningTimeMatrix,
  toolChangeMinutes: number,
): FastestFeasibleCell | null {
  let best: FastestFeasibleCell | null = null;
  for (let si = 0; si < matrix.strategies.length; si++) {
    for (let vi = 0; vi < matrix.vbits.length; vi++) {
      if (!matrix.vbits[vi].feasible) continue;
      const t = totalCellTime(matrix, si, vi, toolChangeMinutes);
      if (!isFinite(t)) continue;
      if (best === null || t < best.totalTimeMinutes) {
        best = {
          strategyIdx: si,
          vbitIdx: vi,
          totalTimeMinutes: t,
          strategyDiameters: matrix.strategies[si].diameters,
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
