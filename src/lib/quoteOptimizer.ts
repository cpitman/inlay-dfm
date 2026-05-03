import type { VectorData, WoodConfig, AnalysisResult, DFMSettings } from '@/types';
import { runDfmAnalysis } from './dfmAnalysis';
import { extendForRegistration } from './extendForRegistration';
import { fillEnclosedHoles } from './fillEnclosedHoles';
import { combineLayers } from './svgLayers';
import { preAnalyzeLayerOrder, topoSortByArea } from './layerOrderOptimizer';
import { pickPerLayerBitPlan, type PerLayerBitPlan } from './machiningTime';

/** Manual tool change overhead used by the guided experience. */
const TOOL_CHANGE_MINUTES_MANUAL = 5;
/**
 * Analysis canvas resolution for the guided flow, in pixels per inch.
 * 240 ppi resolves features down to ~0.0042" — slightly finer than the
 * ±0.005" X/Y accuracy of a typical CNC router, so the analysis catches
 * everything the machine could realistically miscarve. The expert flow
 * keeps its own user-controlled `analysisResolution` setting and is
 * unaffected.
 */
const GUIDED_PIXELS_PER_INCH = 240;

export interface QuoteOptimizationResult {
  /** Final vector after fill + extend modifications applied. */
  vector: VectorData;
  /** WoodConfigs sorted by surface area ascending (smallest carved first). */
  woodConfigs: WoodConfig[];
  /** Final analysis result after every modification + re-analysis pass. */
  result: AnalysisResult;
  /**
   * Per-layer bit plan: chosen clearance strategy + the largest feasible
   * v-bit for each layer + total wall time including tool-change
   * overhead. `null` when no strategy makes every layer feasible — the
   * design is irreducibly non-manufacturable, same as the previous
   * "no feasible v-bit at any preset" failure mode.
   */
  bitPlan: PerLayerBitPlan | null;
  /** True iff the pipeline ran a fill-holes pass. */
  appliedFill: boolean;
  /** True iff the pipeline ran an extend-for-registration pass. */
  appliedExtend: boolean;
  /** Total wall time (incl. tool changes) at the chosen bit plan. NaN when not feasible. */
  totalMachineMinutes: number;
}

export interface QuoteOptimizationInput {
  vector: VectorData;
  woodConfigs: WoodConfig[];
  designWidthInches: number;
  /** Optional override; defaults to 0.25" for the guided experience. */
  inlayDepthInches?: number;
  /** Optional progress callback — receives a short status label per phase. */
  onProgress?: (label: string) => void;
}

/**
 * The guided quote pipeline. Conditionally executes each phase to
 * skip redundant work:
 *
 *   Pre-pass. Cheap low-resolution rasterization to learn per-layer
 *     surface area and which layer pairs actually overlap. The
 *     overlap result becomes a topological constraint on carving
 *     order — overlapping layers MUST keep their user-stack order
 *     since the later one cuts through the earlier one's territory.
 *   Order. Topo-sort smallest-area-first within those constraints.
 *   Phase 1. One full DFM analysis at the chosen order.
 *   Phase 2. Fill enclosed holes for any layer reporting
 *     fillableHoleCount > 0; re-analyze if applied.
 *   Phase 3. Extend for registration on any layer with alignment
 *     risks; re-analyze if applied.
 *   Phase 4. Pick the fastest feasible per-layer bit plan.
 *
 * Returns the final vector, sorted woodConfigs, the final analysis
 * result, and the optimal cell.
 */
export async function runQuoteOptimization(
  input: QuoteOptimizationInput,
): Promise<QuoteOptimizationResult> {
  const { vector: initialVector, woodConfigs: initialWoodConfigs, designWidthInches, onProgress } = input;
  const inlayDepthInches = input.inlayDepthInches ?? 0.25;
  // Scale the analysis canvas with the design — bigger designs need
  // more pixels to keep the same physical resolution. No upper cap;
  // very large designs trade some optimizer wall-time for fidelity.
  const canvasWidth = Math.max(1, Math.ceil(designWidthInches * GUIDED_PIXELS_PER_INCH));

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

  // Pre-pass: pick the carving order at low resolution. Cheap
  // (~16× less compute than the full 240-ppi analysis) but sufficient
  // for area + overlap topology. Replaces the previous "run full
  // analysis just to learn areas, then re-run if the order changed"
  // pattern — saves one full analysis pass.
  onProgress?.('Checking layer overlaps and sizes…');
  const initialOrder = initialWoodConfigs.map(wc => wc.colorHex);
  const { areaSqInByColor, overlapConstraints } = await preAnalyzeLayerOrder(
    workingVector, designWidthInches, initialOrder,
  );
  const order = topoSortByArea(initialOrder, areaSqInByColor, overlapConstraints);
  const sortedWoodConfigs = order.map(c =>
    initialWoodConfigs.find(wc => wc.colorHex === c)!
  );

  // Phase 1: full DFM analysis at the chosen order.
  onProgress?.('Analyzing your design…');
  let result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);

  // Phase 2: fill enclosed holes where possible.
  let appliedFill = false;
  const fillTargets = result.woods.filter(w => w.fillableHoleCount > 0).map(w => w.colorHex);
  if (fillTargets.length > 0) {
    onProgress?.(`Filling enclosed holes in ${fillTargets.length} layer${fillTargets.length === 1 ? '' : 's'}…`);
    workingVector = await applyFillAll(workingVector, fillTargets, designWidthInches, order, canvasWidth);
    appliedFill = true;
    onProgress?.('Re-analyzing after fill…');
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 3: extend regions for registration.
  let appliedExtend = false;
  const extendTargets = result.woods.filter(w => w.alignmentIssues.length > 0).map(w => w.colorHex);
  if (extendTargets.length > 0) {
    onProgress?.(`Extending registration borders on ${extendTargets.length} layer${extendTargets.length === 1 ? '' : 's'}…`);
    workingVector = await applyExtendAll(workingVector, extendTargets, designWidthInches, order, canvasWidth);
    appliedExtend = true;
    onProgress?.('Re-analyzing after extend…');
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 4: pick the per-layer bit plan. Each layer chooses the widest
  // v-bit angle that's still feasible for its own pocket+plug; the
  // optimizer minimizes total time across (clearance strategy × distinct
  // v-bits used). The clearance bit + distinct v-bit count drives the
  // tool-change overhead at manual swap (5 min/load).
  onProgress?.('Picking optimal cutting bits per layer…');
  const perLayerPresetAnalysis = result.woods.map(w => w.perPresetAnalysis);
  const bitPlan = pickPerLayerBitPlan(
    result.machiningTimeTable,
    perLayerPresetAnalysis,
    TOOL_CHANGE_MINUTES_MANUAL,
  );

  return {
    vector: workingVector,
    woodConfigs: sortedWoodConfigs,
    result,
    bitPlan,
    appliedFill,
    appliedExtend,
    totalMachineMinutes: bitPlan?.totalTimeMinutes ?? NaN,
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
