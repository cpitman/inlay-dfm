import type { Design, VectorData, WoodConfig, AnalysisResult, DFMSettings, Placement } from '@/types';
import { runDfmAnalysis } from './dfmAnalysis';
import { extendForRegistration } from './extendForRegistration';
import { fillEnclosedHoles } from './fillEnclosedHoles';
import { combineLayers } from './svgLayers';
import { preAnalyzeLayerOrder, topoSortByArea } from './layerOrderOptimizer';
import { pickPerLayerBitPlan, jointToolChangeOverhead, type PerLayerBitPlan } from './machiningTime';

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

/** Per-design optimization output. One entry per `Design` in the input. */
export interface DesignOptimizationResult {
  /** Stable id from the input `Design`. */
  designId: string;
  /** Final vector after fill + extend modifications applied. */
  vector: VectorData;
  /** WoodConfigs sorted by overlap-aware topo order (smallest carved first). */
  woodConfigs: WoodConfig[];
  /** Placement passed through unchanged from input — consumer needs it
   *  to render the design at the right spot on the board. */
  placement: Placement;
  /** Final analysis result after every modification + re-analysis pass. */
  result: AnalysisResult;
  /**
   * Per-layer bit plan: chosen clearance strategy + the largest feasible
   * v-bit for each layer + cutting time + per-design tool-change overhead.
   * `null` when no strategy makes every layer feasible — that design is
   * irreducibly non-manufacturable.
   */
  bitPlan: PerLayerBitPlan | null;
  /** True iff a fill-holes pass ran for this design. */
  appliedFill: boolean;
  /** True iff an extend-for-registration pass ran for this design. */
  appliedExtend: boolean;
}

/**
 * Aggregated cost inputs across all designs, ready to feed straight
 * into `computeQuote`. The optimizer builds these so the caller
 * (QuoteApp) doesn't have to repeat the per-species / cross-design
 * deduplication logic.
 */
export interface AggregatedQuoteInputs {
  /** Sum of per-design `bitPlan.cuttingTimeMinutes`. Excludes tool
   *  changes — those are tracked separately so we can deduplicate
   *  bits across designs. NaN if any design's bitPlan was null. */
  totalCuttingMinutes: number;
  /** Tool-change minutes after deduplicating clearance + v-bits across
   *  every design's bitPlan. See `jointToolChangeOverhead`. */
  jointToolChangeMinutes: number;
  /** Distinct wood species across all designs' woodConfigs. */
  uniqueSpeciesCount: number;
  /** Per-species plug-stock OBB usage summed across designs + slots. */
  plugStockUsageBySpecies: Map<string, number>;
  /** True iff any design has `bitPlan === null` (the quote is
   *  approximate when this is true — at least one design has features
   *  no v-bit can carve). */
  noFeasibleAngle: boolean;
}

export interface MultiDesignOptimizationResult {
  perDesign: DesignOptimizationResult[];
  aggregated: AggregatedQuoteInputs;
}

export interface QuoteOptimizationInput {
  designs: Design[];
  /** Optional override; defaults to 0.25" for the guided experience. */
  inlayDepthInches?: number;
  /** Optional progress callback — receives a short status label. */
  onProgress?: (label: string) => void;
}

/**
 * The guided quote pipeline for a multi-design board. Runs the existing
 * single-design pipeline (pre-pass + Phase 1 analysis + fill + extend +
 * bit-plan) for each design, then aggregates the per-design results
 * into `AggregatedQuoteInputs` so `computeQuote` can apply the
 * per-species cost rules across all designs.
 */
export async function runQuoteOptimization(
  input: QuoteOptimizationInput,
): Promise<MultiDesignOptimizationResult> {
  const { designs, onProgress } = input;
  const inlayDepthInches = input.inlayDepthInches ?? 0.25;

  // Sequential rather than parallel — the user reads the progress
  // text and parallel runs would scramble it. Total wall time is
  // identical (compute-bound either way) and per-design output is
  // self-contained.
  const perDesign: DesignOptimizationResult[] = [];
  for (let i = 0; i < designs.length; i++) {
    const d = designs[i];
    const label = designs.length === 1
      ? undefined
      : ` (design ${i + 1}/${designs.length})`;
    perDesign.push(
      await runSingleDesignOptimization(d, inlayDepthInches, label, onProgress),
    );
  }

  const aggregated = aggregate(perDesign);
  return { perDesign, aggregated };
}

/**
 * Pipeline for one design, in isolation. Mirrors the previous
 * single-design `runQuoteOptimization` body — extracted so the new
 * top-level orchestrator can run it per design.
 */
