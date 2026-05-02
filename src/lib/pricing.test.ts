import { describe, it, expect } from 'vitest';
import {
  computeQuote, BASE_BOARD_PRICE, INLAY_WOOD_PRICE, ADDON_FEET, LABOR_HOURLY,
  INLAY_SHEET_AREA_SQ_IN, INLAY_PACKING_THRESHOLD,
} from './pricing';
import { DEFAULT_BOARD_CONFIG, type BoardConfig } from '../types/board';
import type { WoodConfig } from '../types';

const BASE_CHERRY_BOARD: BoardConfig = {
  ...DEFAULT_BOARD_CONFIG,
  wood: 'cherry',
  juiceGroove: 'none',
  edge: 'roundover',
  handles: 'none',
  sided: 'feet',
};

function makeWoods(species: string[]): WoodConfig[] {
  return species.map((sp, i) => ({
    colorHex: `#${(i + 1).toString(16).padStart(6, '0')}`,
    label: `${sp} ${i + 1}`,
    species: sp as WoodConfig['species'],
  }));
}

describe('computeQuote', () => {
  it('returns lowDollars and highDollars rounded to nearest $10', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 30,
    });
    expect(q.lowDollars  % 10).toBe(0);
    expect(q.highDollars % 10).toBe(0);
    expect(q.highDollars).toBeGreaterThan(q.lowDollars);
  });

  it('range is 90% to 125% of the pre-round total', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 30,
    });
    const total = q.breakdown.totalEstimate;
    expect(q.lowDollars).toBeCloseTo(Math.round((total * 0.90) / 10) * 10);
    expect(q.highDollars).toBeCloseTo(Math.round((total * 1.25) / 10) * 10);
  });

  it('materials sum base board + each inlay species', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut', 'purpleheart']),
      totalMachineMinutes: 0,
    });
    const expected = BASE_BOARD_PRICE.cherry
      + INLAY_WOOD_PRICE.walnut
      + INLAY_WOOD_PRICE.purpleheart;
    expect(q.breakdown.materialsDollars).toBe(expected);
  });

  it('adds 30 min of machine time per inlay color', () => {
    const baseTime = 0;
    const q1 = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: baseTime,
    });
    const q3 = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut', 'maple', 'cherry']),
      totalMachineMinutes: baseTime,
    });
    expect(q3.breakdown.machineMinutes - q1.breakdown.machineMinutes).toBe(60); // +2 inlays × 30 min
  });

  it('adds groove minutes per side: top=10, bottom=10, both=20', () => {
    const w = makeWoods(['walnut']);
    const none = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'none' }, woodConfigs: w, totalMachineMinutes: 0 });
    const top  = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'top'  }, woodConfigs: w, totalMachineMinutes: 0 });
    const both = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, juiceGroove: 'both' }, woodConfigs: w, totalMachineMinutes: 0 });
    expect(top.breakdown.machineMinutes  - none.breakdown.machineMinutes).toBe(10);
    expect(both.breakdown.machineMinutes - none.breakdown.machineMinutes).toBe(20);
  });

  it('adds inset handles 20 min, underside 10 min', () => {
    const w = makeWoods(['walnut']);
    const none      = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, handles: 'none'      }, woodConfigs: w, totalMachineMinutes: 0 });
    const inset     = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, handles: 'inset'     }, woodConfigs: w, totalMachineMinutes: 0 });
    const underside = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, handles: 'underside' }, woodConfigs: w, totalMachineMinutes: 0 });
    expect(inset.breakdown.machineMinutes     - none.breakdown.machineMinutes).toBe(20);
    expect(underside.breakdown.machineMinutes - none.breakdown.machineMinutes).toBe(10);
  });

  it('labor is 30 + 30N + 90 minutes at LABOR_HOURLY', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut', 'maple']),
      totalMachineMinutes: 0,
    });
    expect(q.breakdown.laborMinutes).toBe(30 + 30 * 2 + 90);
    expect(q.breakdown.laborDollars).toBeCloseTo((30 + 30 * 2 + 90) / 60 * LABOR_HOURLY, 6);
  });

  it('feet add-on adds $30; dual-sided does not', () => {
    const w = makeWoods(['walnut']);
    const feet = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, sided: 'feet' }, woodConfigs: w, totalMachineMinutes: 0 });
    const dual = computeQuote({ boardConfig: { ...BASE_CHERRY_BOARD, sided: 'dual' }, woodConfigs: w, totalMachineMinutes: 0 });
    expect(feet.breakdown.addOnDollars).toBe(ADDON_FEET);
    expect(dual.breakdown.addOnDollars).toBe(0);
    expect(feet.breakdown.totalEstimate - dual.breakdown.totalEstimate).toBeCloseTo(ADDON_FEET, 6);
  });

  it('plug-stock usage at 50% of sheet → 50% of full inlay price', () => {
    const halfSheet = INLAY_SHEET_AREA_SQ_IN * 0.5;
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 0,
      plugStockUsageSqIn: [halfSheet],
    });
    // Materials = base + 0.5 × walnut.
    const expected = BASE_BOARD_PRICE.cherry + 0.5 * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('plug-stock usage above 70% of sheet → full inlay price', () => {
    const justOverThreshold = INLAY_SHEET_AREA_SQ_IN * (INLAY_PACKING_THRESHOLD + 0.05);
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 0,
      plugStockUsageSqIn: [justOverThreshold],
    });
    const expected = BASE_BOARD_PRICE.cherry + INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBe(expected);
  });

  it('plug-stock usage exactly at 70% → fractional (boundary inclusive of fractional path)', () => {
    // Threshold is strictly greater-than: utilization > 0.70 → full price.
    // At exactly 0.70 utilization, the fractional path applies.
    const atThreshold = INLAY_SHEET_AREA_SQ_IN * INLAY_PACKING_THRESHOLD;
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 0,
      plugStockUsageSqIn: [atThreshold],
    });
    const expected = BASE_BOARD_PRICE.cherry + INLAY_PACKING_THRESHOLD * INLAY_WOOD_PRICE.walnut;
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('mixes per-inlay scaling: small layer fractional, big layer full', () => {
    const small = INLAY_SHEET_AREA_SQ_IN * 0.1;
    const big   = INLAY_SHEET_AREA_SQ_IN * 0.85;
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut', 'maple']),
      totalMachineMinutes: 0,
      plugStockUsageSqIn: [small, big],
    });
    const expected = BASE_BOARD_PRICE.cherry
      + 0.1 * INLAY_WOOD_PRICE.walnut   // small → fractional
      + INLAY_WOOD_PRICE.maple;         // big   → full
    expect(q.breakdown.materialsDollars).toBeCloseTo(expected, 6);
  });

  it('omitting plugStockUsageSqIn falls back to full sheet price (back-compat)', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 0,
    });
    expect(q.breakdown.materialsDollars).toBe(BASE_BOARD_PRICE.cherry + INLAY_WOOD_PRICE.walnut);
  });

  it('machine cost uses MACHINE_HOURLY', () => {
    const q = computeQuote({
      boardConfig: BASE_CHERRY_BOARD,
      woodConfigs: makeWoods(['walnut']),
      totalMachineMinutes: 60, // exactly 1 hour, plus per-inlay 30 min
    });
    // machine minutes = 60 + 30 (one inlay) = 90 → 1.5 × $80 = $120
    expect(q.breakdown.machineMinutes).toBe(90);
    expect(q.breakdown.machineDollars).toBeCloseTo(120, 6);
  });
});
