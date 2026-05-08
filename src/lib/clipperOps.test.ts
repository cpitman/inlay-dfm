import { describe, it, expect } from 'vitest';
import {
  multiPolygonUnion,
  multiPolygonIntersection,
  multiPolygonDifference,
  multiPolygonUnionAll,
  multiPolygonOffset,
  multiPolygonCanonicalize,
  multiPolygonComponents,
  componentsToMultiPolygon,
} from './clipperOps';
import { multiPolygonArea, multiPolygonIsEmpty, ringSignedArea, type MultiPolygon } from './polygon';

const square = (x0: number, y0: number, w: number, h: number): MultiPolygon => [
  [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }],
];

describe('multiPolygonUnion', () => {
  it('overlapping squares merge into a single L-shape', () => {
    const a = square(0, 0, 2, 2);
    const b = square(1, 1, 2, 2);
    const u = multiPolygonUnion(a, b);
    // L-shape area = 4 + 4 − 1 (overlap) = 7.
    expect(multiPolygonArea(u)).toBeCloseTo(7, 4);
  });
  it('disjoint squares yield two rings, total area 8', () => {
    const a = square(0, 0, 2, 2);
    const b = square(5, 5, 2, 2);
    const u = multiPolygonUnion(a, b);
    expect(u.length).toBe(2);
    expect(multiPolygonArea(u)).toBeCloseTo(8, 4);
  });
});

describe('multiPolygonIntersection', () => {
  it('unit-square overlap of two 2×2 squares = area 1', () => {
    const a = square(0, 0, 2, 2);
    const b = square(1, 1, 2, 2);
    expect(multiPolygonArea(multiPolygonIntersection(a, b))).toBeCloseTo(1, 4);
  });
  it('disjoint squares intersect to nothing', () => {
    const a = square(0, 0, 2, 2);
    const b = square(5, 5, 2, 2);
    expect(multiPolygonIsEmpty(multiPolygonIntersection(a, b))).toBe(true);
  });
});

describe('multiPolygonDifference', () => {
  it('a − b removes the overlap', () => {
    const a = square(0, 0, 2, 2); // area 4
    const b = square(1, 1, 2, 2); // overlaps a in 1×1
    expect(multiPolygonArea(multiPolygonDifference(a, b))).toBeCloseTo(3, 4);
  });
  it('a − b empty when b ⊇ a', () => {
    const a = square(0, 0, 1, 1);
    const b = square(-1, -1, 3, 3);
    expect(multiPolygonIsEmpty(multiPolygonDifference(a, b))).toBe(true);
  });
});

describe('multiPolygonUnionAll', () => {
  it('three disjoint squares → three rings, total area 12', () => {
    const a = square(0, 0, 2, 2);
    const b = square(5, 0, 2, 2);
    const c = square(10, 0, 2, 2);
    const u = multiPolygonUnionAll([a, b, c]);
    expect(u.length).toBe(3);
    expect(multiPolygonArea(u)).toBeCloseTo(12, 4);
  });
  it('handles a single input', () => {
    const a = square(0, 0, 1, 1);
    expect(multiPolygonArea(multiPolygonUnionAll([a]))).toBeCloseTo(1, 4);
  });
  it('empty list returns empty', () => {
    expect(multiPolygonUnionAll([])).toEqual([]);
  });
});

describe('multiPolygonOffset', () => {
  it('positive offset of a unit square approaches an inflated rounded shape', () => {
    const sq = square(0, 0, 1, 1);
    const grown = multiPolygonOffset(sq, 0.5);
    // Inflated area > original, ≤ (1 + 2 × 0.5)² = 4 (square outer
    // bound). Round corners take a tiny slice (4 quadrants × (r² −
    // πr²/4) cut), so area is 4 − r²(4 − π) = 4 − 0.25 × (4 − π)
    // ≈ 4 − 0.215 ≈ 3.785.
    expect(multiPolygonArea(grown)).toBeGreaterThan(3.7);
    expect(multiPolygonArea(grown)).toBeLessThan(3.9);
  });

  it('negative offset (erosion) shrinks a 2×2 square by 0.5 to area ~1', () => {
    const sq = square(0, 0, 2, 2);
    const eroded = multiPolygonOffset(sq, -0.5);
    expect(multiPolygonArea(eroded)).toBeCloseTo(1, 2);
  });

  it('over-erosion past inradius yields empty multi-polygon', () => {
    const sq = square(0, 0, 1, 1);
    // Inradius is 0.5; eroding by 0.6 should empty it.
    expect(multiPolygonIsEmpty(multiPolygonOffset(sq, -0.6))).toBe(true);
  });

  it('miter offset of a square yields exact rectangular corners (no rounding)', () => {
    const sq = square(0, 0, 1, 1);
    const grown = multiPolygonOffset(sq, 0.5, { joinType: 'miter', miterLimit: 5 });
    // Miter (above limit) gives exact 90° corners → 2 × 2 = 4.
    expect(multiPolygonArea(grown)).toBeCloseTo(4, 3);
  });
});

