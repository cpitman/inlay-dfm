import { describe, it, expect } from 'vitest';
import { convexHull, rasterizeConvexPolygon, computePlugCarvedMask } from './plugStock';

describe('convexHull', () => {
  it('returns the four corners for a square cloud', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 5, y: 5 }, // interior point — should be removed
      { x: 3, y: 7 },
    ];
    const hull = convexHull(pts);
    expect(hull.length).toBe(4);
    // All four corners must appear.
    const has = (x: number, y: number) => hull.some(p => p.x === x && p.y === y);
    expect(has(0, 0)).toBe(true);
    expect(has(10, 0)).toBe(true);
    expect(has(10, 10)).toBe(true);
    expect(has(0, 10)).toBe(true);
  });

  it('handles fewer than 3 points by returning them as-is', () => {
    expect(convexHull([{ x: 1, y: 2 }])).toHaveLength(1);
    expect(convexHull([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toHaveLength(2);
  });

  it('drops collinear interior points', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, // collinear bottom
      { x: 5, y: 10 },
    ];
    const hull = convexHull(pts);
    // Expect a triangle (0,0), (10,0), (5,10) — the middle bottom point
    // is collinear with the two ends and should be dropped.
    expect(hull.length).toBe(3);
  });
});

describe('rasterizeConvexPolygon', () => {
  it('fills a 10×10 axis-aligned rectangle correctly', () => {
    const w = 20, h = 20;
    const verts = [
      { x: 5,  y: 5  }, { x: 15, y: 5  },
      { x: 15, y: 15 }, { x: 5,  y: 15 },
    ];
    const mask = rasterizeConvexPolygon(verts, w, h);
    // Inside the rect should be filled, outside empty.
    expect(mask[10 * w + 10]).toBe(1);   // center
    expect(mask[5 * w + 5]).toBe(1);     // top-left corner
    expect(mask[14 * w + 14]).toBe(1);   // near bottom-right inner
    expect(mask[2 * w + 2]).toBe(0);     // outside top-left
    expect(mask[18 * w + 18]).toBe(0);   // outside bottom-right
  });

  it('fills a triangle without leaking outside its bounds', () => {
    const w = 20, h = 20;
    const verts = [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 10, y: 15 }];
    const mask = rasterizeConvexPolygon(verts, w, h);
    // Apex/centerline must be filled.
    expect(mask[10 * w + 10]).toBe(1);
    // Just outside the triangle's slanted edges shouldn't be filled.
    expect(mask[14 * w + 5]).toBe(0); // far left of triangle's apex line
  });
});

describe('computePlugCarvedMask', () => {
  function makeRect(w: number, h: number, x1: number, y1: number, x2: number, y2: number): Uint8Array {
    const m = new Uint8Array(w * h);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) m[y * w + x] = 1;
    return m;
  }

  it('square layer + 3px margin → ring around the layer', () => {
    const w = 30, h = 30;
    const margin = 3;
    const layer = makeRect(w, h, 10, 10, 20, 20); // 10x10 square at (10..19, 10..19)
    const carved = computePlugCarvedMask(layer, margin, w, h);

    // Layer pixels themselves are NOT in the carved area (they're the plug).
    expect(carved[15 * w + 15]).toBe(0);
    // 1px outside the layer, within the 3px margin → carved.
    expect(carved[10 * w + 9]).toBe(1);   // just left
    expect(carved[9 * w + 15]).toBe(1);   // just above
    expect(carved[20 * w + 15]).toBe(1);  // just below (square goes 10..19, so 20 is outside)
    expect(carved[15 * w + 20]).toBe(1);  // just right
    // ~5px outside the layer (beyond margin) → not carved.
    expect(carved[15 * w + 25]).toBe(0);
    // Far interior of the design (deep inside layer) → not carved.
    expect(carved[15 * w + 14]).toBe(0);
  });

  it('non-convex L-shape → carved area fills the concavity (since stock is the convex hull)', () => {
    const w = 40, h = 40;
    const margin = 2;
    // L-shape: vertical bar at (10..19, 5..30) ∪ horizontal bar at (10..30, 25..30).
    const layer = new Uint8Array(w * h);
    for (let y = 5;  y < 30; y++) for (let x = 10; x < 20; x++) layer[y * w + x] = 1;
    for (let y = 25; y < 30; y++) for (let x = 20; x < 30; x++) layer[y * w + x] = 1;

    const carved = computePlugCarvedMask(layer, margin, w, h);

    // Inside the L-shape's concavity (top-right of the L, e.g. (25, 15)):
    // not in layer, within the convex hull of the L → carved (it's part of stock).
    expect(layer[15 * w + 25]).toBe(0);
    expect(carved[15 * w + 25]).toBe(1);
    // Pixel inside the L → not carved (it's the plug).
    expect(layer[15 * w + 12]).toBe(1);
    expect(carved[15 * w + 12]).toBe(0);
  });

  it('returns empty mask for masks with fewer than 3 points', () => {
    const w = 10, h = 10;
    const empty = new Uint8Array(w * h);
    const result = computePlugCarvedMask(empty, 2, w, h);
    let any = 0;
    for (let i = 0; i < result.length; i++) if (result[i]) any++;
    expect(any).toBe(0);
  });
});