async function runSingleDesignOptimization(
  design: Design,
  inlayDepthInches: number,
  progressSuffix: string | undefined,
  onProgress?: (label: string) => void,
): Promise<DesignOptimizationResult> {
  const designWidthInches = design.placement.designWidthInches;
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

  const suffix = progressSuffix ?? '';
  let workingVector = design.vector;

  // Pre-pass at low res for area + overlap topology.
  onProgress?.(`Checking layer overlaps and sizes${suffix}…`);
  const initialOrder = design.woodConfigs.map(wc => wc.colorHex);
  const { areaSqInByColor, overlapConstraints } = await preAnalyzeLayerOrder(
    workingVector, designWidthInches, initialOrder,
  );
  const order = topoSortByArea(initialOrder, areaSqInByColor, overlapConstraints);
  const sortedWoodConfigs = order.map(c =>
    design.woodConfigs.find(wc => wc.colorHex === c)!
  );

  // Phase 1: full DFM analysis at the chosen order.
  onProgress?.(`Analyzing your design${suffix}…`);
  let result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);

  // Phase 2: fill enclosed holes where possible.
  let appliedFill = false;
  const fillTargets = result.woods.filter(w => w.fillableHoleCount > 0).map(w => w.colorHex);
  if (fillTargets.length > 0) {
    onProgress?.(`Filling enclosed holes${suffix}…`);
    workingVector = await applyFillAll(workingVector, fillTargets, designWidthInches, order, canvasWidth);
    appliedFill = true;
    onProgress?.(`Re-analyzing after fill${suffix}…`);
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 3: extend regions for registration.
  let appliedExtend = false;
  const extendTargets = result.woods.filter(w => w.alignmentIssues.length > 0).map(w => w.colorHex);
  if (extendTargets.length > 0) {
    onProgress?.(`Extending registration borders${suffix}…`);
    workingVector = await applyExtendAll(workingVector, extendTargets, designWidthInches, order, canvasWidth);
    appliedExtend = true;
    onProgress?.(`Re-analyzing after extend${suffix}…`);
    result = await runDfmAnalysis(workingVector, settings, order, canvasWidth);
  }

  // Phase 4: pick the per-layer bit plan.
  onProgress?.(`Picking optimal cutting bits${suffix}…`);
  const perLayerPresetAnalysis = result.woods.map(w => w.perPresetAnalysis);
  const bitPlan = pickPerLayerBitPlan(
    result.machiningTimeTable,
    perLayerPresetAnalysis,
    TOOL_CHANGE_MINUTES_MANUAL,
  );

  return {
    designId: design.id,
    vector: workingVector,
    woodConfigs: sortedWoodConfigs,
    placement: design.placement,
    result,
    bitPlan,
    appliedFill,
    appliedExtend,
  };
}

/**
 * Roll per-design results into the cross-design aggregates that
 * `computeQuote` consumes. Pure function — no I/O.
 */
function aggregate(perDesign: DesignOptimizationResult[]): AggregatedQuoteInputs {
  let totalCuttingMinutes = 0;
  const speciesSet = new Set<string>();
  const plugStockUsageBySpecies = new Map<string, number>();
  let noFeasibleAngle = false;

  for (const d of perDesign) {
    if (d.bitPlan === null) noFeasibleAngle = true;
    else                    totalCuttingMinutes += d.bitPlan.cuttingTimeMinutes;

    // Species union + per-species plug-stock sum. The result.woods
    // array is in carve order (matches sortedWoodConfigs), and each
    // wood carries its own plugStockUsageSqIn measurement.
    for (let i = 0; i < d.woodConfigs.length; i++) {
      const wc = d.woodConfigs[i];
      speciesSet.add(wc.species);
      const wood = d.result.woods.find(w => w.colorHex === wc.colorHex);
      const usage = wood?.plugStockUsageSqIn;
      if (usage !== undefined && Number.isFinite(usage)) {
        plugStockUsageBySpecies.set(
          wc.species,
          (plugStockUsageBySpecies.get(wc.species) ?? 0) + usage,
        );
      }
    }
  }

  const jointToolChangeMinutes = jointToolChangeOverhead(
    perDesign.map(d => d.bitPlan),
    TOOL_CHANGE_MINUTES_MANUAL,
  );

  return {
    totalCuttingMinutes: noFeasibleAngle ? NaN : totalCuttingMinutes,
    jointToolChangeMinutes,
    uniqueSpeciesCount: speciesSet.size,
    plugStockUsageBySpecies,
    noFeasibleAngle,
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
