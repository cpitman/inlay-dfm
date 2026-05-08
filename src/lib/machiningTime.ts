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

export interface FastestFeasibleCell {
  strategyIdx: number;
  vbitIdx: number;
  totalTimeMinutes: number;
  strategyDiameters: number[];
  vbitAngleDegrees: number;
}

/** Per-layer feasibility test, given a per-layer v-bit angle index. */
function isLayerFeasibleAtVbit(
  perPresetAnalysis: import('@/types').PerPresetAngleResult[],
  vbitIdx: number,
): boolean {
  const presetEntry = perPresetAnalysis[vbitIdx];
  if (!presetEntry) return false;
  // Match the design-wide feasibility threshold (FEASIBILITY_PROBLEM_PCT
  // in dfmAnalysis.ts) at the per-layer level. A layer is feasible at
  // a given v-bit angle iff both pocket and plug stay under the same
  // 10% threshold AND neither has an isolated unreachable component.
  const FEASIBILITY_PROBLEM_PCT = 10;
  return (
    presetEntry.pocket.problemAreaPercent <= FEASIBILITY_PROBLEM_PCT
    && !presetEntry.pocket.hasIsolatedUnreachableComponent
    && presetEntry.plug.problemAreaPercent  <= FEASIBILITY_PROBLEM_PCT
    && !presetEntry.plug.hasIsolatedUnreachableComponent
  );
}

/**
 * Joint tool-change overhead across a set of per-design bit plans.
 * Each design's `PerLayerBitPlan` already includes its own internal
 * tool-change overhead, but when several designs are carved on the
 * same board their bits can be shared — a 1/4" clearance bit loaded
 * once covers every design that uses it.
 *
 * Returns `(|union clearance diameters| + |union v-bit angles|) ×
 * toolChangeMinutes`. Callers should subtract each design's
 * `toolChangeOverheadMinutes` from its `totalTimeMinutes` (or sum
 * `cuttingTimeMinutes` directly) to avoid double-counting.
 *
 * Null entries (designs with no feasible bit plan) are skipped — they
 * contribute neither a clearance nor a v-bit to the union.
 */
export function jointToolChangeOverhead(
  perDesignBitPlans: ReadonlyArray<PerLayerBitPlan | null>,
  toolChangeMinutes: number,
): number {
  const clearanceDiameters = new Set<number>();
  const vbitAngles = new Set<number>();
  for (const plan of perDesignBitPlans) {
    if (!plan) continue;
    for (const d of plan.strategyDiameters) clearanceDiameters.add(d);
    for (const a of plan.perLayerVbitAngles) vbitAngles.add(a);
  }
  return (clearanceDiameters.size + vbitAngles.size) * toolChangeMinutes;
}

export interface PerLayerBitPlan {
  /** Index into matrix.strategies of the chosen clearance strategy. */
  strategyIdx: number;
  /** Diameters of the chosen clearance strategy (largest-first). */
  strategyDiameters: number[];
  /** Picked v-bit angle index per layer (into matrix.vbits). */
  perLayerVbitIdxs: number[];
  /** Picked v-bit angle in degrees per layer. */
  perLayerVbitAngles: number[];
  /** Distinct v-bit angles used. Drives tool-change overhead. */
  distinctVbitCount: number;
  /** Sum across layers of per-layer cutting time at the chosen angle. */
  cuttingTimeMinutes: number;
  /** Tool-change overhead minutes (clearance bits + distinct v-bits) × tcMin. */
  toolChangeOverheadMinutes: number;
  /** Cutting + tool-change overhead. The number for cost calc + display. */
  totalTimeMinutes: number;
}

/**
 * Pick a per-layer v-bit plan that minimizes total wall time, given the
 * machining matrix and per-layer feasibility data. Used by the guided
 * quote pipeline (`/quote`) when each layer can choose its OWN v-bit
 * independently — typically a faster widest-feasible bit per layer
 * than the design-wide widest-feasible from `findFastestFeasibleCell`.
 *
 * Algorithm — for each clearance strategy:
 *   1. Per layer, pick the largest preset v-bit at which that layer is
 *      feasible (pocket+plug). If any layer has no feasible preset,
 *      this strategy is infeasible (skip).
 *   2. Sum each layer's `layerCuttingTimes[L][si][bestL]` for cutting time.
 *   3. Tool changes = (clearance bit count + distinct v-bits used) ×
 *      toolChangeMinutes. The "distinct v-bits" replaces the implicit
 *      single-v-bit accounting in `strategy.bitCount`.
 *   4. Total = cutting + overhead. Track the minimum across strategies.
 *
 * Returns null when no strategy makes every layer feasible — same
 * "irreducibly non-manufacturable" signal as `findFastestFeasibleCell`
 * returning null.
 *
 * Per-layer feasibility comes from each wood's `perPresetAnalysis`
 * (already populated by `dfmAnalysis`). The caller passes that data
 * keyed by layer index — the matrix's layer order is the same as the
 * `colorOrder` passed into `runDfmAnalysis`.
 */
