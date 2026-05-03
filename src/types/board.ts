import type { WoodSpeciesKey } from './index';

/**
 * Board-wood options offered in the guided quote experience. Smaller set
 * than the inlay species — these are the woods we stock as base boards.
 */
export type BoardWoodKey = Extract<WoodSpeciesKey, 'maple' | 'walnut' | 'cherry'>;

/** Whether the board has feet on its bottom or is finished on both sides. */
export type BoardSided = 'dual' | 'feet';

/** Where the (top-view) juice groove(s) are routed. */
export type JuiceGroove = 'none' | 'top' | 'bottom' | 'both';

/** Edge profile cut around the board's perimeter. */
export type EdgeTreatment = 'chamfer' | 'roundover';

/** Handle style. Inset handles are visible from the top; underside pockets aren't. */
export type HandleStyle = 'none' | 'inset' | 'underside';

/** Full board configuration captured from Step 1 of the guided flow. */
export interface BoardConfig {
  wood: BoardWoodKey;
  sided: BoardSided;
  juiceGroove: JuiceGroove;
  edge: EdgeTreatment;
  handles: HandleStyle;
  /** Inches. For now fixed at 12; will become a dropdown in the future. */
  widthInches: number;
  /** Inches. For now fixed at 18. */
  heightInches: number;
}

/** Default board for a fresh /quote session — landscape 18×12. */
export const DEFAULT_BOARD_CONFIG: BoardConfig = {
  wood: 'maple',
  sided: 'feet',
  juiceGroove: 'none',
  edge: 'roundover',
  handles: 'none',
  widthInches: 18,
  heightInches: 12,
};

/**
 * Inlay margin (in inches) required when a top-side juice groove is
 * present. The art's bounding box must stay inside `(boardW − 2*margin)
 * × (boardH − 2*margin)` so the carve doesn't intersect the groove path.
 */
export const TOP_GROOVE_INLAY_MARGIN_INCHES = 1.0;
/**
 * Same margin as the top groove — the bottom groove takes the same
 * 1/4"–1" perimeter band, so back-side inlays must clear it by 1".
 */
export const BOTTOM_GROOVE_INLAY_MARGIN_INCHES = 1.0;

/** True iff the board has a top-side juice groove. */
export function hasTopGroove(g: JuiceGroove): boolean {
  return g === 'top' || g === 'both';
}

/** True iff the board has a bottom-side juice groove. */
export function hasBottomGroove(g: JuiceGroove): boolean {
  return g === 'bottom' || g === 'both';
}

/** Diameter of each foot, in inches. */
export const FOOT_DIAMETER_INCHES = 1.0;
/** Inset of the foot's outer edge from the board's edge, in inches. */
export const FOOT_EDGE_INSET_INCHES = 0.25;
/** Underside-handle pocket dimensions, in inches. */
export const UNDERSIDE_HANDLE_DEPTH_INCHES  = 1.0; // perpendicular to the edge
export const UNDERSIDE_HANDLE_LENGTH_INCHES = 5.0; // parallel to the short edge

/** Minimal AABB shape used by the inlay-overlap detector. Coordinates
 *  are in board inches, top-left origin. Mirrors `src/lib/aabb.ts`. */
export interface FeatureAabb { x: number; y: number; w: number; h: number }

/**
 * AABBs of the four feet (when `sided === 'feet'`), in board-inch
 * coordinates. Each foot is a 1"-diameter circle with its outer edge
 * 1/4" from the board edge → bounding box is 1×1, centered at
 * `(0.75, 0.75)` etc. Empty array when no feet.
 */
export function feetAabbs(config: BoardConfig): FeatureAabb[] {
  if (config.sided !== 'feet') return [];
  const w = config.widthInches, h = config.heightInches;
  const d = FOOT_DIAMETER_INCHES;
  const inset = FOOT_EDGE_INSET_INCHES;
  return [
    { x: inset,         y: inset,         w: d, h: d },
    { x: w - inset - d, y: inset,         w: d, h: d },
    { x: inset,         y: h - inset - d, w: d, h: d },
    { x: w - inset - d, y: h - inset - d, w: d, h: d },
  ];
}

/**
 * AABBs of the two underside-handle pockets, flush with the short
 * (12"-tall) left and right edges, centered vertically. Each pocket is
 * 1" deep into the board × 5" along the edge. Empty array unless
 * `handles === 'underside'`.
 */
export function undersideHandleAabbs(config: BoardConfig): FeatureAabb[] {
  if (config.handles !== 'underside') return [];
  const w = config.widthInches, h = config.heightInches;
  const dep = UNDERSIDE_HANDLE_DEPTH_INCHES;
  const len = UNDERSIDE_HANDLE_LENGTH_INCHES;
  const y0 = (h - len) / 2;
  return [
    { x: 0,       y: y0, w: dep, h: len },
    { x: w - dep, y: y0, w: dep, h: len },
  ];
}

/**
 * Back-side fixed AABBs that inlays must avoid: feet + underside
 * handles. The bottom juice groove enforces a 1" margin via
 * `BOTTOM_GROOVE_INLAY_MARGIN_INCHES` and isn't part of this list.
 */
export function backSideFeatureAabbs(config: BoardConfig): FeatureAabb[] {
  return [...feetAabbs(config), ...undersideHandleAabbs(config)];
}
