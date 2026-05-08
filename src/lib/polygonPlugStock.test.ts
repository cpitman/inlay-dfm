import { describe, it, expect } from 'vitest';
import { convexHullPolygon, computePlugStockPolygon } from './polygonPlugStock';
import { multiPolygonArea, type MultiPolygon } from './polygon';

describe('convexHullPolygon', () => {
  it('returns the input for a 3-point triangle', () => {
    const triangle: MultiPolygon = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 },
    ]];
    const hull = convexHullPolygon(triangle);
    expect(hull).toHaveLength(3);
  });

  it('removes a concave vertex from a 5-point pentagon-with-dent', () => {
    // Pentagon-shape with one vertex pushed INTO the shape.
    const dented: MultiPolygon = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 5, y: 5 },          // dent — interior to the hull
      { x: 0, y: 10 },
    ]];
    const hull = convexHullPolygon(dented);
    // Hull is the rectangle (4 vertices); the dent is dropped.
    expect(hull).toHaveLength(4);
  });

  it('hull of a square with hole = the outer square', () => {
    // Outer 10×10, hole 4×4 at center (CW under even-odd).
    const sq: MultiPolygon = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 3, y: 3 }, { x: 3, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 3 }],
    ];
    const hull = convexHullPolygon(sq);
    expect(hull).toHaveLength(4);
  });
});

describe('computePlugStockPolygon', () => {
  it('plug stock = hull dilated by margin (= bigger by ~2 × margin × hull-perimeter)', () => {
    const pocket: MultiPolygon = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]];
    // designUnitsPerInch=1 for easy math; 0.5" margin = 0.5 design units.
    const stock = computePlugStockPolygon(pocket, 0.5, 1);
    const stockArea = multiPolygonArea(stock);
    // Hull area = 100. Dilated outward by 0.5: roughly 11×11 - corner adjustments.
    // Steiner: 100 + 0.5 × 40 + π × 0.25 ≈ 100 + 20 + 0.785 ≈ 120.78.
    expect(stockArea).toBeGreaterThan(120);
    expect(stockArea).toBeLessThan(122);
  });

  it('zero margin → returns the hull as-is', () => {
    const pocket: MultiPolygon = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 },
    ]];
    const stock = computePlugStockPolygon(pocket, 0, 1);
    expect(multiPolygonArea(stock)).toBeCloseTo(40, 2); // triangle area = 0.5 × 10 × 8.
  });
});
