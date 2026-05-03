export type GrainDirection = 'horizontal' | 'vertical' | 'end';

export type WoodSpeciesKey =
  | 'maple' | 'cherry' | 'padauk' | 'purpleheart'
  | 'walnut' | 'ebony' | 'osage_orange';

export interface WoodConfig {
  colorHex: string;   // detected fill color from the SVG (used for mask matching)
  label: string;      // user-visible name
  species: WoodSpeciesKey;
}

/** Proximity warning when this inlay's boundary is within the alignment threshold of a later inlay's boundary. */
export interface AlignmentIssue {
  /** colorHex of the later inlay whose boundary is too close to this one's. */
  otherColorHex: string;
  /** Percentage of this inlay's perimeter that is within the alignment threshold of the other inlay's boundary. */
  affectedPercent: number;
}

/** Analysis raster width preset. Higher resolution detects finer features at quadratic memory/CPU cost. */
export type AnalysisResolution = 'low' | 'default' | 'high';

export interface DFMSettings {
  designWidthInches: number;
  vbitAngleDegrees: number;
  inlayDepthInches: number;
  grainDirection: GrainDirection;
  /** Pixel width of the analysis canvas — controls feature-detection resolution. */
  analysisResolution: AnalysisResolution;
  /**
   * Diameter of the "primary" clearance bit (1/8", 1/4", or 1/2") used by
   * per-wood machine-time displays on Step 2 / Step 3. Step 4's matrix
   * uses `clearanceStrategy` instead — multi-bit modeling lives there.
   * Kept in sync: matrix selection updates this to the largest bit in the
   * chosen strategy (or 0.25 default when strategy is empty).
   */
  clearanceBitDiameterInches: 0.125 | 0.25 | 0.5;
  /**
   * Ordered descending list of clearance bit diameters used together for
   * Step 4's machining-time estimates. Empty array = v-bit only, no
   * clearance pass. Default is `[0.25]` (single 1/4").
   */
  clearanceStrategy: number[];
  /**
   * Wall-clock time spent loading or swapping a CNC bit. Each strategy on
   * Step 4 incurs this cost once per bit it uses (counting the initial
   * load). Defaults to 5 (manual swap); ATC machines use ~0.5.
   */
  toolChangeMinutes: number;
  /**
   * Margin around each plug's convex hull when modeling the plug stock for
   * machining-time estimates. Plug carved area = (convex hull of plug,
   * dilated by this margin) − (plug shape).
   */
  plugStockMarginInches: number;
  /**
   * Vertical clearance left between the plug's bottom face and the pocket
   * floor so glue has room. The plug-side carve depth is reduced uniformly
   * by this amount, clamped to no-carve where the original depth was less.
   * Typical values: 0.003"–0.010".
   */
  plugGlueGapInches: number;
  /**
   * Additional vertical clearance applied to the plug's flat-bottom carve
   * region only (the area where the v-bit reaches full depth). Creates a
   * step-down at the foot of the tapered wall so the plug's "shoulder"
   * doesn't bottom out before the plug seats fully. Typical: 0.005"–0.015".
   * Net effective plug depth used for time = inlayDepth - glueGap + surfaceGap.
   */
  plugSurfaceGapInches: number;
  /** User-supplied V-bit material removal rate (in³/min). Set only when the V-bit angle is non-preset. */
  vbitMRRInches3PerMin?: number;
  /** User-supplied V-bit linear feed rate (in/min). Set only when the V-bit angle is non-preset. */
  vbitFeedInchesPerMin?: number;
  /** Width of the actual board (e.g. cutting board) the design will be inlaid into. Composite-view-only. */
  boardWidthInches: number;
  /** Height of the actual board. Composite-view-only. */
  boardHeightInches: number;
  /** Left edge of the design on the board (in inches from the left edge of the board). */
  designOffsetXInches: number;
  /** Top edge of the design on the board (in inches from the top edge of the board). */
  designOffsetYInches: number;
}

/** A single layer's vector geometry, rendered with one fill color. */
export interface Layer {
  /** Identifier — the original detected fill color in lowercase #rrggbb hex. */
  colorHex: string;
  /** SVG markup for this layer's elements only (no <svg> wrapper, no background). */
  svgFragment: string;
}

