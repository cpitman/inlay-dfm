import { describe, it, expect } from 'vitest';
import { fillEnclosedHoles } from './fillEnclosedHoles';
import { svgFragmentToMultiPolygon } from './polygonParser';
import { multiPolygonComponents } from './clipperOps';
import { multiPolygonArea } from './polygon';
import type { Layer, VectorData } from '@/types';

/** Build a minimal VectorData from a list of (color, svgFragment) pairs. */
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

/** Square path with optional hole (center 4×4). evenodd fill rule. */
function squareWithHole(x: number, y: number, w: number, h: number, hole?: { x: number; y: number; w: number; h: number }): string {
  let d = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  if (hole) {
    // Reverse-winding inner ring for even-odd hole semantics.
    d += ` M ${hole.x} ${hole.y} L ${hole.x} ${hole.y + hole.h} L ${hole.x + hole.w} ${hole.y + hole.h} L ${hole.x + hole.w} ${hole.y} Z`;
  }
  return `<path d="${d}" fill-rule="evenodd" />`;
}

const RED = '#ff0000';
const BLUE = '#0000ff';

describe('fillEnclosedHoles (polygon-native)', () => {
  it('fills a hole that is fully covered by a later layer', async () => {
    // Target (red): 100×100 square with a 20×20 hole at (40, 40).
    // Later (blue): 30×30 square at (35, 35) — encloses the hole.
    const v = fixture([
      { colorHex: RED,  svgFragment: squareWithHole(0, 0, 100, 100, { x: 40, y: 40, w: 20, h: 20 }) },
      { colorHex: BLUE, svgFragment: squareWithHole(35, 35, 30, 30) },
    ]);
    const r = await fillEnclosedHoles(v, RED, /* designWidthInches */ 10);
    expect(r.filledHoleCount).toBe(1);
    // Filled area = 20×20 = 400 sq SVG units. At 10" / 100 units, sq inch
    // per sq SVG unit = 0.01. So filled sq in = 400 × 0.01 = 4.
    expect(r.filledAreaSqIn).toBeCloseTo(4, 4);
    // The new target should be a solid 100×100 (no holes).
    const newTarget = svgFragmentToMultiPolygon(r.layers[0].svgFragment);
    const components = multiPolygonComponents(newTarget);
    expect(components).toHaveLength(1);
    expect(components[0].holes).toHaveLength(0);
  });

  it('keeps a hole that is NOT covered by any later layer', async () => {
    const v = fixture([
      { colorHex: RED, svgFragment: squareWithHole(0, 0, 100, 100, { x: 40, y: 40, w: 20, h: 20 }) },
      // Later layer is far away (no overlap with the hole).
      { colorHex: BLUE, svgFragment: squareWithHole(80, 80, 10, 10) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
    // Original layers returned unchanged.
    expect(r.layers).toBe(v.layers);
  });

  it('keeps a hole that is only PARTIALLY covered', async () => {
    // Hole 20×20 at (40,40). Later only covers 10×20 of it.
    const v = fixture([
      { colorHex: RED,  svgFragment: squareWithHole(0, 0, 100, 100, { x: 40, y: 40, w: 20, h: 20 }) },
      { colorHex: BLUE, svgFragment: squareWithHole(40, 40, 10, 20) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });

  it('fills multiple holes, each individually covered', async () => {
    // Two holes; each covered by a different later layer.
    const target = `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z M 20 20 L 20 30 L 30 30 L 30 20 Z M 70 70 L 70 80 L 80 80 L 80 70 Z" fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED, svgFragment: target },
      { colorHex: BLUE, svgFragment: squareWithHole(15, 15, 20, 20) + squareWithHole(65, 65, 20, 20) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(2);
    // Total filled area = 2 × 100 = 200 sq SVG units = 2 sq inches at 10" / 100 units.
    expect(r.filledAreaSqIn).toBeCloseTo(2, 4);
  });

  it('no-op when target has no holes', async () => {
    const v = fixture([
      { colorHex: RED,  svgFragment: squareWithHole(0, 0, 100, 100) },
      { colorHex: BLUE, svgFragment: squareWithHole(20, 20, 60, 60) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });

  it('no-op when target is the last (no later layers)', async () => {
    const v = fixture([
      { colorHex: BLUE, svgFragment: squareWithHole(20, 20, 60, 60) },
      { colorHex: RED,  svgFragment: squareWithHole(0, 0, 100, 100, { x: 40, y: 40, w: 20, h: 20 }) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
  });

  it('preserves the rest of the polygon area unchanged', async () => {
    // Target is L-shaped + a hole. Hole gets filled; outer L stays the same.
    const target = `<path d="M 0 0 L 50 0 L 50 50 L 100 50 L 100 100 L 0 100 Z M 60 60 L 60 80 L 80 80 L 80 60 Z" fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED,  svgFragment: target },
      { colorHex: BLUE, svgFragment: squareWithHole(55, 55, 30, 30) },
    ]);
    const beforeArea = multiPolygonArea(svgFragmentToMultiPolygon(target));
    const r = await fillEnclosedHoles(v, RED, 10);
    const afterArea = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    // Filled hole was 20×20 = 400 area; original = 7500 (L) − 400 (hole) = 7100.
    // After fill = 7500.
    expect(beforeArea).toBeCloseTo(7100, 1);
    expect(afterArea).toBeCloseTo(7500, 1);
  });

  it('filling a hole that contains an island absorbs the island', async () => {
    // Outer 100×100 square, with a 60×60 hole inside, with a 20×20
    // island inside the hole. Under even-odd: outer minus hole plus
    // island = 100² − 60² + 20² = 6800 area.
    // After filling (because the hole's interior is fully covered by
    // a later layer): expected outcome = solid 100×100 = 10000.
    const target =
      `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z` +    // outer (CCW)
      ` M 20 20 L 20 80 L 80 80 L 80 20 Z` +            // hole (CW reversed)
      ` M 40 40 L 60 40 L 60 60 L 40 60 Z" ` +          // island in hole (CCW)
      `fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED,  svgFragment: target },
      // Later layer fully covers the hole's interior.
      { colorHex: BLUE, svgFragment: squareWithHole(15, 15, 70, 70) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(1);
    const afterArea = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    // Solid 100×100 = 10000.
    expect(afterArea).toBeCloseTo(10000, 0);
    // No more holes / islands — single solid component.
    const components = multiPolygonComponents(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    expect(components).toHaveLength(1);
    expect(components[0].holes).toHaveLength(0);
  });

  it('same-layer island inside a hole counts as covered (target ∪ laterUnion)', async () => {
    // Pika body-interior case in miniature: outer with a hole, a
    // same-layer island sits inside the hole, and the LATER LAYER
    // covers the hole's interior EXCEPT for the island's footprint.
    // Under the old check (only laterUnion), the island's area
    // would register as uncovered → don't fill. With (target ∪
    // laterUnion), the island IS the target, so the hole is fully
    // covered → FILL, absorbing the island.
    const target =
      `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z` +    // outer
      ` M 20 20 L 20 80 L 80 80 L 80 20 Z` +            // hole
      ` M 40 40 L 60 40 L 60 60 L 40 60 Z" ` +          // island
      `fill-rule="evenodd" />`;
    // Later layer covers the hole's interior EXCEPT the island
    // footprint (= the layer's later coverage has its own hole at
    // the island's location, simulating "the later layer covers
    // around the island").
    const later =
      `<path d="M 15 15 L 85 15 L 85 85 L 15 85 Z` +    // outer
      ` M 40 40 L 60 40 L 60 60 L 40 60 Z" ` +          // hole at island location
      `fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED,  svgFragment: target },
      { colorHex: BLUE, svgFragment: later },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(1);
    const afterArea = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    expect(afterArea).toBeCloseTo(10000, 0);
  });

  it('BFS: top-level hole filled → nested geometry inside is NOT separately checked', async () => {
    // outer with hole H; H contains island J with its own hole H2.
    // Both H and H2 are fully covered. Without BFS-skip, both might
    // be marked for fill. With BFS-skip, only H is marked (H2 is
    // absorbed by H's fill). The OBSERVED outcome is the same
    // (solid outer), but filledHoleCount should be 1, not 2,
    // confirming H2 wasn't redundantly checked.
    const target =
      `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z` +    // outer
      ` M 20 20 L 20 80 L 80 80 L 80 20 Z` +            // H (hole)
      ` M 40 40 L 60 40 L 60 60 L 40 60 Z` +            // J (island in H)
      ` M 45 45 L 55 45 L 55 55 L 45 55 Z" ` +          // H2 (hole in J)
      `fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED,  svgFragment: target },
      { colorHex: BLUE, svgFragment: squareWithHole(15, 15, 70, 70) }, // covers H entirely
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    // BFS visits H first; H is covered → mark + don't descend.
    // H2 is never visited, so filledHoleCount = 1.
    expect(r.filledHoleCount).toBe(1);
    // Final geometry: solid 100×100.
    const afterArea = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    expect(afterArea).toBeCloseTo(10000, 0);
  });

  it('partial fill: NCU fully internal to H is replaced by grown-NCU as the new hole', async () => {
    // outer 100×100, hole 50×50 at (25,25). Later layer covers
    // everything inside the hole EXCEPT a small 5×5 sliver at
    // (47.5, 47.5). The uncovered sliver is interior to the hole;
    // grown-NCU (= sliver inflated by ~1.3 design units at this
    // scale) stays interior too. Expected: partial-fill replaces
    // the 50×50 hole with a small hole hugging the sliver.
    const target =
      `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z` +
      ` M 25 25 L 25 75 L 75 75 L 75 25 Z" ` +
      `fill-rule="evenodd" />`;
    // Later: covers (25..75, 25..75) but has a hole at the sliver.
    const later =
      `<path d="M 25 25 L 75 25 L 75 75 L 25 75 Z` +
      ` M 47.5 47.5 L 47.5 52.5 L 52.5 52.5 L 52.5 47.5 Z" ` +
      `fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED, svgFragment: target },
      { colorHex: BLUE, svgFragment: later },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
    expect(r.partiallyFilledHoleCount).toBe(1);

    // New target: outer 100×100 with a SMALL hole around the sliver
    // (= grown-NCU's outer ring).
    const newMP = svgFragmentToMultiPolygon(r.layers[0].svgFragment);
    const components = multiPolygonComponents(newMP);
    expect(components).toHaveLength(1);
    expect(components[0].holes).toHaveLength(1);

    // Total area is close to 10000 (most of the 50×50 hole absorbed)
    // but a small hole remains around the grown sliver.
    const afterArea = multiPolygonArea(newMP);
    expect(afterArea).toBeGreaterThan(9800);
    expect(afterArea).toBeLessThan(9990);
  });

  it('partial fill: H entirely inside grown-NCU is left unchanged', async () => {
    // outer 100×100, hole 50×50 at (25,25). NO later coverage at
    // all → uncovered = entire hole. Grown by margin → grown-NCU
    // extends past H's boundary on all sides → every edge of H is
    // INSIDE grown-NCU → algorithm returns H unchanged.
    const v = fixture([
      { colorHex: RED, svgFragment: squareWithHole(0, 0, 100, 100, { x: 25, y: 25, w: 50, h: 50 }) },
      { colorHex: BLUE, svgFragment: squareWithHole(0, 0, 1, 1) }, // a non-overlapping speck
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
    expect(r.partiallyFilledHoleCount).toBe(0);
    // Layers returned unchanged (no fills, no partial fills).
    expect(r.layers).toBe(v.layers);
  });

  it('partial fill: two disjoint internal NCUs produce two new holes', async () => {
    // outer 100×100, big hole 80×80 at (10,10). Later covers most
    // of the hole's interior but leaves TWO disjoint slivers.
    const target =
      `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z` +
      ` M 10 10 L 10 90 L 90 90 L 90 10 Z" ` +
      `fill-rule="evenodd" />`;
    // Later: covers (10..90, 10..90) with two holes (= the two slivers).
    const later =
      `<path d="M 10 10 L 90 10 L 90 90 L 10 90 Z` +
      ` M 25 25 L 25 30 L 30 30 L 30 25 Z` +    // sliver A (top-left interior)
      ` M 70 70 L 70 75 L 75 75 L 75 70 Z" ` +  // sliver B (bottom-right interior)
      `fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED, svgFragment: target },
      { colorHex: BLUE, svgFragment: later },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    expect(r.filledHoleCount).toBe(0);
    expect(r.partiallyFilledHoleCount).toBe(1);
    // The single hole produced two new holes after partial fill.
    const newMP = svgFragmentToMultiPolygon(r.layers[0].svgFragment);
    const components = multiPolygonComponents(newMP);
    expect(components).toHaveLength(1);
    expect(components[0].holes).toHaveLength(2);
  });

  it('BFS: unfilled top-level hole → its islands\' holes are visited and filled when covered', async () => {
    // Outer with hole H (NOT fully covered by later layers); H
    // contains an island J with its own hole H2 (which IS fully
    // covered). The walker should NOT skip H's nested geometry
    // (since H wasn't filled) — it should descend and fill H2.
    const target =
      `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z` +    // outer
      ` M 20 20 L 20 80 L 80 80 L 80 20 Z` +            // H
      ` M 35 35 L 65 35 L 65 65 L 35 65 Z` +            // J (island in H)
      ` M 45 45 L 55 45 L 55 55 L 45 55 Z" ` +          // H2 (hole in J)
      `fill-rule="evenodd" />`;
    // Later layer covers ONLY H2 (= the inner-inner area at
    // x=45..55, y=45..55). H itself is NOT fully covered (most of
    // it is uncovered).
    const v = fixture([
      { colorHex: RED,  svgFragment: target },
      { colorHex: BLUE, svgFragment: squareWithHole(40, 40, 20, 20) },
    ]);
    const r = await fillEnclosedHoles(v, RED, 10);
    // H not filled; descend into J → H2 filled. filledHoleCount = 1.
    expect(r.filledHoleCount).toBe(1);
    // Resulting target: outer with H still as a hole (not absorbed),
    // J still in place (now solid since its H2 was absorbed).
    // Area: outer (10000) − H (3600) + J (900) = 7300.
    const afterArea = multiPolygonArea(svgFragmentToMultiPolygon(r.layers[0].svgFragment));
    expect(afterArea).toBeCloseTo(7300, 0);
  });
});
