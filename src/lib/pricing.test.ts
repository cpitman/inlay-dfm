import { describe, it, expect } from 'vitest';
import {
  computeQuote, BASE_BOARD_PRICE, INLAY_WOOD_PRICE, ADDON_FEET, LABOR_HOURLY,
  INLAY_SHEET_AREA_SQ_IN, INLAY_PACKING_THRESHOLD,
  EMPTY_SIDE_AGGREGATE,
  type QuoteInput, type SideAggregate,
} from './pricing';
import { DEFAULT_BOARD_CONFIG, type BoardConfig } from '../types/board';

const BASE_CHERRY_BOARD: BoardConfig = {
  ...DEFAULT_BOARD_CONFIG,
  wood: 'cherry',
  juiceGroove: 'none',
  edge: 'roundover',
  handles: 'none',
  sided: 'feet',
};

/**
 * Build a side aggregate with the given list of species. Each species
 * defaults to "1 full sheet" of plug-stock usage so the test math
 * doesn't have to deal with the packing fraction unless it wants to.
 */
function side(species: string[], overrides: Partial<SideAggregate> = {}): SideAggregate {
  const plugStock = new Map<string, number>();
  for (const sp of species) plugStock.set(sp, INLAY_SHEET_AREA_SQ_IN);
  return {
    totalCuttingMinutes: 0,
    jointToolChangeMinutes: 0,
    uniqueSpeciesCount: new Set(species).size,
    plugStockUsageBySpecies: plugStock,
    ...overrides,
  };
}

/**
 * Convenience: single-side quote (everything on top). Used by tests
 * that don't care about the back side.
 */
function topOnlyInput(
  species: string[],
  topOverrides: Partial<SideAggregate> = {},
  inputOverrides: Partial<QuoteInput> = {},
): QuoteInput {
  return {
    boardConfig: BASE_CHERRY_BOARD,
    perSide: { top: side(species, topOverrides), bottom: EMPTY_SIDE_AGGREGATE },
    ...inputOverrides,
  };
}