export interface VectorData {
  /** Combined SVG of all current layers (regenerated when layers change). */
  svgString: string;
  /** Per-layer geometry, in the same order as detectedColors at parse time. */
  layers: Layer[];
  naturalWidth: number;
  naturalHeight: number;
  /** Cached "0 0 W H" viewBox string for re-emitting SVGs. */
  viewBox: string;
  fileName: string;
  fileType: 'svg' | 'dxf';
  /** Distinct non-white fill colors found in the file, as lowercase #rrggbb hex strings. */
  detectedColors: string[];
}

/**
 * Where a design sits on the board, in board-coordinate inches.
 * `offsetX/Y` is the top-left corner of the design's bounding box;
 * the height is derived from `designWidthInches` × design aspect.
 */
export interface Placement {
  offsetXInches: number;
  offsetYInches: number;
  designWidthInches: number;
}

/**
 * One design on a multi-design board. The user can upload several;
 * each gets its own SVG vector, color→wood mapping, and placement.
 * Two designs cannot overlap on the board (AABB-disjoint, edge-touch
 * allowed). Colors aren't deduplicated across designs — the user
 * picks species per design.
 */
export interface Design {
  /** Stable client-side UUID — used for React keys, drag tracking, and save/load. */
  id: string;
  vector: VectorData;
  woodConfigs: WoodConfig[];
  placement: Placement;
}

/** A snapshot of all layers at one point in history. */
export interface LayerSnapshot {
  layers: Layer[];
  /** Short label describing how this snapshot was produced. */
  label: string;
  /**
   * Cached analysis result for this snapshot, if one has been computed.
   * Stored on the snapshot so that undo/redo can restore the previously
   * shown analysis without re-running the (potentially slow) analysis.
   * Cleared when settings or layer order change, since those invalidate
   * any previously-computed result.
   */
  result?: AnalysisResult;
}

export interface SingleAnalysis {
  fullDepthPercent: number;
  problemAreaPercent: number;
  passed: boolean;
  hasAnyFullDepth: boolean;
  /** True when an entire connected component of the carved mask cannot reach full depth — a piece of the design is too small/narrow for the V-bit. */
  hasIsolatedUnreachableComponent: boolean;
  vbitAngleWarning: boolean;
  thinWallPixelCount: number;
  /** Threshold-overlay PNG built at the user's currently-selected v-bit angle. Used by Step 3 (V-bit) where the user is consciously evaluating one angle. */
  overlayDataUrl: string;
  /**
   * Centroid + size of each connected problem-area component shown on
   * `overlayDataUrl`. Used by the issue-locator badge layer to point a
   * tiny, easy-to-miss flagged region out to the user. Coordinates are
   * in canvas pixel space (same as the overlay PNG dimensions). Empty
   * when there are no problem regions.
   */
  problemComponents: { cx: number; cy: number; areaPx: number }[];
  /**
   * Suggestions overlay PNG built at the *largest feasible* v-bit angle for
   * the whole design, with regions that block the next wider preset shown
   * in teal. Used by Step 2 (DFM) so the user — who hasn't yet picked an
   * angle — sees the design at its best with widening suggestions, not red
   * errors against an arbitrary default angle. Empty string when no
   * feasible angle exists.
   */
  suggestionOverlayDataUrl: string;
  depthMapDataUrl: string;
}

/**
 * Per-pixel mask of regions a *wider* (faster) v-bit cannot reach.
 *
 * These are areas the artist could widen so a wider, faster bit becomes
 * feasible — i.e., the next preset above the largest currently-feasible
 * angle. Null when the largest feasible preset is already 120° (there is
 * no wider preset to upgrade to) or when no angle is feasible at all.
 *
 * Mask geometry matches the analysis canvas (canvasW × canvasH).
 */
export interface WiderBitInfeasibleMask {
  /** The preset angle that cannot reach these pixels. */
  angleDegrees: number;
  pocket: Uint8Array;
  plug: Uint8Array;
}

/**
 * Angle-dependent subset of SingleAnalysis. One entry per preset v-bit
 * angle is cached on each WoodAnalysis so Step 3 can swap the displayed
 * overlay/depth-map and refresh stats without re-running the analysis.
 *
 * Angle-INDEPENDENT fields (thinWallPixelCount, suggestionOverlayDataUrl)
 * stay on the parent SingleAnalysis and are reused as-is.
 */
