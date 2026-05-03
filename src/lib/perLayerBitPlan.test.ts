import { describe, it, expect } from 'vitest';
import {
  enumerateClearanceStrategies,
  pickPerLayerBitPlan,
} from './machiningTime';
import type { MachiningTimeMatrix, PerPresetAngleResult, PerPresetSingleSide } from '../types';

const VBIT_ANGLES = [15, 30, 45, 60, 90, 120];

/** Construct a feasible PerPresetSingleSide for a given angle. */
function feasibleSide(): PerPresetSingleSide {
  return {
    fullDepthPercent: 100,
    problemAreaPercent: 0,
    passed: true,
    hasAnyFullDepth: true,
    hasIsolatedUnreachableComponent: false,
    vbitAngleWarning: false,
    overlayDataUrl: '',
    depthMapDataUrl: '',
    problemComponents: [],
  };
}

/** Construct an infeasible PerPresetSingleSide (with isolated component). */
function infeasibleSide(): PerPresetSingleSide {
  return {
    fullDepthPercent: 50,
    problemAreaPercent: 30,            // > 10% threshold
    passed: false,
    hasAnyFullDepth: false,
    hasIsolatedUnreachableComponent: true,
    vbitAngleWarning: false,
    overlayDataUrl: '',
    depthMapDataUrl: '',
    problemComponents: [],
  };
}

/**
 * Build a PerPresetAngleResult[] for a single layer where the layer is
 * feasible at every angle in `feasibleAngles` (and infeasible elsewhere).
 */
function layerPresets(feasibleAngles: number[]): PerPresetAngleResult[] {
  return VBIT_ANGLES.map(angle => ({
    angleDegrees: angle,
    pocket: feasibleAngles.includes(angle) ? feasibleSide() : infeasibleSide(),
    plug:   feasibleAngles.includes(angle) ? feasibleSide() : infeasibleSide(),
  }));
}

/** Build a minimal matrix where every cell has a fixed cutting time per layer. */
function makeMatrix(opts: {
  numLayers: number;
  /** Per-layer cutting time at each (strategy, vbit). Defaults to 10 min flat. */
  layerCutting?: (layerIdx: number, strategyIdx: number, vbitIdx: number) => number;
}): MachiningTimeMatrix {
  const strategies = enumerateClearanceStrategies([0.5, 0.25, 0.125]);
  const vbits = VBIT_ANGLES.map(a => ({
    angleDegrees: a, mrr: 1, feed: 30,
    feasible: true, maxProblemAreaPercent: 0, hasIsolatedComponent: false,
  }));
  const layerCutting = opts.layerCutting ?? (() => 10);
  const layerCuttingTimes: number[][][] = Array.from({ length: opts.numLayers }, (_, li) =>
    strategies.map((_, si) => vbits.map((_, vi) => layerCutting(li, si, vi)))
  );
  // cuttingTimes is the per-cell sum.
  const cuttingTimes: number[][] = strategies.map((_, si) =>
    vbits.map((_, vi) => {
      let total = 0;
      for (let li = 0; li < opts.numLayers; li++) total += layerCuttingTimes[li][si][vi];
      return total;
    })
  );
  return { strategies, vbits, cuttingTimes, layerCuttingTimes };
}

