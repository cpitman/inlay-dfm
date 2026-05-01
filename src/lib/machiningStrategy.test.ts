import { describe, it, expect } from 'vitest';
import {
  enumerateClearanceStrategies,
  totalCellTime,
  findFastestFeasibleCell,
  clearanceBitLabel,
} from './machiningTime';
import type { MachiningTimeMatrix } from '@/types';

describe('clearanceBitLabel', () => {
  it('formats the canonical fractional sizes', () => {
    expect(clearanceBitLabel(0.125)).toBe('1/8"');
    expect(clearanceBitLabel(0.25)).toBe('1/4"');
    expect(clearanceBitLabel(0.5)).toBe('1/2"');
  });
  it('falls back to a 3-decimal numeric form', () => {
    expect(clearanceBitLabel(0.375)).toBe('0.375"');
  });
});

describe('enumerateClearanceStrategies', () => {
  it('produces 2^N + nothing-extra for N bits', () => {
    expect(enumerateClearanceStrategies([0.5, 0.25, 0.125])).toHaveLength(8);
    expect(enumerateClearanceStrategies([0.25])).toHaveLength(2);
    expect(enumerateClearanceStrategies([])).toHaveLength(1);
  });

  it('first entry is the empty strategy (V-bit only)', () => {
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    expect(strategies[0]).toEqual({
      diameters: [],
      label: 'V-bit only',
      bitCount: 1,
    });
  });

  it('orders bits within each subset descending', () => {
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    for (const s of strategies) {
      const sorted = [...s.diameters].sort((a, b) => b - a);
      expect(s.diameters).toEqual(sorted);
    }
  });

  it('orders subsets by bit count then by descending-diameter lex', () => {
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    expect(strategies.map(s => s.diameters)).toEqual([
      [],
      [0.5],
      [0.25],
      [0.125],
      [0.5, 0.25],
      [0.5, 0.125],
      [0.25, 0.125],
      [0.5, 0.25, 0.125],
    ]);
  });

  it('labels multi-bit strategies with arrow separators', () => {
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    const all3 = strategies.find(s => s.diameters.length === 3)!;
    expect(all3.label).toBe('1/2" → 1/4" → 1/8"');
    const twoBig = strategies.find(s =>
      s.diameters.length === 2 && s.diameters[0] === 0.5 && s.diameters[1] === 0.25,
    )!;
    expect(twoBig.label).toBe('1/2" → 1/4"');
  });

  it('bitCount is clearance count + 1 (the v-bit)', () => {
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    expect(strategies.find(s => s.diameters.length === 0)!.bitCount).toBe(1);
    expect(strategies.find(s => s.diameters.length === 1)!.bitCount).toBe(2);
    expect(strategies.find(s => s.diameters.length === 3)!.bitCount).toBe(4);
  });
});

// Helper: minimal matrix with a few preset rows/cols and known cuttingTimes.
function makeMatrix(opts: {
  cuttingByCell: number[][]; // [strategyIdx][vbitIdx]
  feasibility?: boolean[];   // per vbit; defaults all true
}): MachiningTimeMatrix {
  const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
  // Pad cuttingTimes to all-NaN if caller passed fewer rows.
  const rows = strategies.length;
  const cols = opts.cuttingByCell[0]?.length ?? 6;
  const cuttingTimes: number[][] = Array.from({ length: rows }, (_, si) =>
    opts.cuttingByCell[si] ?? Array(cols).fill(NaN),
  );
  const vbits = Array.from({ length: cols }, (_, i) => ({
    angleDegrees: [15, 30, 45, 60, 90, 120][i] ?? 60,
    mrr: 1, feed: 30,
    feasible: opts.feasibility?.[i] ?? true,
    maxProblemAreaPercent: 0,
    hasIsolatedComponent: false,
  }));
  return { strategies, vbits, cuttingTimes };
}

