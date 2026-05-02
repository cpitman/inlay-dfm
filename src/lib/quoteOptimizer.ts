import type { VectorData, WoodConfig, AnalysisResult, DFMSettings } from '@/types';
import { runDfmAnalysis } from './dfmAnalysis';
import { extendForRegistration } from './extendForRegistration';
import { fillEnclosedHoles } from './fillEnclosedHoles';
import { combineLayers } from './svgLayers';
import { findFastestFeasibleCell, type FastestFeasibleCell } from './machiningTime';

/** Manual tool change overhead used by the guided experience. */
const TOOL_CHANGE_MINUTES_MANUAL = 5;
const ANALYSIS_RESOLUTION_DEFAULT_PX = 1200;

export interface QuoteOptimizationResult {
  /** Final vector after fill + extend modifications applied. */
  vector: VectorData;
  /** WoodConfigs sorted by surface area ascending (smallest carved first). */
  woodConfigs: WoodConfig[];
  /** Final analysis result after every modification + re-analysis pass. */
  result: AnalysisResult;
  /**
   * Fastest feasible (clearance strategy × v-bit) cell from the final
   * matrix at manual tool-change overhead. `null` when no preset is
   * feasible — the design has features only sub-15° v-bits could reach,
   * which we treat as a "needs design changes" failure mode.
   */
  optimalCell: FastestFeasibleCell | null;
  /** True iff the pipeline ran a fill-holes pass. */
  appliedFill: boolean;
  /** True iff the pipeline ran an extend-for-registration pass. */
  appliedExtend: boolean;
  /** Total wall time (incl. tool changes) at the optimal cell. NaN when not feasible. */
  totalMachineMinutes: number;
}

export interface QuoteOptimizationInput {
  vector: VectorData;
  woodConfigs: WoodConfig[];
  designWidthInches: number;
  /** Optional override; defaults to 0.125". */
  inlayDepthInches?: number;
  /** Optional progress callback — receives a short status label per phase. */
  onProgress?: (label: string) => void;
}

/**
 * The guided quote pipeline. Six phases, each conditionally executed
 * to skip redundant work:
 *
 *   1. Analysis at the user's upload order — needed only to learn each
 *      layer's surface area for the sort.
 *   2. Sort woodConfigs by ascending surface area; re-analyze in the new
 *      order if it changed.
 *   3. Fill enclosed holes for any layer reporting fillableHoleCount > 0.
 *   4. Re-analyze if a fill was applied.
 *   5. Extend for registration on any layer with alignment risks.
 *   6. Re-analyze if an extend was applied.
 *   7. Pick the fastest feasible (strategy × v-bit) cell from the final
 *      matrix, assuming manual tool change (5 min/swap).
 *
 * Returns the final vector, sorted woodConfigs, the final analysis
 * result, and the optimal cell.
 */
