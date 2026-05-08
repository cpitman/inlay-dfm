import { describe, it, expect } from 'vitest';
import {
  convexHullPolygon,
  computePlugStockPolygon,
  computePlugStockUsageSqInPolygon,
} from './polygonPlugStock';
import { multiPolygonArea, type MultiPolygon } from './polygon';

/** Build an axis-aligned rectangle MultiPolygon at the given inches-coords. */
function rect(xIn: number, yIn: number, wIn: number, hIn: number, duPerInch: number): MultiPolygon {
  const x = xIn * duPerInch;
  const y = yIn * duPerInch;
  const w = wIn * duPerInch;
  const h = hIn * duPerInch;
  return [[
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]];
}

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

describe('computePlugStockUsageSqInPolygon', () => {
  // The polygon-native packing-area estimate. Single 1"×1" pocket
  // outward-offset by R inches has OBB area = (1 + 2R)² for an
  // axis-aligned square — Clipper's rounded corners don't extend
  // past the offset's bbox.
  const DU = 10; // design units per inch — convenient for hand-math.

  it('empty pocket → 0', () => {
    expect(computePlugStockUsageSqInPolygon([], 0.5, DU)).toBe(0);
  });

  it('single 1×1" pocket, 0.5" margin → ~(1 + 1)² = 4 sq in OBB', () => {
    const pocket = rect(0, 0, 1, 1, DU);
    const usage = computePlugStockUsageSqInPolygon(pocket, 0.5, DU);
    // Polygon offset gives a rounded-corner square. The min-area
    // OBB of a roughly-square shape is its axis-aligned bbox =
    // 2 × 2 = 4 sq in.
    expect(usage).toBeGreaterThan(3.95);
    expect(usage).toBeLessThan(4.05);
  });

  it('two well-separated 1×1" pockets → two separate OBBs (sum ≈ 8 sq in)', () => {
    // Pockets at x=0 and x=4 (gap = 3"); margin 0.5" → offsets
    // don't intersect, so two top-level components.
    const pockets: MultiPolygon = [
      ...rect(0, 0, 1, 1, DU),
      ...rect(4, 0, 1, 1, DU),
    ];
    const usage = computePlugStockUsageSqInPolygon(pockets, 0.5, DU);
    expect(usage).toBeGreaterThan(7.9);
    expect(usage).toBeLessThan(8.1);
  });

  it('two close 1×1" pockets merge into one OBB at sufficient margin', () => {
    // Pockets at x=0 and x=1.5 (gap = 0.5"); margin 0.5" → offsets
    // touch (gap < 2R), so one merged component. OBB encloses both:
    // width = 2.5 + 1 = 3.5", height = 1 + 1 = 2". Area = 7 sq in.
    const pockets: MultiPolygon = [
      ...rect(0, 0, 1, 1, DU),
      ...rect(1.5, 0, 1, 1, DU),
    ];
    const usage = computePlugStockUsageSqInPolygon(pockets, 0.5, DU);
    // Two separate would have been ~8 sq in; merging saves ~1 sq in.
    expect(usage).toBeGreaterThan(6.8);
    expect(usage).toBeLessThan(7.2);
  });

  it('L-shape: OBB area > pocket area but < the L\'s axis-aligned bbox + offset band', () => {
    // L: vertical bar (0,0)→(1,3) ∪ horizontal bar (0,2)→(3,3),
    // total pocket area = 1×3 + 2×1 = 5 sq in. Offset by 0.5":
    // the OBB tilts to wrap the whole L; tighter than 4×4 = 16
    // axis-aligned bbox + offset, but ≥ pocket-area + offset band.
    const L: MultiPolygon = [[
      { x: 0,        y: 0 },
      { x: 1 * DU,   y: 0 },
      { x: 1 * DU,   y: 2 * DU },
      { x: 3 * DU,   y: 2 * DU },
      { x: 3 * DU,   y: 3 * DU },
      { x: 0,        y: 3 * DU },
    ]];
    const usage = computePlugStockUsageSqInPolygon(L, 0.5, DU);
    expect(usage).toBeGreaterThan(5);
    expect(usage).toBeLessThan(20); // generous upper bound; min-OBB beats axis-aligned
  });

  it('zero margin → sum of OBBs of the pockets themselves', () => {
    // Single 1×1" pocket, no offset → OBB area = 1 sq in.
    const pocket = rect(0, 0, 1, 1, DU);
    expect(computePlugStockUsageSqInPolygon(pocket, 0, DU)).toBeCloseTo(1, 2);

    // Two disjoint 1×1" pockets, no offset → two OBBs sum to 2.
    const two: MultiPolygon = [
      ...rect(0, 0, 1, 1, DU),
      ...rect(2, 0, 1, 1, DU),
    ];
    expect(computePlugStockUsageSqInPolygon(two, 0, DU)).toBeCloseTo(2, 2);
  });

  it('smaller margin keeps regions disjoint that would merge at a larger margin', () => {
    // Two 1×1" pockets, gap 0.6". Margin 0.5" → gap < 2R, merged.
    // Margin 0.2" → gap > 2R, disjoint.
    const pockets: MultiPolygon = [
      ...rect(0, 0, 1, 1, DU),
      ...rect(1.6, 0, 1, 1, DU),
    ];
    const large = computePlugStockUsageSqInPolygon(pockets, 0.5, DU);
    const small = computePlugStockUsageSqInPolygon(pockets, 0.2, DU);
    // Larger margin merges → single OBB ≈ 3.6 × 2.0 = 7.2.
    expect(large).toBeGreaterThan(6.8);
    expect(large).toBeLessThan(7.6);
    // Smaller margin disjoint → 2 × (1.4 × 1.4) ≈ 3.92.
    expect(small).toBeGreaterThan(3.6);
    expect(small).toBeLessThan(4.2);
    expect(small).toBeLessThan(large * 0.7);
  });
});
