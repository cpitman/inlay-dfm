import { describe, it, expect } from 'vitest';
import { computeHullFillMask } from './fillConvexHullCovered';

const W = 64;
const H = 64;
const N = W * H;

/** Set every pixel in [x0, x1) × [y0, y1) on `mask`. */
function rect(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      mask[y * W + x] = 1;
    }
  }
}

function popcount(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

describe('computeHullFillMask', () => {
  it('U-shape covered by a later layer fills the open mouth', () => {
    // U-shape: left wall, bottom wall, right wall (no top).
    const target = new Uint8Array(N);
    rect(target, 10, 10, 20, 55);  // left wall
    rect(target, 10, 45, 55, 55);  // bottom (overlaps left wall — fine)
    rect(target, 45, 10, 55, 55);  // right wall
    // Later layer covers the U's interior + open mouth at top.
    const later = new Uint8Array(N);
    rect(later, 10, 5, 55, 55);

    const fill = computeHullFillMask(target, later, W, H);
    // Hull of the U is its bounding rect 10..55 × 10..55 (45×45 = 2025 px).
    // Original component has the three walls (~ 10×45 + 45×10 + 10×45 - overlaps).
    // Added (covered) pixels = hull - component, which is the interior + mouth.
    // Should be a meaningful number of pixels (well over the 16-pixel min).
    expect(popcount(fill)).toBeGreaterThan(500);
    // Interior of the U (e.g. middle of the empty cavity) should be filled.
    expect(fill[27 * W + 30]).toBe(1);
    // Outside the hull should NOT be filled.
    expect(fill[5 * W + 5]).toBe(0);
    expect(fill[60 * W + 60]).toBe(0);
  });

  it('U-shape uncovered by later layers gets no fill', () => {
    const target = new Uint8Array(N);
    rect(target, 10, 10, 20, 55);
    rect(target, 10, 45, 55, 55);
    rect(target, 45, 10, 55, 55);
    const later = new Uint8Array(N);  // empty

    const fill = computeHullFillMask(target, later, W, H);
    expect(popcount(fill)).toBe(0);
  });

  it('already-convex rectangle yields no fill (hull = mask)', () => {
    const target = new Uint8Array(N);
    rect(target, 10, 10, 30, 30);
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);  // covers everything

    const fill = computeHullFillMask(target, later, W, H);
    // Hull == component == 20×20 rect. Added pixels = empty.
    expect(popcount(fill)).toBe(0);
  });

  it('U opening to canvas edge fills the part covered by later layers', () => {
    // U opens to the RIGHT edge of the canvas at x = W = 64.
    // Walls at top, left, bottom; right side missing.
    const target = new Uint8Array(N);
    rect(target, 10, 20, 64, 25);  // top wall (extends to right edge)
    rect(target, 10, 20, 15, 50);  // left wall
    rect(target, 10, 45, 64, 50);  // bottom wall (extends to right edge)
    // Later layer covers the interior cavity.
    const later = new Uint8Array(N);
    rect(later, 15, 25, 64, 45);

    const fill = computeHullFillMask(target, later, W, H);
    expect(popcount(fill)).toBeGreaterThan(50);
    // A point inside the cavity should be filled.
    expect(fill[35 * W + 30]).toBe(1);
  });

  it('multiple components: only the covered one fills', () => {
    // Two disjoint U-shapes. Only the LEFT one's mouth is covered.
    const target = new Uint8Array(N);
    // Left U at x=2..15
    rect(target, 2, 5, 5, 25);
    rect(target, 2, 22, 15, 25);
    rect(target, 12, 5, 15, 25);
    // Right U at x=40..55
    rect(target, 40, 5, 43, 25);
    rect(target, 40, 22, 55, 25);
    rect(target, 52, 5, 55, 25);
    const later = new Uint8Array(N);
    // Cover only the LEFT U's cavity.
    rect(later, 5, 5, 12, 22);

    const fill = computeHullFillMask(target, later, W, H);
    // Left U interior gets some fill.
    expect(fill[10 * W + 7]).toBe(1);
    // Right U interior is NOT covered → not filled.
    expect(fill[10 * W + 47]).toBe(0);
    // Filled pixels should ONLY be in the left half.
    let rightHalfFill = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 32; x < W; x++) {
        if (fill[y * W + x]) rightHalfFill++;
      }
    }
    expect(rightHalfFill).toBe(0);
  });

  it('fill below the MIN_FILL_PIXELS threshold is skipped', () => {
    // Tiny near-convex blob with a single uncovered pixel "concavity"
    // smaller than the 16-pixel minimum.
    const target = new Uint8Array(N);
    rect(target, 10, 10, 14, 14);  // 4×4 = 16 px component
    target[11 * W + 11] = 0;       // poke a single hole
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);

    const fill = computeHullFillMask(target, later, W, H);
    // The "added by hull" diff is just 1 pixel → below MIN_FILL_PIXELS = 16 → skipped.
    expect(popcount(fill)).toBe(0);
  });

  it('empty target yields empty fill', () => {
    const target = new Uint8Array(N);
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);
    const fill = computeHullFillMask(target, later, W, H);
    expect(popcount(fill)).toBe(0);
  });
});
