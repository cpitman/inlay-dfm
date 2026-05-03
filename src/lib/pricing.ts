import type { BoardWoodKey, BoardConfig } from '@/types/board';

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

/**
 * Square-inch area of one inlay-stock sheet (the price tables above
 * are quoted per full sheet of this size).
 */
export const INLAY_SHEET_AREA_SQ_IN = 18 * 12;

/**
 * Above this fraction of a sheet, packing optimization is ignored —
 * the plug pieces would consume so much of the sheet that the
 * remainder isn't reusable, so the customer is charged the full
 * sheet price.
 */
export const INLAY_PACKING_THRESHOLD = 0.70;

export interface QuoteInput {
  boardConfig: BoardConfig;
  /**
   * Sum of per-design cutting time (machining minutes) across every
   * design on the board. Excludes tool-change overhead — that's
   * tracked separately so the caller can deduplicate bits across
   * designs.
   */
  totalCuttingMinutes: number;
  /**
   * Tool-change overhead minutes after deduplicating clearance bits
   * and v-bit angles across all designs. See
   * `jointToolChangeOverhead` in `machiningTime.ts`.
   */
  jointToolChangeMinutes: number;
  /**
   * Distinct wood species across every design's `woodConfigs`. Drives
   * both the per-inlay machining premium and the per-inlay labor
   * minutes — both are charged once per species, not once per color
   * slot. Two slots both mapped to walnut count once.
   */
  uniqueSpeciesCount: number;
  /**
   * Per-species plug-stock OBB area, in square inches, summed across
   * every design + color slot that uses that species. The 70%-of-
   * sheet packing threshold is applied to this **sum** per species:
   *   - Sum > 70% → charged the full per-species sheet price.
   *   - Sum ≤ 70% → charged a fraction of the sheet price.
   * Species absent from the map contribute $0 (e.g. when the optimizer
   * couldn't measure plug stock for that species).
   */
  plugStockUsageBySpecies: Map<string, number>;
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
 * Inputs are aggregated across all designs on the board. The caller
 * (typically the quote optimizer) sums per-design cutting time,
 * computes joint tool-change overhead via `jointToolChangeOverhead`,
 * and groups plug-stock usage by species. `computeQuote` itself only
 * applies the per-feature premiums and the per-species threshold to
 * those aggregates.
 */
export function computeQuote(input: QuoteInput): QuoteResult {
  const {
    boardConfig,
    totalCuttingMinutes,
    jointToolChangeMinutes,
    uniqueSpeciesCount,
    plugStockUsageBySpecies,
  } = input;

  // Materials. Per-species inlay cost with packing-aware scaling: a
  // species' plug-stock OBB area is summed across every slot in every
  // design that uses it. If the sum is ≤ 70% of a 12×18" sheet, the
  // customer is charged the fraction (the remainder is reusable for
  // other orders). Above 70% → full sheet price.
  const baseDollars = BASE_BOARD_PRICE[boardConfig.wood];
  let inlayDollars = 0;
  for (const [species, usage] of plugStockUsageBySpecies) {
    const fullPrice = INLAY_WOOD_PRICE[species] ?? 0;
    const utilization = usage / INLAY_SHEET_AREA_SQ_IN;
    if (utilization > INLAY_PACKING_THRESHOLD) inlayDollars += fullPrice;
    else                                       inlayDollars += utilization * fullPrice;
  }
  const materialsDollars = baseDollars + inlayDollars;

  // Machine time premiums. Per-inlay charge is per UNIQUE SPECIES,
  // not per color slot — two slots mapped to walnut share one bit
  // load, one alignment pass, one stock setup.
  const grooveSides =
    boardConfig.juiceGroove === 'both' ? 2 :
    boardConfig.juiceGroove === 'none' ? 0 : 1;
  const handlesMinutes =
    boardConfig.handles === 'inset'     ? MACHINE_MIN_INSET_HANDLES :
    boardConfig.handles === 'underside' ? MACHINE_MIN_UNDERSIDE_HANDLES :
    0;
  const machineMinutes = totalCuttingMinutes
    + jointToolChangeMinutes
    + MACHINE_MIN_PER_INLAY        * uniqueSpeciesCount
    + MACHINE_MIN_PER_GROOVE_SIDE  * grooveSides
    + handlesMinutes;
  const machineDollars = (machineMinutes / 60) * MACHINE_HOURLY;

  // Labor: setup + per-species + finishing. Same per-species rule:
  // multiple slots of the same species can be cut, glued, and
  // sanded in one batch — one labor block.
  const laborMinutes = LABOR_MIN_SETUP
    + LABOR_MIN_PER_INLAY * uniqueSpeciesCount
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
