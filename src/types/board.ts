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

/** True iff the board has a top-side juice groove. */
export function hasTopGroove(g: JuiceGroove): boolean {
  return g === 'top' || g === 'both';
}