describe('computeQuote — single-side cases', () => {
  it('returns lowDollars and highDollars rounded to nearest $10', () => {
    const q = computeQuote(topOnlyInput(['walnut'], { totalCuttingMinutes: 30 }));
    expect(q.lowDollars  % 10).toBe(0);
    expect(q.highDollars % 10).toBe(0);
    expect(q.highDollars).toBeGreaterThan(q.lowDollars);
  });

  it('range is 90% to 125% of the pre-round total', () => {
    const q = computeQuote(topOnlyInput(['walnut'], { totalCuttingMinutes: 30 }));
    const total = q.breakdown.totalEstimate;
    expect(q.lowDollars).toBeCloseTo(Math.round((total * 0.90) / 10) * 10);
    expect(q.highDollars).toBeCloseTo(Math.round((total * 1.25) / 10) * 10);
  });

  it('materials sum base board + each unique species', () => {
    const q = computeQuote(topOnlyInput(['walnut', 'purpleheart']));
    const expected = BASE_BOARD_PRICE.cherry
      + INLAY_WOOD_PRICE.walnut
      + INLAY_WOOD_PRICE.purpleheart;
    expect(q.breakdown.materialsDollars).toBe(expected);
  });

  it('per-inlay machine-time premium scales with UNIQUE SPECIES (not slot count)', () => {
    const q1 = computeQuote(topOnlyInput(['walnut']));
    const q3 = computeQuote(topOnlyInput(['walnut', 'maple', 'cherry']));
    expect(q3.breakdown.machineMinutes - q1.breakdown.machineMinutes).toBe(60);
  });

  it('two slots of the same species count as one species for premiums + labor', () => {
    const q = computeQuote(topOnlyInput(['walnut'], {}, {}));
    expect(q.breakdown.machineMinutes).toBe(30);
    expect(q.breakdown.laborMinutes).toBe(30 + 30 + 90);
  });

  it('adds groove minutes per side: top=10, bottom=10, both=20', () => {
    const baseW = topOnlyInput(['walnut']);
    const none = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'none' } });
    const top  = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'top'  } });
    const both = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'both' } });
    expect(top.breakdown.machineMinutes  - none.breakdown.machineMinutes).toBe(10);
    expect(both.breakdown.machineMinutes - none.breakdown.machineMinutes).toBe(20);
  });

  it('adds inset handles 20 min, underside 10 min', () => {
    const baseW = topOnlyInput(['walnut']);
    const none      = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, handles: 'none'      } });
    const inset     = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, handles: 'inset'     } });
    const underside = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, handles: 'underside' } });
    expect(inset.breakdown.machineMinutes     - none.breakdown.machineMinutes).toBe(20);
    expect(underside.breakdown.machineMinutes - none.breakdown.machineMinutes).toBe(10);
  });

  it('labor is 30 + 30N + 90 minutes where N = unique species (summed across sides)', () => {
    const q = computeQuote(topOnlyInput(['walnut', 'maple']));
    expect(q.breakdown.laborMinutes).toBe(30 + 30 * 2 + 90);
    expect(q.breakdown.laborDollars).toBeCloseTo((30 + 30 * 2 + 90) / 60 * LABOR_HOURLY, 6);
  });

  it('feet add-on adds $30; dual-sided does not', () => {
    const baseW = topOnlyInput(['walnut']);
    const feet = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, sided: 'feet' } });
    const dual = computeQuote({ ...baseW, boardConfig: { ...BASE_CHERRY_BOARD, sided: 'dual' } });
    expect(feet.breakdown.addOnDollars).toBe(ADDON_FEET);
    expect(dual.breakdown.addOnDollars).toBe(0);
  });

  it('plug-stock summed area at 50% of sheet → 50% of full inlay price', () => {
    const q = computeQuote(topOnlyInput(['walnut'], {
      uniqueSpeciesCount: 1,
      plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * 0.5]]),
    }));
    const expected = BASE_BOARD_PRICE.cherry + 0.5 * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('plug-stock summed above 70% → full sheet price', () => {
    const q = computeQuote(topOnlyInput(['walnut'], {
      uniqueSpeciesCount: 1,
      plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * (INLAY_PACKING_THRESHOLD + 0.05)]]),
    }));
    expect(q.breakdown.materialsDollars).toBe(BASE_BOARD_PRICE.cherry + INLAY_WOOD_PRICE.walnut);
  });

  it('machineMinutes = totalCutting + jointToolChange + per-feature premiums', () => {
    const q = computeQuote(topOnlyInput(['walnut'], { totalCuttingMinutes: 60, jointToolChangeMinutes: 15 }));
    expect(q.breakdown.machineMinutes).toBe(60 + 15 + 30);
    expect(q.breakdown.machineDollars).toBeCloseTo((105 / 60) * 80, 6);
  });
});

