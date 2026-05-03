import type { Design, VectorData, WoodConfig, AnalysisResult, DFMSettings, Placement, AlignmentIssue } from '@/types';
import {
  runDfmAnalysis,
  runDfmAnalysisLite,
  rasterizeLayerMask,
  redetectAlignmentRisks,
} from './dfmAnalysis';
import { extendForRegistration } from './extendForRegistration';
import { fillEnclosedHoles } from './fillEnclosedHoles';
import { combineLayers } from './svgLayers';
import { preAnalyzeLayerOrder, topoSortByArea } from './layerOrderOptimizer';
import { pickPerLayerBitPlan, jointToolChangeOverhead, type PerLayerBitPlan } from './machiningTime';
import { EMPTY_SIDE_AGGREGATE, type SideAggregate } from './pricing';

/** Manual tool change overhead used by the guided experience. */
const TOOL_CHANGE_MINUTES_MANUAL = 5;
/**
 * Analysis canvas resolution for the FINAL DFM analysis in the guided
 * flow, in pixels per inch. 240 ppi resolves features down to
 * ~0.0042" — slightly finer than the ±0.005" X/Y accuracy of a
 * typical CNC router. The expert flow keeps its own user-controlled
 * `analysisResolution` setting and is unaffected.
 */
const GUIDED_PIXELS_PER_INCH = 240;
/**
 * Resolution used by the lite-pass + fill/extend modifications. Half
 * of `GUIDED_PIXELS_PER_INCH` — the 0.01" alignment threshold is still
 * suprapixel (1.2 px) and connectivity-based fill detection is
 * resolution-insensitive at this scale, but the per-layer rasterization
 * and per-pixel work drops to ~25% of the full-pass cost.
 */
const LITE_PIXELS_PER_INCH = 120;

/** Per-design optimization output. One entry per `Design` in the input. */
export interface DesignOptimizationResult {
  /** Stable id from the input `Design`. */
  designId: string;
  /** Side of the board this design lives on, passed through from input. */
  side: 'top' | 'bottom';
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
 * Aggregated cost inputs across all designs, partitioned by side.
 * `computeQuote` consumes these directly: each side's costs (inlay
 * material, per-inlay machining + labor) are computed independently
 * and summed; one-time costs (base board, setup + finishing labor,
 * groove/handle premiums) stay board-wide.
 */
export interface AggregatedQuoteInputs {
  perSide: { top: SideAggregate; bottom: SideAggregate };
  /** True iff any design (on any side) has `bitPlan === null` — the
   *  quote is approximate when this is true. */
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
 * Pipeline for one design, in isolation. Five phases:
 *
 *   1. Layer-order pre-pass at 60 ppi (`preAnalyzeLayerOrder`) +
 *      overlap-aware topo sort.
 *   2. Lite DFM analysis at 120 ppi — produces only fillableHoleCount
 *      and alignmentIssues per layer, plus the cached pocket masks.
 *   3. If any fillable holes → applyFillAll at 120 ppi → re-rasterize
 *      modified layers → redetectAlignmentRisks on the patched mask
 *      set so extend doesn't fire on issues fill already resolved.
 *   4. If any remaining alignment risks → applyExtendAll at 120 ppi.
 *   5. ONE full DFM analysis at 240 ppi — drives cost + bit plan.
 *   6. pickPerLayerBitPlan.
 *
 * Net analyses per design: 1 lite + 1 full, regardless of which
 * modifications applied (was 1-3 full in the previous design).
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
  const canvasWidth     = Math.max(1, Math.ceil(designWidthInches * GUIDED_PIXELS_PER_INCH));
  const liteCanvasWidth = Math.max(1, Math.ceil(designWidthInches * LITE_PIXELS_PER_INCH));

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

  // Phase 1 (lite): cheap target enumeration. Identifies fillable
  // holes + alignment risks at 120 ppi (vs the 240 ppi final pass).
  // Skips per-preset overlay encoding, depth maps, and the machining
  // matrix — those run once at the end after fill + extend commit.
  onProgress?.(`Inspecting your design${suffix}…`);
  const lite = await runDfmAnalysisLite(workingVector, settings, order, liteCanvasWidth);

