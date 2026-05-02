import type { BoardWoodKey, BoardConfig } from '@/types/board';
import type { WoodConfig } from '@/types';

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

export interface QuoteInput {
  boardConfig: BoardConfig;
  woodConfigs: WoodConfig[];
  /**
   * Total machining minutes from the optimizer (already includes tool-
   * change overhead at the chosen strategy). Per-feature premiums are
   * added on top by `computeQuote`.
   */
  totalMachineMinutes: number;
}

export interface QuoteBreakdown {
  /** Sum of base-board cost and per-inlay material cost. */
  materialsDollars: number;
  /** Total machine minutes including the per-feature premiums. */
  machineMinutes: number;
  machineDollars: number;
  /** Setup + per-inlay + finishing minutes. */
  laborMinutes: number;
  laborDollars: number;
  /** Add-on dollar total (e.g., feet). */
  addOnDollars: number;
  /** Pre-rounding total estimate. The display range is derived from this. */
  totalEstimate: number;
}

export interface QuoteResult {
  /** Lower bound = round(totalEstimate × 0.90 / 10) × 10. */
  lowDollars: number;
  /** Upper bound = round(totalEstimate × 1.25 / 10) × 10. */
  highDollars: number;
  breakdown: QuoteBreakdown;
}

/**
 * Compute a price-range estimate for a guided-flow board + inlay
 * configuration. Uses the per-spec pricing constants above:
 *   total = materials + machine + labor + add-ons
 *   range = round( total × {0.90, 1.25} / 10 ) × 10
 *
 * `totalMachineMinutes` should already include tool-change overhead at
 * the chosen clearance strategy (see `findFastestFeasibleCell`'s
 * `totalTimeMinutes`). Per-feature minute premiums (per-inlay, juice
 * groove, handles) are added here.
 */
export function computeQuote(input: QuoteInput): QuoteResult {
  const { boardConfig, woodConfigs, totalMachineMinutes } = input;

  // Materials.
  const baseDollars  = BASE_BOARD_PRICE[boardConfig.wood];
  const inlayDollars = woodConfigs.reduce(
    (s, wc) => s + (INLAY_WOOD_PRICE[wc.species] ?? 0),
    0,
  );
  const materialsDollars = baseDollars + inlayDollars;

  // Machine time premiums.
  const grooveSides =
    boardConfig.juiceGroove === 'both' ? 2 :
    boardConfig.juiceGroove === 'none' ? 0 : 1;
  const handlesMinutes =
    boardConfig.handles === 'inset'     ? MACHINE_MIN_INSET_HANDLES :
    boardConfig.handles === 'underside' ? MACHINE_MIN_UNDERSIDE_HANDLES :
    0;
  const machineMinutes = totalMachineMinutes
    + MACHINE_MIN_PER_INLAY        * woodConfigs.length
    + MACHINE_MIN_PER_GROOVE_SIDE  * grooveSides
    + handlesMinutes;
  const machineDollars = (machineMinutes / 60) * MACHINE_HOURLY;

  // Labor: setup + per-inlay + finishing.
  const laborMinutes = LABOR_MIN_SETUP
    + LABOR_MIN_PER_INLAY * woodConfigs.length
    + LABOR_MIN_FINISHING;
  const laborDollars = (laborMinutes / 60) * LABOR_HOURLY;

  // Add-ons.
  const addOnDollars = boardConfig.sided === 'feet' ? ADDON_FEET : 0;

  const totalEstimate = materialsDollars + machineDollars + laborDollars + addOnDollars;

  return {
    lowDollars:  Math.round((totalEstimate * 0.90) / 10) * 10,
    highDollars: Math.round((totalEstimate * 1.25) / 10) * 10,
    breakdown: {
      materialsDollars,
      machineMinutes,
      machineDollars,
      laborMinutes,
      laborDollars,
      addOnDollars,
      totalEstimate,
    },
  };
}
