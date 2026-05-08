import { describe, it, expect } from 'vitest';
import { polygonThinWalls } from './polygonThinWalls';
import { multiPolygonArea, multiPolygonIsEmpty, type MultiPolygon } from './polygon';

const bounds = { x0: 0, y0: 0, x1: 100, y1: 100 };

/** Two carved bars at x = [10, 20] and [22, 32], with a 2-wide un-carved gap between them. */
function twoVerticalBars(): MultiPolygon {
  return [
    [
      { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 100 }, { x: 10, y: 100 },
    ],
    [
      { x: 22, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 100 }, { x: 22, y: 100 },
    ],
  ];
}

describe('polygonThinWalls', () => {
  it('detects a thin un-carved vertical strip between two carved bars (grain=horizontal)', () => {
    // grain=horizontal → thin walls run vertically → scan rows.
    // At each row y, the carved hits are at x=10..20 and 22..32.
    // The un-carved interval [20, 22] is BOUNDED and 2 wide < threshold 5.
    const r = polygonThinWalls(twoVerticalBars(), {
      grainDirection: 'horizontal',
      thresholdUnits: 5,
      designBounds: bounds,
      sampleStepUnits: 1,
    });
    expect(multiPolygonIsEmpty(r)).toBe(false);
    // Thin region area ≈ 2 wide × 100 tall = 200.
    expect(multiPolygonArea(r)).toBeGreaterThan(180);
    expect(multiPolygonArea(r)).toBeLessThan(220);
  });

  it('does not flag the un-carved area to the left of the first carved bar', () => {
    // The interval [bounds.x0, 10] is un-carved but unbounded on the left.
    // It should NOT be flagged even though it's narrow at y=0..100.
    // Make the gap smaller than the left-margin to confirm: bars at [60,70]
    // and [73, 83]. Left margin is 60 wide (= NOT thin), gap is 3 wide (= thin).
    const carved: MultiPolygon = [
      [{ x: 60, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 100 }, { x: 60, y: 100 }],
      [{ x: 73, y: 0 }, { x: 83, y: 0 }, { x: 83, y: 100 }, { x: 73, y: 100 }],
    ];
    const r = polygonThinWalls(carved, {
      grainDirection: 'horizontal',
      thresholdUnits: 5,
      designBounds: bounds,
      sampleStepUnits: 1,
    });
    // Only the [70, 73] gap is bounded + thin.
    expect(multiPolygonArea(r)).toBeGreaterThan(280);
    expect(multiPolygonArea(r)).toBeLessThan(320);
  });

  it('returns empty for grain=end', () => {
    const r = polygonThinWalls(twoVerticalBars(), {
      grainDirection: 'end',
      thresholdUnits: 5,
      designBounds: bounds,
    });
    expect(multiPolygonIsEmpty(r)).toBe(true);
  });

  it('grain=vertical scans columns and finds horizontal thin gaps', () => {
    // Two carved bars at y = [10, 20] and [22, 32]. Gap at y in [20,22] = 2 wide.
    const carved: MultiPolygon = [
      [{ x: 0, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 20 }, { x: 0, y: 20 }],
      [{ x: 0, y: 22 }, { x: 100, y: 22 }, { x: 100, y: 32 }, { x: 0, y: 32 }],
    ];
    const r = polygonThinWalls(carved, {
      grainDirection: 'vertical',
      thresholdUnits: 5,
      designBounds: bounds,
      sampleStepUnits: 1,
    });
    expect(multiPolygonArea(r)).toBeGreaterThan(180);
    expect(multiPolygonArea(r)).toBeLessThan(220);
  });

  it('respects minAreaSqUnits to filter tiny components', () => {
    // Single tiny thin strip — area ~6 sq units.
    const carved: MultiPolygon = [
      [{ x: 50, y: 50 }, { x: 53, y: 50 }, { x: 53, y: 53 }, { x: 50, y: 53 }],
      [{ x: 56, y: 50 }, { x: 59, y: 50 }, { x: 59, y: 53 }, { x: 56, y: 53 }],
    ];
    // With minArea=100, this 6 sq-unit strip should be filtered out.
    const r = polygonThinWalls(carved, {
      grainDirection: 'horizontal',
      thresholdUnits: 5,
      designBounds: bounds,
      sampleStepUnits: 0.5,
      minAreaSqUnits: 100,
    });
    expect(multiPolygonIsEmpty(r)).toBe(true);
  });

  it('returns empty when threshold = 0', () => {
    const r = polygonThinWalls(twoVerticalBars(), {
      grainDirection: 'horizontal',
      thresholdUnits: 0,
      designBounds: bounds,
    });
    expect(multiPolygonIsEmpty(r)).toBe(true);
  });
});
