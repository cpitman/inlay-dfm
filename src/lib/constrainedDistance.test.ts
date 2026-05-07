import { describe, it, expect } from 'vitest';
import { constrainedDistanceTransform } from './constrainedDistance';
import { distanceTransform } from './distanceTransform';

const W = 32;
const H = 32;
const N = W * H;

function rect(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      mask[y * W + x] = 1;
    }
  }
}

describe('constrainedDistanceTransform', () => {
  it('with no barrier: matches plain distanceTransform on identical seeds', () => {
    const seeds = new Uint8Array(N);
    seeds[10 * W + 10] = 1;
    const barrier = new Uint8Array(N);

    const constrained = constrainedDistanceTransform(seeds, barrier, W, H);
    // Plain distanceTransform expects "filled" pixels (non-seeds) to compute
    // distance to nearest 0. Invert convention: filled = !seed.
    const filled = new Uint8Array(N);
    for (let i = 0; i < N; i++) filled[i] = seeds[i] ? 0 : 1;
    const plain = distanceTransform(filled, W, H);

    // Constrained == plain everywhere when there's no barrier.
    for (let i = 0; i < N; i++) {
      expect(Math.abs(constrained[i] - plain[i])).toBeLessThan(0.01);
    }
  });

  it('vertical barrier blocks propagation across', () => {
    const seeds = new Uint8Array(N);
    seeds[10 * W + 5] = 1;  // Seed on the LEFT side of the wall
    const barrier = new Uint8Array(N);
    rect(barrier, 15, 0, 16, H);  // Vertical wall at column 15

    const dist = constrainedDistanceTransform(seeds, barrier, W, H);
    // Pixel at (5, 10): distance 0 (it's the seed)
    expect(dist[10 * W + 5]).toBe(0);
    // Pixel at (10, 10): on left of wall, reachable. Distance ~5.
    expect(dist[10 * W + 10]).toBeLessThan(6);
    // Pixel at (20, 10): on RIGHT of wall, unreachable. Distance Infinity.
    expect(dist[10 * W + 20]).toBe(Infinity);
    // Pixel at (15, 10): IS the wall. Distance Infinity.
    expect(dist[10 * W + 15]).toBe(Infinity);
  });

  it('U-shaped barrier: path must go around', () => {
    // U-shape barrier opening upward, seed inside the U's interior.
    const seeds = new Uint8Array(N);
    const barrier = new Uint8Array(N);
    // Left wall, right wall, bottom of U.
    rect(barrier, 10, 5, 11, 25);   // left
    rect(barrier, 20, 5, 21, 25);   // right
    rect(barrier, 10, 24, 21, 25);  // bottom
    seeds[15 * W + 15] = 1;  // Seed inside the U (at (15, 15))

    const dist = constrainedDistanceTransform(seeds, barrier, W, H);
    // Inside the U: short distance.
    expect(dist[10 * W + 15]).toBeLessThan(6);  // (15, 10) is inside, ~5 from seed
    // Outside the U on the LEFT (e.g., (5, 15)): reachable only by going
    // up around the open top, then down. Manhattan: 5+15 = 20-ish.
    expect(dist[15 * W + 5]).toBeGreaterThan(15);
    expect(Number.isFinite(dist[15 * W + 5])).toBe(true);
    // Below the U (clearly outside): reachable around. Some long path.
    expect(Number.isFinite(dist[28 * W + 15])).toBe(true);
  });

  it('two components separated by a barrier: each gets local distance only', () => {
    const seeds = new Uint8Array(N);
    seeds[5  * W + 5] = 1;  // Seed A in top half
    seeds[25 * W + 5] = 1;  // Seed B in bottom half
    const barrier = new Uint8Array(N);
    // Horizontal wall at rows 15-16 (2 px thick — defeats diagonal leakage).
    rect(barrier, 0, 15, W, 17);

    const dist = constrainedDistanceTransform(seeds, barrier, W, H);
    // Pixels near A on its side: small distance.
    expect(dist[5  * W + 6]).toBeLessThan(2);
    expect(dist[10 * W + 5]).toBeLessThan(6);
    // Pixels near B on its side: small distance.
    expect(dist[25 * W + 6]).toBeLessThan(2);
    expect(dist[20 * W + 5]).toBeLessThan(6);
    // Pixel just below the wall, "near" seed A by Euclidean (~14 from A,
    // far closer to B at ~7). Should report ~7 (B's component).
    expect(dist[18 * W + 5]).toBeLessThan(8);
    // Pixel just above the wall, near A only. Distance to A is small;
    // distance to B would be Infinity (across the barrier).
    expect(dist[14 * W + 5]).toBeLessThan(11);
    // Wall pixels themselves: Infinity.
    expect(dist[15 * W + 5]).toBe(Infinity);
    expect(dist[16 * W + 5]).toBe(Infinity);
  });
});