describe('multiPolygonComponents', () => {
  it('two disjoint squares → two components, each with no holes', () => {
    const a = square(0, 0, 2, 2);
    const b = square(5, 0, 2, 2);
    const components = multiPolygonComponents([...a, ...b]);
    expect(components).toHaveLength(2);
    for (const c of components) {
      expect(c.holes).toHaveLength(0);
      expect(Math.abs(ringSignedArea(c.outer))).toBeCloseTo(4, 4);
    }
  });

  it('square with central hole → one component with one hole', () => {
    const outer = square(0, 0, 10, 10)[0];
    const innerHole = square(3, 3, 4, 4)[0];
    const components = multiPolygonComponents([outer, innerHole]);
    expect(components).toHaveLength(1);
    expect(components[0].holes).toHaveLength(1);
    // Outer area = 100, hole area = 16; total enclosed = 84.
    expect(Math.abs(ringSignedArea(components[0].outer))).toBeCloseTo(100, 4);
    expect(Math.abs(ringSignedArea(components[0].holes[0].ring))).toBeCloseTo(16, 4);
    expect(components[0].holes[0].hasIslands).toBe(false);
  });

  it('island within hole → second component, hole flagged hasIslands', () => {
    const outer = square(0, 0, 10, 10)[0];
    const hole = square(2, 2, 6, 6)[0];
    const island = square(4, 4, 2, 2)[0];
    const components = multiPolygonComponents([outer, hole, island]);
    expect(components).toHaveLength(2);
    // First component: 10×10 outer with 6×6 hole, hole has the island.
    // Second: the 2×2 island, which is itself an outer (no holes).
    const sortedBySize = [...components].sort(
      (a, b) => Math.abs(ringSignedArea(b.outer)) - Math.abs(ringSignedArea(a.outer)),
    );
    expect(sortedBySize[0].holes).toHaveLength(1);
    expect(sortedBySize[0].holes[0].hasIslands).toBe(true);
    expect(sortedBySize[1].holes).toHaveLength(0);
  });

  it('roundtrip: components → ring list preserves the even-odd area', () => {
    const outer = square(0, 0, 10, 10)[0];
    // Reverse the hole to CW (canonical Clipper winding for holes)
    // so multiPolygonArea (sum of signed areas) gives the correct
    // even-odd magnitude. Outer = 100, hole = −16 → 84.
    const hole = square(3, 3, 4, 4)[0].slice().reverse();
    const original: MultiPolygon = [outer, hole];
    const round = componentsToMultiPolygon(multiPolygonComponents(original));
    // Area is preserved (= 84) through the roundtrip.
    expect(multiPolygonArea(round)).toBeCloseTo(84, 4);
    expect(multiPolygonArea(original)).toBeCloseTo(84, 4);
  });
});

describe('multiPolygonCanonicalize', () => {
  it('preserves even-odd semantics: two overlapping rings cancel in the overlap', () => {
    const a = square(0, 0, 1, 1);
    const b = square(0.5, 0, 1, 1);
    // Even-odd rule: a point inside both rings is OUTSIDE the
    // polygon. Result = symmetric difference: 1 + 1 − 2 × 0.5 = 1.
    const merged = multiPolygonCanonicalize([...a, ...b]);
    expect(multiPolygonArea(merged)).toBeCloseTo(1, 4);
  });
  it('is idempotent on already-clean input', () => {
    const a = square(0, 0, 1, 1);
    expect(multiPolygonArea(multiPolygonCanonicalize(a))).toBeCloseTo(1, 4);
  });
});
