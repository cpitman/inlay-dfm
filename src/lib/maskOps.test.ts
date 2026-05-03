import { describe, it, expect } from 'vitest';
import { dilateMask } from './maskOps';

function emptyMask(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h);
}

function countSet(m: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) c++;
  return c;
}

describe('dilateMask', () => {
  it('returns the same mask when radiusPx is 0', () => {
    const w = 10, h = 10;
    const m = emptyMask(w, h);
    m[5 * w + 5] = 1;
    const d = dilateMask(m, w, h, 0);
    expect(d).toBe(m); // identity reference for the no-op case
  });

  it('a single seed grows to a Euclidean disc of the given radius', () => {
    // Radius 3 → every pixel with Euclidean distance ≤ 3 from (5,5) is set.
    // The 7×7 axis-aligned bounding box contains the disc, but the corners
    // are at distance √18 ≈ 4.24 (outside) so they should NOT be set.
    const w = 11, h = 11;
    const m = emptyMask(w, h);
    m[5 * w + 5] = 1;
    const d = dilateMask(m, w, h, 3);

    // Center pixel set
    expect(d[5 * w + 5]).toBe(1);
    // Cardinal-direction neighbors at distance 3 set
    expect(d[2 * w + 5]).toBe(1); // dist 3, north
    expect(d[8 * w + 5]).toBe(1); // dist 3, south
    expect(d[5 * w + 2]).toBe(1); // dist 3, west
    expect(d[5 * w + 8]).toBe(1); // dist 3, east
    // Distance 4 cardinal: NOT set
    expect(d[1 * w + 5]).toBe(0);
    // Bounding-box corners (dist √18 ≈ 4.24): NOT set
    expect(d[2 * w + 2]).toBe(0);
    expect(d[8 * w + 8]).toBe(0);
  });

  it('two distant seeds grow to two disjoint discs', () => {
    // Two seeds 8 px apart with radius 2 — their dilated discs don't touch.
    const w = 20, h = 10;
    const m = emptyMask(w, h);
    m[5 * w + 4]  = 1;
    m[5 * w + 14] = 1;
    const d = dilateMask(m, w, h, 2);

    // Each seed becomes a disc of ~13 pixels (Euclidean disc r=2 has
    // 5+5+3 = 13 cells when including the cardinal axes only; depending
    // on rounding 12-13). Two disjoint discs ≈ 24-26 pixels.
    const set = countSet(d);
    expect(set).toBeGreaterThanOrEqual(20);
    expect(set).toBeLessThanOrEqual(30);
    // Midpoint between the two seeds is at column 9 — should be empty.
    expect(d[5 * w + 9]).toBe(0);
  });

  it('an empty mask stays empty after dilation', () => {
    const w = 10, h = 10;
    const m = emptyMask(w, h);
    const d = dilateMask(m, w, h, 5);
    expect(countSet(d)).toBe(0);
  });

  it('clamps to canvas bounds (no out-of-bounds writes)', () => {
    // Seed at (0,0) with large radius — should fill the corner up to the
    // radius without overflowing.
    const w = 6, h = 6;
    const m = emptyMask(w, h);
    m[0] = 1;
    const d = dilateMask(m, w, h, 3);
    expect(d.length).toBe(w * h);
    // (0,0) included
    expect(d[0]).toBe(1);
    // (3,0) at dist 3 — included
    expect(d[3]).toBe(1);
    // (0,3) at dist 3 — included
    expect(d[3 * w]).toBe(1);
    // (4,0) at dist 4 — not included
    expect(d[4]).toBe(0);
  });
});
