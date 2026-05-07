import { describe, it, expect } from 'vitest';
import { rasterizeMultiPolygonToMask } from './polygonRender';
import type { MultiPolygon } from './polygon';

function countOnes(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

describe('rasterizeMultiPolygonToMask', () => {
  it('fills a simple square exactly', () => {
    const mp: MultiPolygon = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]];
    const mask = rasterizeMultiPolygonToMask(mp, 10, 10, {
      scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0,
    });
    expect(countOnes(mask)).toBe(100);
  });

  it('respects a hole under even-odd', () => {
    // 10×10 outer, 4×4 hole in the middle = 84 filled pixels.
    const mp: MultiPolygon = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 3, y: 3 }, { x: 3, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 3 }],
    ];
    const mask = rasterizeMultiPolygonToMask(mp, 10, 10, {
      scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0,
    });
    expect(countOnes(mask)).toBe(84);
  });

  it('applies the design-to-canvas transform', () => {
    // Polygon in design units 0..10 → canvas 100×100 at scale 10.
    const mp: MultiPolygon = [[
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]];
    const mask = rasterizeMultiPolygonToMask(mp, 100, 100, {
      scaleX: 10, scaleY: 10, offsetX: 0, offsetY: 0,
    });
    expect(countOnes(mask)).toBe(100 * 100);
  });

  it('applies an offsetX/offsetY transform (viewBox origin)', () => {
    // Polygon at design coords 100..110 (offset viewBox).
    const mp: MultiPolygon = [[
      { x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 },
    ]];
    const mask = rasterizeMultiPolygonToMask(mp, 10, 10, {
      scaleX: 1, scaleY: 1, offsetX: 100, offsetY: 100,
    });
    expect(countOnes(mask)).toBe(100);
  });

  it('returns an all-zero mask for empty polygon', () => {
    const mask = rasterizeMultiPolygonToMask([], 10, 10, {
      scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0,
    });
    expect(countOnes(mask)).toBe(0);
  });

  it('handles a polygon partially outside the canvas (clips)', () => {
    const mp: MultiPolygon = [[
      { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 },
    ]];
    const mask = rasterizeMultiPolygonToMask(mp, 10, 10, {
      scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0,
    });
    // Visible part = 5×5 = 25 pixels at (5..9, 5..9).
    expect(countOnes(mask)).toBe(25);
  });
});
