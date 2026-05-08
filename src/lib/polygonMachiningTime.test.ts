import { describe, it, expect } from 'vitest';
import { polygonMachiningTime } from './polygonMachiningTime';
import type { MultiPolygon } from './polygon';

function square(x: number, y: number, side: number): MultiPolygon {
  return [[
    { x, y },
    { x: x + side, y },
    { x: x + side, y: y + side },
    { x, y: y + side },
  ]];
}

describe('polygonMachiningTime — covered-area formula', () => {
  it('single-bit clearance on a 100×100 square: covered = (side − 2R)² + 4(side − 2R) × R = side² − 4R²', () => {
    // 100×100 square (= 10×10 inches at duPerInch=10), 1/4" bit (= R = 0.125").
    // R in design units = 0.125 × 10 = 1.25.
    // Inward offset = 97.5×97.5 square. inwardArea = 9506.25, inwardPerimeter = 390.
    // coveredArea = 9506.25 + 390 × 1.25 = 9506.25 + 487.5 = 9993.75 sq units.
    // = closed-form 100² − 4 × 1.25² = 10000 − 6.25 = 9993.75. ✓
    // In sq inches: 9993.75 / 100 = 99.9375 sq in.
    const carved = square(0, 0, 100);
    const r = polygonMachiningTime({
      carvedMP: carved,
      perimeterUnits: 400,
      designUnitsPerInch: 10,
      clearanceBitDiametersIn: [0.25],
      clearanceMrrByDiameter: new Map([[0.25, 1.35]]),
      vbitFullDepthRadiusUnits: 0.5, // small v-bit reach (0.05" radius)
      vbitMrr: 0.10,
      vbitFeedInchesPerMin: 60,
      effectiveDepthIn: 0.25,
    });
    expect(r.clearanceAreaSqIn).toBeCloseTo(99.9375, 1);
    // V-bit incremental should be near zero (its R < clearance R).
    expect(r.vbitAreaSqIn).toBeLessThan(0.5);
    // Total time: clearance ≈ 99.9 × 0.25 / 1.35 ≈ 18.5 min, plus a small
    // v-bit perimeter pass (perimeter 400 design units = 40 in; 40/60 ≈ 0.67 min).
    expect(r.totalTimeMin).toBeGreaterThan(18);
    expect(r.totalTimeMin).toBeLessThan(20);
  });

  it('two-bit strategy: incremental areas subtract correctly', () => {
    // 10×10" square. 1/2" bit (R=0.25") + 1/4" bit (R=0.125").
    // 1/2" covered = 100 − 4 × 0.25² = 99.75 sq in (= 9975 sq units / 100).
    // 1/4" covered = 100 − 4 × 0.125² = 99.9375 sq in.
    // 1/4" incremental = 99.9375 − 99.75 = 0.1875 sq in.
    // 1/2" assigned = 99.75 sq in.
    const carved = square(0, 0, 100);
    const r = polygonMachiningTime({
      carvedMP: carved,
      perimeterUnits: 400,
      designUnitsPerInch: 10,
      clearanceBitDiametersIn: [0.5, 0.25],  // descending
      clearanceMrrByDiameter: new Map([[0.5, 7.0], [0.25, 1.35]]),
      vbitFullDepthRadiusUnits: 0.5,
      vbitMrr: 0.10,
      vbitFeedInchesPerMin: 60,
      effectiveDepthIn: 0.25,
    });
    // Combined clearance = 99.75 + 0.1875 ≈ 99.94.
    expect(r.clearanceAreaSqIn).toBeCloseTo(99.94, 1);
    // Multi-bit time should be MUCH less than single 1/4" because most
    // area moves to the 7.0-MRR 1/2" bit:
    //   t = 99.75 × 0.25 / 7.0 + 0.1875 × 0.25 / 1.35 + perimeter / 60
    //     ≈ 3.56 + 0.035 + 0.67 ≈ 4.27 min
    expect(r.totalTimeMin).toBeGreaterThan(4);
    expect(r.totalTimeMin).toBeLessThan(5);
  });

  it('returns zero for an empty carved polygon', () => {
    const r = polygonMachiningTime({
      carvedMP: [],
      perimeterUnits: 0,
      designUnitsPerInch: 10,
      clearanceBitDiametersIn: [0.25],
      clearanceMrrByDiameter: new Map([[0.25, 1.35]]),
      vbitFullDepthRadiusUnits: 0.5,
      vbitMrr: 0.10,
      vbitFeedInchesPerMin: 60,
      effectiveDepthIn: 0.25,
    });
    expect(r.totalTimeMin).toBe(0);
    expect(r.clearanceAreaSqIn).toBe(0);
    expect(r.vbitAreaSqIn).toBe(0);
  });

  it('returns clearance area = 0 when the bit is too big to fit anywhere', () => {
    // 10×10 design-unit square (= 1×1 inch at duPerInch=10),
    // 0.25" bit (= R=0.125" = 1.25 design units).
    // Pocket too small: inward offset by 1.25 in a 10-side square =
    // 7.5-side, OK. To force "too big": use a larger bit (= 2"
    // diameter, R=1"=10 du) in a 10-du pocket. Inward offset = empty.
    const r = polygonMachiningTime({
      carvedMP: square(0, 0, 10),
      perimeterUnits: 40,
      designUnitsPerInch: 10,
      clearanceBitDiametersIn: [2.0],
      clearanceMrrByDiameter: new Map([[2.0, 7.0]]),
      vbitFullDepthRadiusUnits: 0.5,
      vbitMrr: 0.10,
      vbitFeedInchesPerMin: 60,
      effectiveDepthIn: 0.25,
    });
    expect(r.clearanceAreaSqIn).toBe(0);
    // V-bit covered area is non-trivial.
    expect(r.vbitAreaSqIn).toBeGreaterThan(0);
  });

  it('larger pocket → larger clearance area (sanity)', () => {
    const r1 = polygonMachiningTime({
      carvedMP: square(0, 0, 50),
      perimeterUnits: 200,
      designUnitsPerInch: 10,
      clearanceBitDiametersIn: [0.25],
      clearanceMrrByDiameter: new Map([[0.25, 1.35]]),
      vbitFullDepthRadiusUnits: 0.5,
      vbitMrr: 0.10,
      vbitFeedInchesPerMin: 60,
      effectiveDepthIn: 0.25,
    });
    const r2 = polygonMachiningTime({
      carvedMP: square(0, 0, 100),
      perimeterUnits: 400,
      designUnitsPerInch: 10,
      clearanceBitDiametersIn: [0.25],
      clearanceMrrByDiameter: new Map([[0.25, 1.35]]),
      vbitFullDepthRadiusUnits: 0.5,
      vbitMrr: 0.10,
      vbitFeedInchesPerMin: 60,
      effectiveDepthIn: 0.25,
    });
    expect(r2.clearanceAreaSqIn).toBeGreaterThan(r1.clearanceAreaSqIn);
    expect(r2.totalTimeMin).toBeGreaterThan(r1.totalTimeMin);
  });
});