export type PerPresetSingleSide = Pick<
  SingleAnalysis,
  | 'fullDepthPercent'
  | 'problemAreaPercent'
  | 'passed'
  | 'hasAnyFullDepth'
  | 'hasIsolatedUnreachableComponent'
  | 'vbitAngleWarning'
  | 'overlayDataUrl'
  | 'depthMapDataUrl'
  | 'problemComponents'
>;

export interface PerPresetAngleResult {
  angleDegrees: number;
  pocket: PerPresetSingleSide;
  plug: PerPresetSingleSide;
}

export interface WoodAnalysis {
  colorHex: string;
  pocket: SingleAnalysis;
  plug: SingleAnalysis;
  /**
   * Per-preset v-bit angle stats + overlay PNGs. Indexed in the same order
   * as VBIT_PRESET_ANGLES. Step 3 reads from this so changing the picked
   * angle is an instant URL swap, no re-analysis required.
   */
  perPresetAnalysis: PerPresetAngleResult[];
  /**
   * Regions only reachable by an infeasible *wider* v-bit. Used in Step 2
   * (DFM) to surface artist-improvement opportunities — widening any of
   * these regions lets the design upgrade to a wider, faster bit.
   */
  widerBitInfeasibleMask: WiderBitInfeasibleMask | null;
  /**
   * When NO v-bit preset is feasible for the design, this carries the
   * pocket/plug problem masks at the *sharpest* preset (the closest the
   * design can get to manufacturable). The guided quote view uses these
   * as the data source for the red "widen these or it can't be carved"
   * overlay PNG and the locator badges. Null when at least one preset
   * is feasible — the wider-bit suggestion data takes over instead.
   */
  irreducibleProblemMask: { pocket: Uint8Array; plug: Uint8Array } | null;
  /** Non-empty when this inlay's edge is too close to a later inlay (staged alignment risk). */
  alignmentIssues: AlignmentIssue[];
  /** Pocket area the clearance bit can reach (square inches). */
  clearanceAreaSqIn: number;
  /** Pocket area the V-bit must handle because the clearance bit can't fit there (square inches). */
  vbitAreaSqIn: number;
  /** Approximate perimeter of the pocket / plug shape (linear inches). Same value used for both V-bit perimeter passes. */
  perimeterIn: number;
  /** Plug carved area (stock around the plug) the clearance bit can reach (square inches). */
  plugClearanceAreaSqIn: number;
  /** Plug carved area the V-bit must handle (square inches). */
  plugVbitAreaSqIn: number;
  /** SVG path fragment outlining the modeled plug stock boundary, ready to drop into a per-layer SVG. Empty when no stock is computable. */
  plugStockOutlineSvg: string;
  /** Number of holes in this layer that are completely covered by the union of later inlay layers. */
  fillableHoleCount: number;
  /** Total area (in²) of those fillable holes. */
  fillableHoleAreaSqIn: number;
  /** Estimated machining time saved by filling these holes (minutes). NaN when V-bit rates are missing. */
  fillableSavedTimeMin: number;
  /**
   * Estimated plug-stock area required to carve this layer's plug pieces,
   * in square inches. Computed as the sum of oriented-bounding-box areas
   * over the connected components of (pocketMask dilated by ~0.51"). Used
   * by the guided quote pipeline to charge a fractional sheet cost when
   * an inlay's plugs would consume only part of a stock sheet.
   */
  plugStockUsageSqIn: number;
  /** Estimated minutes for the pocket cut (clearance + V-bit area + V-bit perimeter). */
  pocketMachineTimeMinutes: number;
  /** Estimated minutes for the plug cut (modeled identically to the pocket; same shape, same depth). */
  plugMachineTimeMinutes: number;
  /** Pocket + plug. NaN when the V-bit rates are unavailable (custom angle without user-supplied MRR/feed). */
  layerMachineTimeMinutes: number;
}

/**
 * One clearance-bit strategy. Bits are listed largest-to-smallest in the
 * order they would be run on the CNC. Empty array = no clearance pass,
 * the v-bit clears the entire pocket. Use one of these per matrix row.
 */
export interface ClearanceStrategy {
  /** Bit diameters in inches, sorted descending. Empty = v-bit only. */
  diameters: number[];
  /** Display label like "1/2" → 1/4"" or "V-bit only". */
  label: string;
  /** Number of distinct bits used = clearance count + 1 v-bit. Drives the tool-change overhead at display time. */
  bitCount: number;
}

