import type { BoardWoodKey } from '@/types/board';

/**
 * Manufacturing price tables for the guided "Get a quote" experience.
 * Numbers are placeholder estimates — see plan for the cost model.
 *
 * The full `computeQuote` helper is added in PR D once the optimization
 * pipeline produces a machining-time number to feed into it. For now,
 * Step 1 only needs the per-feature dollar values to surface inline
 * cost hints (e.g. "Inset handles +$X").
 */

/** Base-board cost per stocked species, in dollars. */
export const BASE_BOARD_PRICE: Record<BoardWoodKey, number> = {
  maple:  85,
  walnut: 110,
  cherry: 106,
};

/** Inlay-stock cost per offered species, in dollars per inlay. */
export const INLAY_WOOD_PRICE: Record<string, number> = {
  maple:       30,
  cherry:      30,
  walnut:      35,
  purpleheart: 76,
  padauk:      45,
};

/** Species offered for inlay color slots in the guided UX. */
export const INLAY_WOOD_OPTIONS: readonly string[] =
  ['maple', 'cherry', 'walnut', 'purpleheart', 'padauk'] as const;

/** Hourly rates used by the cost model. */
export const MACHINE_HOURLY = 80;
export const LABOR_HOURLY   = 40;

/** Machine-time premium per inlay color (bit-change handling, alignment). */
export const MACHINE_MIN_PER_INLAY = 30;
/** Per-side juice-groove machine time. */
export const MACHINE_MIN_PER_GROOVE_SIDE = 10;
/** Inset handles add this much machine time. */
export const MACHINE_MIN_INSET_HANDLES = 20;
/** Underside-pocket handles add this much machine time. */
export const MACHINE_MIN_UNDERSIDE_HANDLES = 10;

/** Manual labor: setup + per-inlay + finishing. */
export const LABOR_MIN_SETUP      = 30;
export const LABOR_MIN_PER_INLAY  = 30;
export const LABOR_MIN_FINISHING  = 90;

/** Flat add-ons. */
export const ADDON_FEET = 30;