describe('pickPerLayerBitPlan', () => {
  it('picks the widest feasible angle for every layer when all are unconstrained', () => {
    // 3 layers, all feasible at every angle → all layers should pick 120°.
    const matrix = makeMatrix({ numLayers: 3 });
    const presets: PerPresetAngleResult[][] = [
      layerPresets(VBIT_ANGLES),
      layerPresets(VBIT_ANGLES),
      layerPresets(VBIT_ANGLES),
    ];
    const plan = pickPerLayerBitPlan(matrix, presets, 5);
    expect(plan).not.toBeNull();
    expect(plan!.perLayerVbitAngles).toEqual([120, 120, 120]);
    expect(plan!.distinctVbitCount).toBe(1);
  });

  it('uses different angles per layer when their feasibility differs', () => {
    // Layer 0 is constrained to ≤ 30°, layer 1 to ≤ 60°, layer 2 to ≤ 120°.
    // Picker should pick 30° / 60° / 120° respectively.
    const matrix = makeMatrix({ numLayers: 3 });
    const presets: PerPresetAngleResult[][] = [
      layerPresets([15, 30]),
      layerPresets([15, 30, 45, 60]),
      layerPresets(VBIT_ANGLES),
    ];
    const plan = pickPerLayerBitPlan(matrix, presets, 5);
    expect(plan).not.toBeNull();
    expect(plan!.perLayerVbitAngles).toEqual([30, 60, 120]);
    expect(plan!.distinctVbitCount).toBe(3);
  });

  it('returns null when at least one layer has no feasible preset', () => {
    const matrix = makeMatrix({ numLayers: 2 });
    const presets: PerPresetAngleResult[][] = [
      layerPresets(VBIT_ANGLES), // all feasible
      layerPresets([]),          // none feasible
    ];
    const plan = pickPerLayerBitPlan(matrix, presets, 5);
    expect(plan).toBeNull();
  });

  it('total time = cutting + (clearance bits + distinct v-bits) × toolChange', () => {
    // 2 layers, feasible at all angles, flat 10 min per cell.
    // Strategy 0 = ∅ (0 clearance bits), strategy 1 = [0.5] (1 clearance bit).
    // With 1 distinct v-bit and 5 min/swap:
    //   strategy 0: cutting=20 (10×2), tool changes = (0 + 1) * 5 = 5, total = 25.
    //   strategy 1: cutting=20, tool changes = (1 + 1) * 5 = 10, total = 30.
    // Picker should pick strategy 0 since cutting ties but overhead is lower.
    const matrix = makeMatrix({ numLayers: 2 });
    const presets: PerPresetAngleResult[][] = [
      layerPresets(VBIT_ANGLES),
      layerPresets(VBIT_ANGLES),
    ];
    const plan = pickPerLayerBitPlan(matrix, presets, 5);
    expect(plan).not.toBeNull();
    expect(plan!.strategyDiameters).toEqual([]); // V-bit only
    expect(plan!.cuttingTimeMinutes).toBe(20);
    expect(plan!.toolChangeOverheadMinutes).toBe(5); // (0 + 1) * 5
    expect(plan!.totalTimeMinutes).toBe(25);
  });

  it('two-distinct-v-bits costs (clearance + 2) × toolChange', () => {
    // 2 layers, layer 0 constrained to 30°, layer 1 free.
    // Free layer picks 120°, constrained picks 30° → 2 distinct v-bits.
    // V-bit-only strategy → tool changes = (0 + 2) × 5 = 10 min.
    const matrix = makeMatrix({ numLayers: 2 });
    const presets: PerPresetAngleResult[][] = [
      layerPresets([15, 30]),
      layerPresets(VBIT_ANGLES),
    ];
    const plan = pickPerLayerBitPlan(matrix, presets, 5);
    expect(plan).not.toBeNull();
    expect(plan!.distinctVbitCount).toBe(2);
    expect(plan!.toolChangeOverheadMinutes).toBe((plan!.strategyDiameters.length + 2) * 5);
  });

  it('prefers a wider strategy when the clearance savings beat the extra tool change', () => {
    // 2 layers. Set layerCuttingTimes so strategy 1 ([0.5]) saves
    // 100 min of cutting vs strategy 0 (∅). One extra clearance bit
    // adds (1 + 1) × 5 = 10 min vs 0's (0 + 1) × 5 = 5 min — net 5 min
    // overhead for the wider strategy. Should still pick strategy 1
    // since cutting savings (100) > overhead delta (5).
    const matrix = makeMatrix({
      numLayers: 2,
      layerCutting: (_li, si /*, vi */) => si === 0 ? 100 : 50, // strategy 0 slow, 1 fast
    });
    const presets: PerPresetAngleResult[][] = [
      layerPresets(VBIT_ANGLES),
      layerPresets(VBIT_ANGLES),
    ];
    const plan = pickPerLayerBitPlan(matrix, presets, 5);
    expect(plan).not.toBeNull();
    expect(plan!.strategyDiameters.length).toBeGreaterThan(0);
  });

  it('returns null for an empty layer list', () => {
    const matrix = makeMatrix({ numLayers: 0 });
    const plan = pickPerLayerBitPlan(matrix, [], 5);
    expect(plan).toBeNull();
  });
});
