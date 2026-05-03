import { describe, it, expect } from 'vitest';
import { dilateMask, erodeMask } from './maskOps';

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

describe('erodeMask', () => {
  it('returns the same mask when radiusPx is 0', () => {
    const w = 10, h = 10;
    const m = emptyMask(w, h);
    m[5 * w + 5] = 1;
    const e = erodeMask(m, w, h, 0);
    expect(e).toBe(m);
  });

  it('a single pixel is fully eroded by radius 1', () => {
    const w = 10, h = 10;
    const m = emptyMask(w, h);
    m[5 * w + 5] = 1;
    const e = erodeMask(m, w, h, 1);
    expect(countSet(e)).toBe(0);
  });

  it('a 3×3 square fully erodes when radius >= 2 (no pixel is more than 1 deep)', () => {
    const w = 11, h = 11;
    const m = emptyMask(w, h);
    for (let y = 4; y <= 6; y++) for (let x = 4; x <= 6; x++) m[y * w + x] = 1;
    expect(countSet(erodeMask(m, w, h, 2))).toBe(0);
  });

  it('a solid 9×9 square erodes inward by 1 → 7×7 strict interior', () => {
    const w = 11, h = 11;
    const m = emptyMask(w, h);
    for (let y = 1; y <= 9; y++) for (let x = 1; x <= 9; x++) m[y * w + x] = 1;
    const e = erodeMask(m, w, h, 1);
    expect(countSet(e)).toBe(49);
    expect(e[1 * w + 1]).toBe(0); // boundary corner
    expect(e[1 * w + 5]).toBe(0); // boundary edge
    expect(e[5 * w + 5]).toBe(1); // center
    expect(e[2 * w + 2]).toBe(1); // first interior
  });

  it('two boundary-sharing rects have empty intersection after eroding both by 1', () => {
    // The case the layer-order pre-pass cares about: two adjacent inlays
    // sharing only a column of pixels. Erosion strips the shared column
    // from both, leaving disjoint masks.
    const w = 12, h = 6;
    const left = emptyMask(w, h);
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 5; x++) left[y * w + x] = 1;
    const right = emptyMask(w, h);
    for (let y = 1; y <= 4; y++) for (let x = 5; x <= 9; x++) right[y * w + x] = 1;
    expect(left[2 * w + 5]).toBe(1);
    expect(right[2 * w + 5]).toBe(1);

    const eL = erodeMask(left,  w, h, 1);
    const eR = erodeMask(right, w, h, 1);
    let intersect = 0;
    for (let k = 0; k < eL.length; k++) if (eL[k] && eR[k]) intersect++;
    expect(intersect).toBe(0);
  });

  it('two interior-overlapping rects keep non-empty intersection after eroding by 1', () => {
    const w = 12, h = 6;
    const a = emptyMask(w, h);
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 5; x++) a[y * w + x] = 1;
    const b = emptyMask(w, h);
    for (let y = 1; y <= 4; y++) for (let x = 3; x <= 7; x++) b[y * w + x] = 1;
    const eA = erodeMask(a, w, h, 1);
    const eB = erodeMask(b, w, h, 1);
    let intersect = 0;
    for (let k = 0; k < eA.length; k++) if (eA[k] && eB[k]) intersect++;
    expect(intersect).toBeGreaterThan(0);
  });

  it('an empty mask stays empty after erosion', () => {
    const w = 10, h = 10;
    const m = emptyMask(w, h);
    expect(countSet(erodeMask(m, w, h, 5))).toBe(0);
  });
});