/** Comparison matrix of machining times across (clearance strategy × v-bit angle). */
export interface MachiningTimeMatrix {
  /** All 2^N subsets of the available clearance bits, plus the empty strategy (v-bit only). Ordered by bit count then descending diameter list. */
  strategies: ClearanceStrategy[];
  vbits: {
    angleDegrees: number;
    mrr: number;
    feed: number;
    /** False when this angle yields >10% problem area on some pocket or plug. */
    feasible: boolean;
    /** Worst-case problem-area percent across all (layer × side) pairs at this angle. Used for Step 3 button annotations. */
    maxProblemAreaPercent: number;
    /** True when at least one (layer × side) pair has an isolated component that can't reach full depth. */
    hasIsolatedComponent: boolean;
  }[];
  /**
   * Active cutting time in minutes per (strategy × vbit), excluding
   * tool-change overhead. Total wall time = `cuttingTimes[si][vi] +
   * strategies[si].bitCount * toolChangeMinutes`. Computing total at
   * render time means the ATC/Manual toggle is reactive without
   * re-running analysis. NaN when the v-bit angle is infeasible or
   * when v-bit rates are unavailable.
   */
  cuttingTimes: number[][];
  /**
   * Per-layer disaggregation of `cuttingTimes`. `layerCuttingTimes[L][si][vi]`
   * is the cutting time contributed by layer L for the (strategy si,
   * vbit vi) cell, summing to `cuttingTimes[si][vi]` across L. Used by
   * the guided pipeline's per-layer v-bit picker (`pickPerLayerBitPlan`)
   * to combine different v-bits across layers without re-running
   * machining-time computation. NaN propagates when the v-bit is
   * infeasible at the design level.
   */
  layerCuttingTimes: number[][][];
}

export interface AnalysisResult {
  woods: WoodAnalysis[];
  /** Shared geometry params (same for all woods) */
  vbitCutWidthInches: number;
  fullDepthRadiusInches: number;
  thinWallThresholdInches: number;
  alignmentThresholdInches: number;
  pixelsPerInch: number;
  /**
   * Pixel dimensions of the analysis canvas every per-wood mask is
   * sized to. Exposed so consumers (overlay renderers, badge centroid
   * extractors) don't have to re-derive the same numbers from the
   * vector and pixelsPerInch — and so the guided flow's variable
   * resolution doesn't break the assumption that the canvas was
   * always 1200 × N.
   */
  canvasW: number;
  canvasH: number;
  /**
   * Largest preset v-bit angle that is feasible for the whole design (≤10%
   * problem area on every side AND no isolated unreachable component).
   * Each wood's `suggestionOverlayDataUrl` is rendered at this angle.
   * Null when no preset is feasible — Step 2 has no clean baseline to
   * display and falls back to the user-angle threshold overlay.
   */
  step2DisplayAngleDegrees: number | null;
  /**
   * Next-wider preset above `step2DisplayAngleDegrees`. The `widerBitInfeasibleMask`
   * on each wood is computed at this angle and shown in teal as an
   * artist-improvement suggestion. Null when `step2DisplayAngleDegrees` is
   * already the widest preset (120°) or when no preset is feasible.
   */
  step2SuggestionAngleDegrees: number | null;
  /** Total estimated machining time across all layers (pocket + plug each). NaN when V-bit rates are missing. */
  totalMachineTimeMinutes: number;
  /** In-use rates so the UI can show what produced the time estimate. */
  clearanceBitDiameterInches: number;
  clearanceMRR: number;
  /** May be NaN when the user-set custom-angle V-bit rates are missing. */
  vbitMRR: number;
  vbitFeed: number;
  /** All-combination time comparison (preset clearance × preset V-bit angles). */
  machiningTimeTable: MachiningTimeMatrix;
}

// Re-export the guided-quote board types so callers can import them via
// `@/types`. Vite's path resolution doesn't auto-resolve `@/types/board`
// (no index.ts at that subpath), so re-exports keep paths uniform.
export type {
  BoardWoodKey, BoardSided, JuiceGroove, EdgeTreatment, HandleStyle, BoardConfig,
} from './board';
export { DEFAULT_BOARD_CONFIG, TOP_GROOVE_INLAY_MARGIN_INCHES, hasTopGroove } from './board';
