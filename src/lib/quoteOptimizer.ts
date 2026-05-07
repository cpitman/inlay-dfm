import type { Design, VectorData, WoodConfig, AnalysisResult, DFMSettings, Placement } from '@/types';
import {
  runDfmAnalysis,
  runDfmAnalysisLite,
} from './dfmAnalysis';
import { fillEnclosedHoles } from './fillEnclosedHoles';
import { fillConvexHullCovered } from './fillConvexHullCovered';
import { removeFullyOccludedRegions } from './removeOccludedRegions';
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
 * Resolution used by the lite-pass + fill modification. Half of
 * `GUIDED_PIXELS_PER_INCH` — connectivity-based fill detection is
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
 * Pipeline for one design, in isolation. Four phases:
 *
 *   1. Layer-order pre-pass at 60 ppi (`preAnalyzeLayerOrder`) +
 *      overlap-aware topo sort.
 *   2. Lite DFM analysis at 120 ppi — produces only fillableHoleCount
 *      and alignmentIssues per layer, plus the cached pocket masks.
 *   3. If any fillable holes → applyFillAll at 120 ppi.
 *   4. ONE full DFM analysis at 240 ppi — drives cost + bit plan.
 *   5. pickPerLayerBitPlan.
 *
 * Net analyses per design: 1 lite + 1 full, regardless of whether the
 * fill modification applied.
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

  // Phase 2: layer-mask expansion. Two passes inside `applyFillAll`:
  // closed-hole fill on lite-flagged layers, then convex-hull fill on
  // every non-final layer. Modifications run at the lite resolution —
  // the resulting SVG geometry is rasterization-independent in shape;
  // coarser polygons are fine since fill is already an over-
  // approximation (any pixel covered by later layers works).
  let appliedFill = false;
  const holeFillTargets = lite.woods.filter(w => w.fillableHoleCount > 0).map(w => w.colorHex);
  if (order.length >= 2) {
    onProgress?.(`Optimizing layer geometry${suffix}…`);
    workingVector = await applyFillAll(workingVector, holeFillTargets, designWidthInches, order, liteCanvasWidth);
    appliedFill = true;
  }

  // Phase 3: ONE full DFM analysis at the production resolution. This
  // is the only run whose output reaches the cost model + bit-plan
  // picker. Two `runDfmAnalysis` shortcuts apply here, both saving
  // wall-time the guided flow can't observe:
  //
  //   `produceOverlays: false` skips the per-side / per-preset /
  //   suggestion PNG encodes. The guided UI renders its own overlays
  //   in the React layer from the raw masks the analysis still
  //   computes (`widerBitInfeasibleMask` / `irreducibleProblemMask`).
  //   In dev builds we flip this on so the debug panel's per-layer
  //   ZIP can pluck the populated `overlayDataUrl` / `depthMapDataUrl`
  //   strings out of the cached result; `process.env.NODE_ENV` is
  //   statically inlined at build time, so production builds run with
  //   the original `false` and skip the encode work.
  //
  //   `useBinarySearchFeasibility: true` replaces the linear 6-preset
  //   stats sweep with a binary search for the largest-feasible v-bit
  //   preset (3–4 stats passes instead of 6). Sound because design-
  //   wide feasibility is monotonic in v-bit angle. The guided picker
  //   only ever uses the largest-feasible preset, so the sentinel
  //   per-preset entries at untested indices are never read.
  onProgress?.(`Analyzing your design${suffix}…`);
  const result = await runDfmAnalysis(
    workingVector, settings, order, canvasWidth,
    {
      produceOverlays: process.env.NODE_ENV === 'development',
      useBinarySearchFeasibility: true,
    },
  );

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
    side: design.side,
    vector: workingVector,
    woodConfigs: sortedWoodConfigs,
    placement: design.placement,
    result,
    bitPlan,
    appliedFill,
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
 * Apply mask-expansion + mask-shrink optimizations to every layer in
 * `colorOrder`, threading the modified layers through each call.
 * Three passes, in this order:
 *
 *   1. `fillEnclosedHoles` on layers flagged by the lite analysis as
 *      having fillable holes (`holeFillTargets`). Cheap and exact.
 *   2. `fillConvexHullCovered` on every non-final layer. Catches open
 *      concavities (U-, C-shapes) that pass 1 cannot — a layer
 *      component's convex hull is filled wherever the hull-added
 *      pixels are covered by later layers.
 *   3. `removeFullyOccludedRegions` on every non-final layer. Drops
 *      any connected component fully covered by the union of later
 *      inlay layers — visible nowhere, but still costs V-bit time.
 *
 * Order matters: the first two passes can GROW or MERGE components,
 * potentially creating new fully-covered ones. Pass 3 has to run
 * last so it sees the post-fill geometry. Forward iteration order
 * within pass 3 is provably safe — removing a covered component from
 * layer K never invalidates an earlier layer's coverage check, since
 * the removed pixels are by definition still in the union of layers
 * K+1..N.
 */
async function applyFillAll(
  vector: VectorData,
  holeFillTargets: string[],
  designWidthInches: number,
  colorOrder: string[],
  canvasWidth: number,
): Promise<VectorData> {
  const ENABLE_HULL_FILL = true;
  const ENABLE_OCCLUDED_REMOVAL = true;

  let workingLayers = vector.layers;

  const buildVector = (): VectorData => ({
    ...vector,
    layers: workingLayers,
    svgString: combineLayers(workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight),
  });

  // Pass 1: closed-hole fill. Limited to layers the lite analysis
  // already flagged — a precise, fast win.
  for (const colorHex of holeFillTargets) {
    const res = await fillEnclosedHoles(buildVector(), colorHex, designWidthInches, colorOrder, canvasWidth);
    if (res.filledHoleCount > 0) workingLayers = res.layers;
  }

  // Pass 2: convex-hull fill. Run for every non-final color; the lite
  // analysis doesn't surface a "hull-fillable" hint, and the per-layer
  // rasterization the function does internally is cheap relative to
  // the screening canvas it operates on.
  if (ENABLE_HULL_FILL) {
    for (let i = 0; i < colorOrder.length - 1; i++) {
      const colorHex = colorOrder[i];
      const res = await fillConvexHullCovered(buildVector(), colorHex, designWidthInches, colorOrder, canvasWidth);
      if (res.filledHoleCount > 0) workingLayers = res.layers;
    }
  }

  // Pass 3: remove fully-occluded regions. Runs LAST so any
  // components grown or merged by passes 1–2 have the chance to
  // become "fully covered by later layers" themselves.
  if (ENABLE_OCCLUDED_REMOVAL) {
    for (let i = 0; i < colorOrder.length - 1; i++) {
      const colorHex = colorOrder[i];
      const res = await removeFullyOccludedRegions(buildVector(), colorHex, designWidthInches, colorOrder, canvasWidth);
      if (res.removedComponentCount > 0) workingLayers = res.layers;
    }
  }

  return buildVector();
}