  // Phase 2: fill enclosed holes where possible. Modifications run at
  // the lite resolution — the resulting SVG geometry is rasterization-
  // independent in shape; coarser polygons are fine since fill is
  // already an overapproximation (any pixel inside the hole works).
  let appliedFill = false;
  const fillTargets = lite.woods.filter(w => w.fillableHoleCount > 0).map(w => w.colorHex);
  let alignmentByColor: Map<string, AlignmentIssue[]> = new Map(
    lite.woods.map(w => [w.colorHex, w.alignmentIssues] as const),
  );
  if (fillTargets.length > 0) {
    onProgress?.(`Filling enclosed holes${suffix}…`);
    workingVector = await applyFillAll(workingVector, fillTargets, designWidthInches, order, liteCanvasWidth);
    appliedFill = true;

    // Re-rasterize ONLY the modified layers — unmodified layers'
    // masks are still valid from the lite pass. Then re-run alignment
    // detection on the patched mask set so an alignment issue that
    // fill resolved (by removing an interior boundary) doesn't trip
    // extend on the next phase.
    const updatedMasks = new Map(lite.pocketMasks);
    for (const colorHex of fillTargets) {
      updatedMasks.set(
        colorHex,
        await rasterizeLayerMask(workingVector, colorHex, lite.canvasW, lite.canvasH),
      );
    }
    alignmentByColor = redetectAlignmentRisks(
      updatedMasks, order, lite.canvasW, lite.canvasH, lite.alignThresholdPx,
    );
  }

  // Phase 3: extend regions for registration. Targets come from the
  // post-fill alignment map.
  let appliedExtend = false;
  const extendTargets = order.filter(c => (alignmentByColor.get(c)?.length ?? 0) > 0);
  if (extendTargets.length > 0) {
    onProgress?.(`Extending registration borders${suffix}…`);
    workingVector = await applyExtendAll(workingVector, extendTargets, designWidthInches, order, liteCanvasWidth);
    appliedExtend = true;
  }

  // Phase 4: ONE full DFM analysis at the production resolution. This
  // is the only run whose output reaches the cost model + bit-plan
  // picker. Skip the per-side / per-preset / suggestion PNG encodes —
  // the guided UI renders its own overlays in the React layer from
  // the raw `widerBitInfeasibleMask` / `irreducibleProblemMask` masks
  // that this analysis still produces. The encoded URLs are consumed
  // only by the expert flow and ignored here, so encoding ~150 PNGs
  // we'll discard is pure overhead.
  onProgress?.(`Analyzing your design${suffix}…`);
  const result = await runDfmAnalysis(
    workingVector, settings, order, canvasWidth,
    { produceOverlays: false },
  );

  // Phase 5: pick the per-layer bit plan.
  onProgress?.(`Picking optimal cutting bits${suffix}…`);
  const perLayerPresetAnalysis = result.woods.map(w => w.perPresetAnalysis);
  const bitPlan = pickPerLayerBitPlan(
    result.machiningTimeTable,
    perLayerPresetAnalysis,
    TOOL_CHANGE_MINUTES_MANUAL,
  );

  return {
    designId: design.id,
    side: design.side,
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
 * Roll per-design results into per-side aggregates that `computeQuote`
 * consumes. Each side runs independently — same species used on both
 * sides counts twice, the 70%-of-sheet packing threshold applies to
 * each side's sum separately, and tool changes union within a side
 * but not across sides (sides are physically flipped so bits are
 * re-loaded at the swap regardless).
 *
 * Pure function — no I/O.
 */
function aggregate(perDesign: DesignOptimizationResult[]): AggregatedQuoteInputs {
  const top    = aggregateSide(perDesign.filter(d => d.side === 'top'));
  const bottom = aggregateSide(perDesign.filter(d => d.side === 'bottom'));
  const noFeasibleAngle = perDesign.some(d => d.bitPlan === null);
  return { perSide: { top, bottom }, noFeasibleAngle };
}

/** Build a `SideAggregate` from the designs that live on one side. */
function aggregateSide(designs: DesignOptimizationResult[]): SideAggregate {
  if (designs.length === 0) return EMPTY_SIDE_AGGREGATE;

  let totalCuttingMinutes = 0;
  let anyInfeasible = false;
  const speciesSet = new Set<string>();
  const plugStockUsageBySpecies = new Map<string, number>();

  for (const d of designs) {
    if (d.bitPlan === null) anyInfeasible = true;
    else                    totalCuttingMinutes += d.bitPlan.cuttingTimeMinutes;

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
    designs.map(d => d.bitPlan),
    TOOL_CHANGE_MINUTES_MANUAL,
  );

  return {
    totalCuttingMinutes: anyInfeasible ? NaN : totalCuttingMinutes,
    jointToolChangeMinutes,
    uniqueSpeciesCount: speciesSet.size,
    plugStockUsageBySpecies,
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