describe('totalCellTime', () => {
  it('adds bitCount × toolChangeMinutes to cutting time', () => {
    const matrix = makeMatrix({
      cuttingByCell: [[10, 8, 6, 5, 4, 3]],
    });
    // strategy 0 = V-bit only, bitCount=1; vbit 3 = cutting 5 min; tool change 5
    expect(totalCellTime(matrix, 0, 3, 5)).toBeCloseTo(5 + 1 * 5);
    expect(totalCellTime(matrix, 0, 3, 0.5)).toBeCloseTo(5 + 1 * 0.5);
  });

  it('returns NaN when cutting time is NaN', () => {
    const matrix = makeMatrix({ cuttingByCell: [[NaN, 8, 6, 5, 4, 3]] });
    expect(totalCellTime(matrix, 0, 0, 5)).toBeNaN();
  });

  it('scales overhead with the strategy bit count', () => {
    const cutting = 10;
    const matrix = makeMatrix({
      cuttingByCell: enumerateClearanceStrategies([0.5, 0.25, 0.125])
        .map(() => [cutting]),
    });
    // strategy 0 = ∅ (1 bit), strategy 7 = all three (4 bits)
    const tcm = 5;
    expect(totalCellTime(matrix, 0, 0, tcm)).toBeCloseTo(cutting + 1 * tcm);
    expect(totalCellTime(matrix, 7, 0, tcm)).toBeCloseTo(cutting + 4 * tcm);
  });
});

describe('findFastestFeasibleCell', () => {
  it('returns null when no v-bit is feasible', () => {
    const matrix = makeMatrix({
      cuttingByCell: [[1, 1, 1, 1, 1, 1]],
      feasibility:   [false, false, false, false, false, false],
    });
    expect(findFastestFeasibleCell(matrix, 5)).toBeNull();
  });

  it('picks the smallest (cutting + tool-change overhead) total', () => {
    // Custom cuttingTimes per (strategyIdx × vbitIdx). Easier to design by
    // hand using empty strategy (bitCount=1) only.
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    const vbits = [
      { angleDegrees: 15, mrr: 1, feed: 30, feasible: true,  maxProblemAreaPercent: 0, hasIsolatedComponent: false },
      { angleDegrees: 30, mrr: 1, feed: 30, feasible: true,  maxProblemAreaPercent: 0, hasIsolatedComponent: false },
    ];
    // 8 strategies × 2 vbits. Strategy 0 (empty, 1 bit) cell (0,1) = 5.
    // Strategy 4 ([0.5,0.25], 3 bits) cell (4,0) = 1 (very fast cut).
    // With toolChange=5: total at (0,1) = 5+5=10; at (4,0) = 1+15=16.
    // → fastest is (0,1).
    const cuttingTimes: number[][] = strategies.map(() => [99, 99]);
    cuttingTimes[0][1] = 5;
    cuttingTimes[4][0] = 1;
    const matrix: MachiningTimeMatrix = { strategies, vbits, cuttingTimes };
    const best = findFastestFeasibleCell(matrix, 5);
    expect(best).not.toBeNull();
    expect(best!.strategyIdx).toBe(0);
    expect(best!.vbitIdx).toBe(1);
    expect(best!.totalTimeMinutes).toBeCloseTo(10);
  });

  it('picks differently as toolChangeMinutes changes (ATC vs Manual)', () => {
    const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
    const vbits = [
      { angleDegrees: 60, mrr: 1, feed: 30, feasible: true, maxProblemAreaPercent: 0, hasIsolatedComponent: false },
    ];
    // Strategy 0 (empty, 1 bit): slow but no tool changes.
    // Strategy 7 (all three, 4 bits): fast cut but big tool-change penalty.
    const cuttingTimes: number[][] = strategies.map(() => [Number.NaN]);
    cuttingTimes[0][0] = 30;
    cuttingTimes[7][0] = 10;

    const matrix: MachiningTimeMatrix = { strategies, vbits, cuttingTimes };

    // ATC: 0.5 min/change. Strategy 7 total = 10 + 4*0.5 = 12. Strategy 0 = 30 + 0.5 = 30.5. Strategy 7 wins.
    const atcBest = findFastestFeasibleCell(matrix, 0.5);
    expect(atcBest!.strategyIdx).toBe(7);

    // Manual: 5 min/change. Strategy 7 total = 10 + 4*5 = 30. Strategy 0 = 30 + 5 = 35. Strategy 7 still wins (barely).
    const manualBest = findFastestFeasibleCell(matrix, 5);
    expect(manualBest!.strategyIdx).toBe(7);

    // Very expensive change: 10 min. Strategy 7 = 10 + 40 = 50. Strategy 0 = 30 + 10 = 40. Strategy 0 wins.
    const expensiveBest = findFastestFeasibleCell(matrix, 10);
    expect(expensiveBest!.strategyIdx).toBe(0);
  });
});
