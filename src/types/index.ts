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
  /** Diameter of the clearance/end-mill bit (1/8", 1/4", or 1/2"). Used for machining-time estimates. */
  clearanceBitDiameterInches: 0.125 | 0.25 | 0.5;
  /**
   * Margin around each plug's convex hull when modeling the plug stock for
   * machining-time estimates. Plug carved area = (convex hull of plug,
   * dilated by this margin) − (plug shape).
   */
  plugStockMarginInches: number;
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
  overlayDataUrl: string;
  depthMapDataUrl: string;
}

export interface WoodAnalysis {
  colorHex: string;
  pocket: SingleAnalysis;
  plug: SingleAnalysis;
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
  /** Estimated minutes for the pocket cut (clearance + V-bit area + V-bit perimeter). */
  pocketMachineTimeMinutes: number;
  /** Estimated minutes for the plug cut (modeled identically to the pocket; same shape, same depth). */
  plugMachineTimeMinutes: number;
  /** Pocket + plug. NaN when the V-bit rates are unavailable (custom angle without user-supplied MRR/feed). */
  layerMachineTimeMinutes: number;
}

/** Comparison matrix of total machining times across bit combinations. */
export interface MachiningTimeMatrix {
  clearanceBits: { diameterInches: number; mrr: number }[];
  vbits: {
    angleDegrees: number;
    mrr: number;
    feed: number;
    /** False when this angle yields >10% problem area on some pocket or plug. */
    feasible: boolean;
  }[];
  /** times[clearanceIdx][vbitIdx] = total minutes (pocket + plug summed). NaN when V-bit is infeasible. */
  times: number[][];
}

export interface AnalysisResult {
  woods: WoodAnalysis[];
  /** Shared geometry params (same for all woods) */
  vbitCutWidthInches: number;
  fullDepthRadiusInches: number;
  thinWallThresholdInches: number;
  alignmentThresholdInches: number;
  pixelsPerInch: number;
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
