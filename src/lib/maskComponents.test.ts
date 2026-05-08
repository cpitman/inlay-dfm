import { describe, it, expect } from 'vitest';
import { findMaskComponentCentroids } from './maskComponents';

function emptyMask(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h);
}

function stampRect(mask: Uint8Array, w: number, x: number, y: number, rw: number, rh: number) {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      mask[(y + dy) * w + (x + dx)] = 1;
    }
  }
}

describe('findMaskComponentCentroids', () => {
  it('returns nothing for an empty mask', () => {
    expect(findMaskComponentCentroids(emptyMask(20, 20), 20, 20)).toEqual([]);
  });

  it('a single rectangle produces one component with the expected centroid + area', () => {
    const w = 20, h = 20;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 5, 5, 4, 6); // 4×6 rect → 24 px, centroid (6.5, 7.5)
    const comps = findMaskComponentCentroids(mask, w, h);
    expect(comps).toHaveLength(1);
    expect(comps[0].areaPx).toBe(24);
    expect(comps[0].cx).toBeCloseTo(6.5, 6);
    expect(comps[0].cy).toBeCloseTo(7.5, 6);
  });

  it('three disjoint rectangles produce three components in scan order', () => {
    const w = 60, h = 30;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 5,  5, 4, 4);
    stampRect(mask, w, 30, 5, 6, 6);
    stampRect(mask, w, 15, 18, 8, 8);
    const comps = findMaskComponentCentroids(mask, w, h);
    expect(comps).toHaveLength(3);

    expect(comps[0].cx).toBeCloseTo(6.5, 6);
    expect(comps[0].cy).toBeCloseTo(6.5, 6);
    expect(comps[0].areaPx).toBe(16);

    expect(comps[1].cx).toBeCloseTo(32.5, 6);
    expect(comps[1].cy).toBeCloseTo(7.5, 6);
    expect(comps[1].areaPx).toBe(36);

    expect(comps[2].cx).toBeCloseTo(18.5, 6);
    expect(comps[2].cy).toBeCloseTo(21.5, 6);
    expect(comps[2].areaPx).toBe(64);
  });

  it('diagonally-touching pixels are NOT merged (4-connectivity)', () => {
    const w = 10, h = 10;
    const mask = emptyMask(w, h);
    mask[2 * w + 2] = 1;
    mask[3 * w + 3] = 1;
    const comps = findMaskComponentCentroids(mask, w, h);
    expect(comps).toHaveLength(2);
    expect(comps[0].areaPx).toBe(1);
    expect(comps[1].areaPx).toBe(1);
  });

  it('an L-shape stays one component', () => {
    const w = 10, h = 10;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 1, 1, 4, 1); // horizontal bar
    stampRect(mask, w, 1, 1, 1, 4); // vertical bar (overlaps on (1,1))
    const comps = findMaskComponentCentroids(mask, w, h);
    expect(comps).toHaveLength(1);
    expect(comps[0].areaPx).toBe(7);
  });

  it('finds components touching the edges of the canvas', () => {
    const w = 8, h = 8;
    const mask = emptyMask(w, h);
    mask[0] = 1;
    mask[w * h - 1] = 1;
    const comps = findMaskComponentCentroids(mask, w, h);
    expect(comps).toHaveLength(2);
    expect(comps[0]).toMatchObject({ cx: 0, cy: 0, areaPx: 1 });
    expect(comps[1]).toMatchObject({ cx: 7, cy: 7, areaPx: 1 });
  });
});
