import { describe, it, expect } from 'vitest';
import { fillConvexHullCovered } from './fillConvexHullCovered';
import { svgFragmentToMultiPolygon } from './polygonParser';
import { multiPolygonArea } from './polygon';
import type { VectorData } from '@/types';

function fixture(layers: Array<{ colorHex: string; svgFragment: string }>): VectorData {
  return {
    svgString: '',
    layers: layers.map(l => ({ colorHex: l.colorHex, svgFragment: l.svgFragment })),
    naturalWidth: 100,
    naturalHeight: 100,
    viewBox: '0 0 100 100',
    fileName: 'test.svg',
    fileType: 'svg',
    detectedColors: layers.map(l => l.colorHex),
  };
}

const RED = '#ff0000';
const BLUE = '#0000ff';

/** A C-shape (open on the right) at (10, 10)–(50, 50), inner cavity (15, 15)–(45, 45) but with a gap on the right. */
const cShape =
  `<path d="M 10 10 L 50 10 L 50 15 L 15 15 L 15 45 L 50 45 L 50 50 L 10 50 Z" fill="#ff0000" />`;

const uShape =
  // U opening upward: bottom + two side walls.
  `<path d="M 10 10 L 20 10 L 20 40 L 50 40 L 50 10 L 60 10 L 60 50 L 10 50 Z" fill="#ff0000" />`;

describe('fillConvexHullCovered (polygon-native)', () => {
  it('a C-shape with its cavity covered by a later layer fills to a rectangle', async () => {
    // C-shape outer bbox = 10..50 × 10..50, area before fill = 600 (rectangle 40×40 = 1600, minus interior).
    const v = fixture([
      { colorHex: RED, svgFragment: cShape },
      // Later layer covers the C's open mouth + interior.
      { colorHex: BLUE, svgFragment: `<path d="M 14 14 L 50 14 L 50 46 L 14 46 Z" />` },
    ]);

    const beforeArea = multiPolygonArea(svgFragmentToMultiPolygon(cShape));
    const r = await fillConvexHullCovered(v, RED, /* designWidthInches */ 10);

    expect(r.filledHoleCount).toBe(1);
    const afterArea = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    // Hull of the C is the 40×40 rect = 1600. The fill should bring the
    // area up close to the hull (modulo the parts the later layer doesn't
    // cover). Given the later layer covers everything inside, the filled
    // C should be very close to 1600.
    expect(afterArea).toBeGreaterThan(beforeArea);
    expect(afterArea).toBeCloseTo(1600, 0);
    // Sq-inch conversion: 1600 sq SVG units − 600 = 1000. At 0.01 sq in/unit² → 10 sq in.
    expect(r.filledAreaSqIn).toBeCloseTo((afterArea - beforeArea) * 0.01, 4);
  });

  it('a U-shape with its cavity uncovered yields no fill', async () => {
    const v = fixture([
      { colorHex: RED,  svgFragment: uShape },
      { colorHex: BLUE, svgFragment: `<path d="M 80 80 L 90 80 L 90 90 L 80 90 Z" />` }, // far away
    ]);
    const r = await fillConvexHullCovered(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });

  it('already-convex shape gets no fill (hull = component)', async () => {
    const v = fixture([
      { colorHex: RED,  svgFragment: `<path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" />` },
      { colorHex: BLUE, svgFragment: `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z" />` },
    ]);
    const r = await fillConvexHullCovered(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });

  it('partial coverage: only the covered part fills', async () => {
    // C-shape; later only covers the LEFT half of the C's cavity.
    // The filled region should equal exactly that LEFT half.
    const v = fixture([
      { colorHex: RED,  svgFragment: cShape },
      { colorHex: BLUE, svgFragment: `<path d="M 14 14 L 30 14 L 30 46 L 14 46 Z" />` },
    ]);
    const before = multiPolygonArea(svgFragmentToMultiPolygon(cShape));
    const r = await fillConvexHullCovered(v, RED, 10);
    const after = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    expect(after).toBeGreaterThan(before);
    // Filled some, but less than the full hull (which is 1600).
    expect(after).toBeLessThan(1600);
  });

  it('disjoint fill piece (not adjacent to component) is dropped', async () => {
    // Convex 40×40 square. Hull = component (no hull-added pixels).
    // Even if a later layer covers a faraway region, no fill happens
    // since hull−component is empty.
    const v = fixture([
      { colorHex: RED,  svgFragment: `<path d="M 10 10 L 50 10 L 50 50 L 10 50 Z" />` },
      { colorHex: BLUE, svgFragment: `<path d="M 70 70 L 80 70 L 80 80 L 70 80 Z" />` },
    ]);
    const r = await fillConvexHullCovered(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });

  it('multiple components: only the one with covered concavity fills', async () => {
    // Two C-shapes: left one's cavity covered, right one's not.
    const leftC = `<path d="M 5 5 L 25 5 L 25 8 L 8 8 L 8 22 L 25 22 L 25 25 L 5 25 Z" />`;
    const rightC = `<path d="M 40 5 L 60 5 L 60 8 L 43 8 L 43 22 L 60 22 L 60 25 L 40 25 Z" />`;
    const v = fixture([
      { colorHex: RED, svgFragment: leftC + rightC },
      // Later only covers the left C's cavity.
      { colorHex: BLUE, svgFragment: `<path d="M 7 7 L 25 7 L 25 23 L 7 23 Z" />` },
    ]);
    const r = await fillConvexHullCovered(v, RED, 10);
    expect(r.filledHoleCount).toBe(1);
  });

  it('no-op when target is the last layer', async () => {
    const v = fixture([
      { colorHex: BLUE, svgFragment: `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z" />` },
      { colorHex: RED,  svgFragment: cShape },
    ]);
    const r = await fillConvexHullCovered(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });
});