export async function runQuoteOptimization(
  input: QuoteOptimizationInput,
): Promise<QuoteOptimizationResult> {
  const { vector: initialVector, woodConfigs: initialWoodConfigs, designWidthInches, onProgress } = input;
  const inlayDepthInches = input.inlayDepthInches ?? 0.125;
  const canvasWidth = ANALYSIS_RESOLUTION_DEFAULT_PX;

  const settings: DFMSettings = {
    designWidthInches,
    vbitAngleDegrees: 60,
    inlayDepthInches,
    grainDirection: 'horizontal',
    analysisResolution: 'default',
    clearanceBitDiameterInches: 0.25,
    clearanceStrategy: [0.25],
    toolChangeMinutes: TOOL_CHANGE_MINUTES_MANUAL,
    plugStockMarginInches: 0.25,
    plugGlueGapInches: 0.005,
    plugSurfaceGapInches: 0.010,
    boardWidthInches: 18,    // composite-only; analysis ignores
    boardHeightInches: 12,
    designOffsetXInches: 0,
    designOffsetYInches: 0,
  };

  let workingVector = initialVector;

  // Phase 1: initial analysis at the user's upload order.
  onProgress?.('Analyzing your design…');
  let order = initialWoodConfigs.map(wc => wc.colorHex);
  let result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);

  // Phase 2: sort woodConfigs by ascending surface area (smallest first).
  // Use the pocket-side carve area (clearance + v-bit) as the proxy.
  const areaByColor = new Map(result.woods.map(w => [
    w.colorHex,
    w.clearanceAreaSqIn + w.vbitAreaSqIn,
  ]));
  const sortedWoodConfigs = [...initialWoodConfigs].sort(
    (a, b) => (areaByColor.get(a.colorHex) ?? 0) - (areaByColor.get(b.colorHex) ?? 0),
  );
  const sortedOrder = sortedWoodConfigs.map(wc => wc.colorHex);
  const orderChanged =
    order.length !== sortedOrder.length ||
    order.some((c, i) => sortedOrder[i] !== c);
  if (orderChanged) {
    onProgress?.('Re-analyzing with optimized layer order…');
    order = sortedOrder;
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 3: fill enclosed holes where possible.
  let appliedFill = false;
  const fillTargets = result.woods.filter(w => w.fillableHoleCount > 0).map(w => w.colorHex);
  if (fillTargets.length > 0) {
    onProgress?.(`Filling enclosed holes in ${fillTargets.length} layer${fillTargets.length === 1 ? '' : 's'}…`);
    workingVector = await applyFillAll(workingVector, fillTargets, designWidthInches, order, canvasWidth);
    appliedFill = true;
    onProgress?.('Re-analyzing after fill…');
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 4: extend regions for registration.
  let appliedExtend = false;
  const extendTargets = result.woods.filter(w => w.alignmentIssues.length > 0).map(w => w.colorHex);
  if (extendTargets.length > 0) {
    onProgress?.(`Extending registration borders on ${extendTargets.length} layer${extendTargets.length === 1 ? '' : 's'}…`);
    workingVector = await applyExtendAll(workingVector, extendTargets, designWidthInches, order, canvasWidth);
    appliedExtend = true;
    onProgress?.('Re-analyzing after extend…');
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 5: pick optimal bits at manual tool-change overhead.
  onProgress?.('Picking optimal cutting bits…');
  const optimalCell = findFastestFeasibleCell(
    result.machiningTimeTable,
    TOOL_CHANGE_MINUTES_MANUAL,
  );

  return {
    vector: workingVector,
    woodConfigs: sortedWoodConfigs,
    result,
    optimalCell,
    appliedFill,
    appliedExtend,
    totalMachineMinutes: optimalCell?.totalTimeMinutes ?? NaN,
  };
}

/**
 * Apply extendForRegistration to every layer in `colorHexes` sequentially,
 * threading the modified layers through each call so the next iteration
 * sees the previous's output. Mirrors the page-level handleExtendAll
 * pattern but pure (no React state).
 */
async function applyExtendAll(
  vector: VectorData,
  colorHexes: string[],
  designWidthInches: number,
  colorOrder: string[],
  canvasWidth: number,
): Promise<VectorData> {
  let workingLayers = vector.layers;
  for (const colorHex of colorHexes) {
    const workingVector: VectorData = {
      ...vector,
      layers: workingLayers,
      svgString: combineLayers(workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight),
    };
    const res = await extendForRegistration(workingVector, colorHex, designWidthInches, colorOrder, canvasWidth);
    if (res.addedPixelCount > 0) workingLayers = res.layers;
  }
  return {
    ...vector,
    layers: workingLayers,
    svgString: combineLayers(workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight),
  };
}

/** Same pattern as applyExtendAll but for fillEnclosedHoles. */
async function applyFillAll(
  vector: VectorData,
  colorHexes: string[],
  designWidthInches: number,
  colorOrder: string[],
  canvasWidth: number,
): Promise<VectorData> {
  let workingLayers = vector.layers;
  for (const colorHex of colorHexes) {
    const workingVector: VectorData = {
      ...vector,
      layers: workingLayers,
      svgString: combineLayers(workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight),
    };
    const res = await fillEnclosedHoles(workingVector, colorHex, designWidthInches, colorOrder, canvasWidth);
    if (res.filledHoleCount > 0) workingLayers = res.layers;
  }
  return {
    ...vector,
    layers: workingLayers,
    svgString: combineLayers(workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight),
  };
}
