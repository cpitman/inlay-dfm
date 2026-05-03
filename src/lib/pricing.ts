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

/**
 * Per-side aggregate the cost computation needs. The carving order
 * within one side is decided by the optimizer; the aggregate flattens
 * everything down to "what costs to charge for this side."
 */
export interface SideAggregate {
  /** Sum of per-design cutting time (machining minutes) for designs
   *  on THIS side. Excludes tool-change overhead. */
  totalCuttingMinutes: number;
  /** Tool-change overhead for the union of bits used on THIS side. */
  jointToolChangeMinutes: number;
  /** Distinct wood species across this side's designs. */
  uniqueSpeciesCount: number;
  /** Per-species plug-stock OBB area (in²), summed across this
   *  side's designs + slots. The 70%-of-sheet packing threshold is
   *  applied per species per side — same species used on the OTHER
   *  side has its OWN sheet. */
  plugStockUsageBySpecies: Map<string, number>;
}

/** Empty side aggregate — used when one face has no designs. */
export const EMPTY_SIDE_AGGREGATE: SideAggregate = {
  totalCuttingMinutes: 0,
  jointToolChangeMinutes: 0,
  uniqueSpeciesCount: 0,
  plugStockUsageBySpecies: new Map(),
};

export interface QuoteInput {
  boardConfig: BoardConfig;
  /**
   * Per-side cost aggregates. The board cost itself is one-time
   * (not split by side); inlay material + per-inlay machining + per-
   * inlay labor are summed across both sides per the rules below.
   */
  perSide: { top: SideAggregate; bottom: SideAggregate };
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
  const { boardConfig, perSide } = input;
  const { top, bottom } = perSide;

  // Per-side species totals (used for labor + machining premiums).
  const sumPerSide = top.uniqueSpeciesCount + bottom.uniqueSpeciesCount;
  // Defensive: a side that's entirely infeasible reports NaN cutting
  // minutes from the optimizer. The guided caller in QuoteApp sanitizes
  // before calling, but bound the failure mode here too so a future
  // caller that forgets doesn't end up rendering "$NaN" in the price.
  // The `noFeasibleAngle` flag on the optimizer aggregate is the right
  // signal for "approximate quote"; this just keeps the math finite.
  const safe = (n: number): number => (Number.isFinite(n) ? n : 0);
  const totalCuttingMinutes    = safe(top.totalCuttingMinutes)    + safe(bottom.totalCuttingMinutes);
  const totalToolChangeMinutes = safe(top.jointToolChangeMinutes) + safe(bottom.jointToolChangeMinutes);

  // Materials. Per-species inlay cost with packing-aware scaling
  // applied PER SIDE: a species' plug-stock OBB area on the top is
  // summed only against the top sheet; same on the bottom. Same
  // species used on both sides => two separate sheets (each can hit
  // its own 70% threshold or be prorated).
  const baseDollars = BASE_BOARD_PRICE[boardConfig.wood];
  const inlayDollarsForSide = (s: SideAggregate): number => {
    let total = 0;
    for (const [species, usage] of s.plugStockUsageBySpecies) {
      const fullPrice = INLAY_WOOD_PRICE[species] ?? 0;
      const utilization = usage / INLAY_SHEET_AREA_SQ_IN;
      if (utilization > INLAY_PACKING_THRESHOLD) total += fullPrice;
      else                                        total += utilization * fullPrice;
    }
    return total;
  };
  const inlayDollars = inlayDollarsForSide(top) + inlayDollarsForSide(bottom);
  const materialsDollars = baseDollars + inlayDollars;

  // Machine time premiums. Per-inlay charge is per UNIQUE SPECIES
  // PER SIDE, summed across sides — each side is a separate carving
  // session with its own bit-load + alignment overhead.
  const grooveSides =
    boardConfig.juiceGroove === 'both' ? 2 :
    boardConfig.juiceGroove === 'none' ? 0 : 1;
  const handlesMinutes =
    boardConfig.handles === 'inset'     ? MACHINE_MIN_INSET_HANDLES :
    boardConfig.handles === 'underside' ? MACHINE_MIN_UNDERSIDE_HANDLES :
    0;
  const machineMinutes = totalCuttingMinutes
    + totalToolChangeMinutes
    + MACHINE_MIN_PER_INLAY        * sumPerSide
    + MACHINE_MIN_PER_GROOVE_SIDE  * grooveSides
    + handlesMinutes;
  const machineDollars = (machineMinutes / 60) * MACHINE_HOURLY;

  // Labor: setup + per-species-per-side + finishing. Setup and
  // finishing are one-time board-wide blocks; the per-species labor
  // counts each side's species independently and sums across sides
  // (same species on both sides → two labor blocks, since they're
  // physically separate carvings).
  const laborMinutes = LABOR_MIN_SETUP
    + LABOR_MIN_PER_INLAY * sumPerSide
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