export function pickPerLayerBitPlan(
  matrix: import('@/types').MachiningTimeMatrix,
  perLayerPresetAnalysis: import('@/types').PerPresetAngleResult[][],
  toolChangeMinutes: number,
): PerLayerBitPlan | null {
  const numLayers = perLayerPresetAnalysis.length;
  if (numLayers === 0) return null;
  // Sanity-check the dimensions agree.
  if (matrix.layerCuttingTimes.length !== numLayers) return null;

  let best: PerLayerBitPlan | null = null;
  for (let si = 0; si < matrix.strategies.length; si++) {
    const strategy = matrix.strategies[si];

    // Pick the largest feasible v-bit for each layer.
    const perLayerVbitIdxs: number[] = [];
    let allFeasible = true;
    for (let li = 0; li < numLayers; li++) {
      let pickedVi = -1;
      // Walk from widest preset down; first feasible wins.
      for (let vi = matrix.vbits.length - 1; vi >= 0; vi--) {
        if (!matrix.vbits[vi].feasible) continue;
        if (!isFinite(matrix.layerCuttingTimes[li][si][vi])) continue;
        if (!isLayerFeasibleAtVbit(perLayerPresetAnalysis[li], vi)) continue;
        pickedVi = vi; break;
      }
      if (pickedVi < 0) { allFeasible = false; break; }
      perLayerVbitIdxs.push(pickedVi);
    }
    if (!allFeasible) continue;

    // Cutting time = sum across layers at each layer's chosen v-bit.
    let cutting = 0;
    for (let li = 0; li < numLayers; li++) {
      cutting += matrix.layerCuttingTimes[li][si][perLayerVbitIdxs[li]];
    }
    if (!isFinite(cutting)) continue;

    // Tool-change overhead: each clearance bit + each distinct v-bit
    // counts as one load. (The matrix's strategy.bitCount counts one
    // v-bit by default; we replace that with the distinct count here.)
    const distinctVbitIdxs = new Set(perLayerVbitIdxs);
    const distinctVbitCount = distinctVbitIdxs.size;
    const bitsLoaded = strategy.diameters.length + distinctVbitCount;
    const overhead = bitsLoaded * toolChangeMinutes;
    const total = cutting + overhead;

    if (best === null || total < best.totalTimeMinutes) {
      best = {
        strategyIdx: si,
        strategyDiameters: strategy.diameters,
        perLayerVbitIdxs,
        perLayerVbitAngles: perLayerVbitIdxs.map(vi => matrix.vbits[vi].angleDegrees),
        distinctVbitCount,
        cuttingTimeMinutes: cutting,
        toolChangeOverheadMinutes: overhead,
        totalTimeMinutes: total,
      };
    }
  }
  return best;
}

/**
 * Build a "rough" PerLayerBitPlan locked to a single v-bit index for
 * every layer, ignoring feasibility. Used as a fallback when
 * `pickPerLayerBitPlan` returns null (no preset is feasible for some
 * layer): we still want the price quote to include a machining-time
 * estimate rather than zero, otherwise the buyer sees a price that
 * implies ~0 cutting time and forms expectations far below reality.
 *
 * Pick `vbitIdx = 0` (the smallest = sharpest = slowest preset) for
 * the most-conservative time estimate — a sharp bit takes the longest
 * because it removes less material per pass.
 *
 * The strategy is chosen to minimize total time at the fixed v-bit
 * (same min-over-strategies as `pickPerLayerBitPlan`). Returns null
 * iff `vbitIdx` has non-finite cutting times for some layer, or the
 * matrix is empty.
 */
export function pickRoughBitPlan(
  matrix: import('@/types').MachiningTimeMatrix,
  toolChangeMinutes: number,
  vbitIdx: number = 0,
): PerLayerBitPlan | null {
  const numLayers = matrix.layerCuttingTimes.length;
  if (numLayers === 0) return null;
  if (vbitIdx < 0 || vbitIdx >= matrix.vbits.length) return null;

  let best: PerLayerBitPlan | null = null;
  for (let si = 0; si < matrix.strategies.length; si++) {
    const strategy = matrix.strategies[si];
    let cutting = 0;
    let allFinite = true;
    for (let li = 0; li < numLayers; li++) {
      const t = matrix.layerCuttingTimes[li][si][vbitIdx];
      if (!isFinite(t)) { allFinite = false; break; }
      cutting += t;
    }
    if (!allFinite) continue;

    const distinctVbitCount = 1;
    const bitsLoaded = strategy.diameters.length + distinctVbitCount;
    const overhead = bitsLoaded * toolChangeMinutes;
    const total = cutting + overhead;

    if (best === null || total < best.totalTimeMinutes) {
      const perLayerVbitIdxs = Array<number>(numLayers).fill(vbitIdx);
      best = {
        strategyIdx: si,
        strategyDiameters: strategy.diameters,
        perLayerVbitIdxs,
        perLayerVbitAngles: perLayerVbitIdxs.map(vi => matrix.vbits[vi].angleDegrees),
        distinctVbitCount,
        cuttingTimeMinutes: cutting,
        toolChangeOverheadMinutes: overhead,
        totalTimeMinutes: total,
      };
    }
  }
  return best;
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
