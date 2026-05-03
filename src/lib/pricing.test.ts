import { describe, it, expect } from 'vitest';
import {
  computeQuote, BASE_BOARD_PRICE, INLAY_WOOD_PRICE, ADDON_FEET, LABOR_HOURLY,
  INLAY_SHEET_AREA_SQ_IN, INLAY_PACKING_THRESHOLD,
  type QuoteInput,
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
 * Convenience: build a `QuoteInput` for a quote with the given list of
 * species (one slot per species, no plug-stock data so each charges
 * full sheet price). Useful for "single-design" style tests.
 */
function speciesInput(
  species: string[],
  overrides: Partial<QuoteInput> = {},
): QuoteInput {
  // Default plug-stock map: every species is treated as full sheet
  // (= sum > threshold) so the test math doesn't have to know the
  // packing fraction. Tests can override per-species usage as needed.
  const plugStock = new Map<string, number>();
  for (const sp of species) plugStock.set(sp, INLAY_SHEET_AREA_SQ_IN);
  return {
    boardConfig: BASE_CHERRY_BOARD,
    totalCuttingMinutes: 0,
    jointToolChangeMinutes: 0,
    uniqueSpeciesCount: new Set(species).size,
    plugStockUsageBySpecies: plugStock,
    ...overrides,
  };
}

describe('computeQuote', () => {
  it('returns lowDollars and highDollars rounded to nearest $10', () => {
    const q = computeQuote(speciesInput(['walnut'], { totalCuttingMinutes: 30 }));
    expect(q.lowDollars  % 10).toBe(0);
    expect(q.highDollars % 10).toBe(0);
    expect(q.highDollars).toBeGreaterThan(q.lowDollars);
  });

  it('range is 90% to 125% of the pre-round total', () => {
    const q = computeQuote(speciesInput(['walnut'], { totalCuttingMinutes: 30 }));
    const total = q.breakdown.totalEstimate;
    expect(q.lowDollars).toBeCloseTo(Math.round((total * 0.90) / 10) * 10);
    expect(q.highDollars).toBeCloseTo(Math.round((total * 1.25) / 10) * 10);
  });

  it('materials sum base board + each unique species', () => {
    const q = computeQuote(speciesInput(['walnut', 'purpleheart']));
    const expected = BASE_BOARD_PRICE.cherry
      + INLAY_WOOD_PRICE.walnut
      + INLAY_WOOD_PRICE.purpleheart;
    expect(q.breakdown.materialsDollars).toBe(expected);
  });

  it('per-inlay machine-time premium scales with UNIQUE SPECIES (not slot count)', () => {
    // 1 species → 1 × 30 min premium.
    const q1 = computeQuote(speciesInput(['walnut']));
    // 3 species → 3 × 30 min premium. +60 min vs q1.
    const q3 = computeQuote(speciesInput(['walnut', 'maple', 'cherry']));
    expect(q3.breakdown.machineMinutes - q1.breakdown.machineMinutes).toBe(60);
  });

  it('two slots of the same species count as one species for premiums + labor', () => {
    // Two designs each with one walnut slot → uniqueSpeciesCount = 1.
    const q = computeQuote(speciesInput(['walnut'], { uniqueSpeciesCount: 1 }));
    expect(q.breakdown.machineMinutes).toBe(30); // 1 × 30 min
    expect(q.breakdown.laborMinutes).toBe(30 + 30 + 90); // setup + 1 × per-inlay + finishing
  });

  it('adds groove minutes per side: top=10, bottom=10, both=20', () => {
    const none = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'none' } });
    const top  = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'top'  } });
    const both = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'both' } });
    expect(top.breakdown.machineMinutes  - none.breakdown.machineMinutes).toBe(10);
    expect(both.breakdown.machineMinutes - none.breakdown.machineMinutes).toBe(20);
  });

  it('adds inset handles 20 min, underside 10 min', () => {
    const none      = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, handles: 'none'      } });
    const inset     = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, handles: 'inset'     } });
    const underside = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, handles: 'underside' } });
    expect(inset.breakdown.machineMinutes     - none.breakdown.machineMinutes).toBe(20);
    expect(underside.breakdown.machineMinutes - none.breakdown.machineMinutes).toBe(10);
  });

  it('labor is 30 + 30N + 90 minutes where N = unique species', () => {
    const q = computeQuote(speciesInput(['walnut', 'maple']));
    expect(q.breakdown.laborMinutes).toBe(30 + 30 * 2 + 90);
    expect(q.breakdown.laborDollars).toBeCloseTo((30 + 30 * 2 + 90) / 60 * LABOR_HOURLY, 6);
  });

  it('feet add-on adds $30; dual-sided does not', () => {
    const feet = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, sided: 'feet' } });
    const dual = computeQuote({ ...speciesInput(['walnut']), boardConfig: { ...BASE_CHERRY_BOARD, sided: 'dual' } });
    expect(feet.breakdown.addOnDollars).toBe(ADDON_FEET);
    expect(dual.breakdown.addOnDollars).toBe(0);
    expect(feet.breakdown.totalEstimate - dual.breakdown.totalEstimate).toBeCloseTo(ADDON_FEET, 6);
  });

  it('plug-stock summed area at 50% of sheet → 50% of full inlay price', () => {
    const q = computeQuote({
      ...speciesInput(['walnut']),
      plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * 0.5]]),
    });
    const expected = BASE_BOARD_PRICE.cherry + 0.5 * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('plug-stock summed above 70% → full sheet price', () => {
    const q = computeQuote({
      ...speciesInput(['walnut']),
      plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * (INLAY_PACKING_THRESHOLD + 0.05)]]),
    });
    expect(q.breakdown.materialsDollars).toBe(BASE_BOARD_PRICE.cherry + INLAY_WOOD_PRICE.walnut);
  });

  it('plug-stock summed at exactly 70% → fractional path (boundary inclusive of fractional)', () => {
    const q = computeQuote({
      ...speciesInput(['walnut']),
      plugStockUsageBySpecies: new Map([['walnut', INLAY_SHEET_AREA_SQ_IN * INLAY_PACKING_THRESHOLD]]),
    });
    const expected = BASE_BOARD_PRICE.cherry + INLAY_PACKING_THRESHOLD * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('mixes per-species scaling: one fractional, one full', () => {
    const q = computeQuote({
      ...speciesInput(['walnut', 'maple']),
      plugStockUsageBySpecies: new Map([
        ['walnut', INLAY_SHEET_AREA_SQ_IN * 0.1],
        ['maple',  INLAY_SHEET_AREA_SQ_IN * 0.85],
      ]),
    });
    const expected = BASE_BOARD_PRICE.cherry
      + 0.1 * INLAY_WOOD_PRICE.walnut
      + INLAY_WOOD_PRICE.maple;
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('summed plug stock across designs: 50% + 30% → 80% > threshold → full price', () => {
    // Two designs each contributing walnut plug stock. Together they
    // exceed the 70% threshold even though individually they would not.
    // The threshold applies to the SUM, so the full sheet price kicks in.
    const q = computeQuote({
      ...speciesInput(['walnut']),
      plugStockUsageBySpecies: new Map([
        ['walnut', INLAY_SHEET_AREA_SQ_IN * (0.5 + 0.3)],
      ]),
    });
    expect(q.breakdown.materialsDollars).toBe(BASE_BOARD_PRICE.cherry + INLAY_WOOD_PRICE.walnut);
  });

  it('omitting a species from plugStockUsageBySpecies → $0 for that species', () => {
    // No plug-stock entry → no inlay cost for that species. (Caller is
    // expected to populate the map with at least sheet-area when no
    // measurement is available.)
    const q = computeQuote({
      ...speciesInput([]),
      uniqueSpeciesCount: 1,
      plugStockUsageBySpecies: new Map(), // empty
    });
    // Materials = base only.
    expect(q.breakdown.materialsDollars).toBe(BASE_BOARD_PRICE.cherry);
  });

  it('machineMinutes = totalCutting + jointToolChange + per-feature premiums', () => {
    const q = computeQuote(speciesInput(['walnut'], {
      totalCuttingMinutes: 60,
      jointToolChangeMinutes: 15,
    }));
    // 60 cutting + 15 joint overhead + 30 per-inlay (1 species × 30) = 105 min.
    expect(q.breakdown.machineMinutes).toBe(105);
    expect(q.breakdown.machineDollars).toBeCloseTo((105 / 60) * 80, 6); // MACHINE_HOURLY = 80
  });

  it('joint tool-change overhead replaces summed per-design overhead', () => {
    // Caller is expected to subtract per-design tool changes from
    // cuttingMinutes (or pass cuttingTime only). jointToolChangeMinutes
    // is purely additive.
    const q1 = computeQuote(speciesInput(['walnut'], { totalCuttingMinutes: 60, jointToolChangeMinutes: 0 }));
    const q2 = computeQuote(speciesInput(['walnut'], { totalCuttingMinutes: 60, jointToolChangeMinutes: 20 }));
    expect(q2.breakdown.machineMinutes - q1.breakdown.machineMinutes).toBe(20);
  });
});