describe('computeQuote — two-sided cases', () => {
  it('walnut on both sides: labor counts walnut twice (one per side)', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: {
        top:    side(['walnut']),
        bottom: side(['walnut']),
      },
    });
    // Setup + 2 species (one per side) + finishing.
    expect(q.breakdown.laborMinutes).toBe(30 + 30 * 2 + 90);
    // Same for machining premium: 2 × 30 = 60 min for the two species.
    expect(q.breakdown.machineMinutes).toBe(60);
  });

  it('walnut twice on the SAME side: counts once for that side', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: {
        top:    side(['walnut'], { uniqueSpeciesCount: 1 }), // 2 slots → 1 species
        bottom: EMPTY_SIDE_AGGREGATE,
      },
    });
    expect(q.breakdown.laborMinutes).toBe(30 + 30 * 1 + 90);
    expect(q.breakdown.machineMinutes).toBe(30);
  });

  it('cutting + tool-change overhead sum across sides', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: {
        top:    side(['walnut'], { totalCuttingMinutes: 30, jointToolChangeMinutes: 10 }),
        bottom: side(['walnut'], { totalCuttingMinutes: 20, jointToolChangeMinutes: 5  }),
      },
    });
    // Per-side cutting + per-side overhead + 2-species premium.
    expect(q.breakdown.machineMinutes).toBe((30 + 10) + (20 + 5) + (30 * 2));
  });

  it('inlay material threshold applied PER SIDE (50% top + 50% bottom => no full-sheet trip)', () => {
    // Same species (walnut) used on both sides at 50% utilization each.
    // Old (single-side) model would have summed to 100% > 70% → full
    // sheet. Per-side rule keeps each at 50% prorated.
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: {
        top: {
          totalCuttingMinutes: 0, jointToolChangeMinutes: 0, uniqueSpeciesCount: 1,
          plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * 0.5]]),
        },
        bottom: {
          totalCuttingMinutes: 0, jointToolChangeMinutes: 0, uniqueSpeciesCount: 1,
          plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * 0.5]]),
        },
      },
    });
    const expectedInlay = 0.5 * INLAY_WOOD_PRICE.walnut + 0.5 * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(BASE_BOARD_PRICE.cherry + expectedInlay, 6);
  });

  it('threshold trips per side independently', () => {
    // Top: 80% walnut → over threshold → full sheet.
    // Bottom: 30% walnut → under → prorated 30%.
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: {
        top: {
          totalCuttingMinutes: 0, jointToolChangeMinutes: 0, uniqueSpeciesCount: 1,
          plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * 0.80]]),
        },
        bottom: {
          totalCuttingMinutes: 0, jointToolChangeMinutes: 0, uniqueSpeciesCount: 1,
          plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * 0.30]]),
        },
      },
    });
    const expectedInlay = INLAY_WOOD_PRICE.walnut + 0.30 * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(BASE_BOARD_PRICE.cherry + expectedInlay, 6);
  });

  it('groove + handles premiums are board-wide (not per side)', () => {
    // Two-sided quote with juice-groove "both". 'both' = 2 sides → 20 min.
    const q = computeQuote({
      boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'both' },
      perSide: {
        top:    side(['walnut']),
        bottom: side(['maple']),
      },
    });
    const noGroove = computeQuote({
      boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'none' },
      perSide: {
        top:    side(['walnut']),
        bottom: side(['maple']),
      },
    });
    expect(q.breakdown.machineMinutes - noGroove.breakdown.machineMinutes).toBe(20);
  });

  it('treats a side with NaN cutting minutes as 0 — guard against optimizer NaN leakage', () => {
    // The optimizer marks a side infeasible by setting NaN on the
    // aggregate. The caller is supposed to sanitize, but computeQuote
    // bounds the failure mode itself so a forgetful caller doesn't
    // render "$NaN" to the user.
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: {
        top: {
          totalCuttingMinutes: NaN,
          jointToolChangeMinutes: NaN,
          uniqueSpeciesCount: 1,
          plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN]]),
        },
        bottom: EMPTY_SIDE_AGGREGATE,
      },
    });
    expect(Number.isFinite(q.breakdown.machineMinutes)).toBe(true);
    expect(Number.isFinite(q.breakdown.totalEstimate)).toBe(true);
    expect(Number.isFinite(q.lowDollars)).toBe(true);
    expect(Number.isFinite(q.highDollars)).toBe(true);
    // Per-feature premium for the 1 species still applies; cutting +
    // tool-change minutes are 0.
    expect(q.breakdown.machineMinutes).toBe(30);
  });

  it('one-time labor blocks (setup + finishing) are NOT doubled by adding a back side', () => {
    // Single-side walnut.
    const single = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: { top: side(['walnut']), bottom: EMPTY_SIDE_AGGREGATE },
    });
    // Two-side walnut: one species per side. Labor goes from
    // setup + 1*per-inlay + finishing → setup + 2*per-inlay + finishing
    // (only the per-inlay block doubles; setup + finishing stay).
    const two = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      perSide: { top: side(['walnut']), bottom: side(['walnut']) },
    });
    expect(two.breakdown.laborMinutes - single.breakdown.laborMinutes).toBe(30);
  });
});
