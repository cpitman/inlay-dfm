import { describe, it, expect } from 'vitest';
import { findFullyCoveredComponents } from './removeOccludedRegions';

const W = 64;
const H = 64;
const N = W * H;

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

describe('findFullyCoveredComponents', () => {
  it('removes a single component fully covered by later layers', () => {
    const target = new Uint8Array(N);
    rect(target, 10, 10, 20, 20);  // 10×10 component
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);  // covers everything

    const { keepMask, removedComponentCount, removedPixelCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(1);
    expect(removedPixelCount).toBe(100);
    expect(popcount(keepMask)).toBe(0);
  });

  it('keeps a component that is NOT fully covered', () => {
    const target = new Uint8Array(N);
    rect(target, 10, 10, 20, 20);
    const later = new Uint8Array(N);  // empty laterUnion

    const { keepMask, removedComponentCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(0);
    expect(popcount(keepMask)).toBe(100);
  });

  it('keeps a component when 1% of pixels are uncovered (below 99.9% tolerance)', () => {
    const target = new Uint8Array(N);
    rect(target, 10, 10, 20, 20);  // 100 px
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);
    later[15 * W + 15] = 0;  // 1 uncovered pixel = 99% coverage, below threshold

    const { keepMask, removedComponentCount, removedPixelCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(0);
    expect(removedPixelCount).toBe(0);
    expect(popcount(keepMask)).toBe(100);
  });

  it('removes a large component when uncovered fraction is below 0.1% (within tolerance)', () => {
    const target = new Uint8Array(N);
    rect(target, 0, 0, 50, 50);  // 2500 px
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);
    // Poke 2 uncovered pixels: 2/2500 = 0.08%, comfortably above 99.9% covered.
    later[10 * W + 10] = 0;
    later[20 * W + 20] = 0;

    const { keepMask, removedComponentCount, removedPixelCount } =
      findFullyCoveredComponents(target, later, W, H);
    // Tolerates the AA-straggler-class of uncovered pixels.
    expect(removedComponentCount).toBe(1);
    expect(removedPixelCount).toBe(2500);
    expect(popcount(keepMask)).toBe(0);
  });

  it('multi-component target: covered ones are removed, uncovered kept', () => {
    const target = new Uint8Array(N);
    rect(target, 5, 5, 15, 15);     // A: covered
    rect(target, 30, 30, 40, 40);   // B: not covered
    rect(target, 50, 5, 60, 15);    // C: covered
    const later = new Uint8Array(N);
    // Cover A and C only.
    rect(later, 5, 5, 15, 15);
    rect(later, 50, 5, 60, 15);

    const { keepMask, removedComponentCount, removedPixelCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(2);
    expect(removedPixelCount).toBe(200);  // A=100 + C=100
    expect(popcount(keepMask)).toBe(100); // only B remains
    // Spot-check that B's pixels are still set.
    expect(keepMask[35 * W + 35]).toBe(1);
    expect(keepMask[10 * W + 10]).toBe(0);  // A removed
    expect(keepMask[55 * W + 10]).toBe(0);  // C removed
  });

  it('component touching the canvas edge: covered → removed', () => {
    const target = new Uint8Array(N);
    rect(target, 0, 0, 10, 10);  // touches top-left corner
    const later = new Uint8Array(N);
    rect(later, 0, 0, 10, 10);   // exactly covers it

    const { keepMask, removedComponentCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(1);
    expect(popcount(keepMask)).toBe(0);
  });

  it('empty target → no-op', () => {
    const target = new Uint8Array(N);
    const later = new Uint8Array(N);
    rect(later, 0, 0, W, H);

    const { keepMask, removedComponentCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(0);
    expect(popcount(keepMask)).toBe(0);
  });

  it('component partially covered (50%) is kept', () => {
    const target = new Uint8Array(N);
    rect(target, 10, 10, 20, 20);  // 10×10 = 100 px
    const later = new Uint8Array(N);
    rect(later, 10, 10, 20, 15);  // covers top half (50 px)

    const { keepMask, removedComponentCount, removedPixelCount } =
      findFullyCoveredComponents(target, later, W, H);
    expect(removedComponentCount).toBe(0);
    expect(removedPixelCount).toBe(0);
    // All 100 pixels survive.
    expect(popcount(keepMask)).toBe(100);
  });
});
