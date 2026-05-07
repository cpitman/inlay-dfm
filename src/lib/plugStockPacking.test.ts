import { describe, it, expect } from 'vitest';
import { computePlugStockUsageSqIn } from './plugStockPacking';

const PPI = 100; // pixel-per-inch resolution

/** Make an empty mask of the given canvas size. */
function emptyMask(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h);
}

/** Stamp a filled axis-aligned rectangle into a mask, in-place. */
function stampRect(mask: Uint8Array, w: number, x: number, y: number, rw: number, rh: number) {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      mask[(y + dy) * w + (x + dx)] = 1;
    }
  }
}

describe('computePlugStockUsageSqIn', () => {
  it('axis-aligned 1×1" plug at 0.51" growth → ~2.02"×2.02" OBB ≈ 4.08 sq in', () => {
    // Canvas: 4"×4" = 400×400 px. Place a 1"×1" plug centered.
    const w = 400, h = 400;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 150, 150, 100, 100); // 1" × 1" centered at (2", 2")

    const usage = computePlugStockUsageSqIn(mask, w, h, PPI, 0.51);

    // Expected: dilated bounding box ≈ (1 + 2 × 0.51) × (1 + 2 × 0.51) = 2.02 × 2.02 ≈ 4.08 sq in.
    // Discretization: pixel-grid dilation rounds to integer pixels, so allow some slack.
    expect(usage).toBeGreaterThan(3.9);
    expect(usage).toBeLessThan(4.3);
  });

  it('45°-rotated rectangle: OBB area is smaller than the AABB area', () => {
    // Stamp a 1"×0.2" rectangle, rotated 45°. Anything off-axis should
    // produce an OBB area noticeably smaller than the axis-aligned BBox.
    const w = 500, h = 500;
    const mask = emptyMask(w, h);
    // Build a thin diagonal: span pixels along y = x line over 100 px,
    // ~10 px wide perpendicular.
    const cx = 250, cy = 250;
    for (let t = -50; t <= 50; t++) {
      for (let r = -5; r <= 5; r++) {
        // (t along diagonal direction, r along perpendicular)
        const sx = cx + Math.round((t - r) / Math.SQRT2);
        const sy = cy + Math.round((t + r) / Math.SQRT2);
        if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
          mask[sy * w + sx] = 1;
        }
      }
    }

    const usage = computePlugStockUsageSqIn(mask, w, h, PPI, 0.51);

    // Hand-bound: rotated bar is roughly 1" × 0.1". Dilated by 0.51" each
    // way, the OBB is ~ 2.02" × 1.12" ≈ 2.26 sq in. The AABB of the
    // dilated diamond would be ~ 2.45" × 2.45" ≈ 6.0 sq in. Verify the
    // OBB is well below the AABB upper bound.
    expect(usage).toBeLessThan(3.0); // well below the ~6 sq in AABB
    expect(usage).toBeGreaterThan(1.5);
  });

  it('two far-apart plugs produce two separate OBBs (sum ≈ 2× single)', () => {
    // Two 1×1" plugs separated by 4" — well past 2 × 0.51" = 1.02".
    // After dilation they remain disconnected.
    const w = 700, h = 300;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 50, 100, 100, 100);   // 1" × 1" at (0.5", 1")
    stampRect(mask, w, 550, 100, 100, 100);  // 1" × 1" at (5.5", 1")

    const usage = computePlugStockUsageSqIn(mask, w, h, PPI, 0.51);

    // Two ~4 sq in OBBs = ~8 sq in total.
    expect(usage).toBeGreaterThan(7.5);
    expect(usage).toBeLessThan(8.5);
  });

  it('two close plugs merge into a single connected component (single OBB)', () => {
    // Two 1×1" plugs separated by only 0.5" — within 2 × 0.51" so they
    // merge after dilation. Single OBB encloses both → much less area
    // than two separate OBBs would have.
    const w = 400, h = 250;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 50, 75, 100, 100);   // 1" × 1" at (0.5", 0.75")
    stampRect(mask, w, 200, 75, 100, 100);  // 1" × 1" at (2.0", 0.75"), gap = 0.5"

    const usage = computePlugStockUsageSqIn(mask, w, h, PPI, 0.51);

    // Merged OBB: ~ (2.5 + 2 × 0.51) × (1 + 2 × 0.51) ≈ 3.52 × 2.02 ≈ 7.1 sq in.
    // Two separate would have been ~8 sq in. Merging saves ~1 sq in.
    expect(usage).toBeGreaterThan(6.5);
    expect(usage).toBeLessThan(7.7);
  });

  it('empty mask returns 0', () => {
    const w = 100, h = 100;
    const mask = emptyMask(w, h);
    expect(computePlugStockUsageSqIn(mask, w, h, PPI, 0.51)).toBe(0);
  });

  it('zero growth still produces an OBB around each component', () => {
    // With marginInches=0, dilation is a no-op (the mask itself is the
    // "dilated" set). A single 1×1" plug → 1 sq in OBB.
    const w = 300, h = 300;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 100, 100, 100, 100);
    const usage = computePlugStockUsageSqIn(mask, w, h, PPI, 0);
    expect(usage).toBeGreaterThan(0.95);
    expect(usage).toBeLessThan(1.05);
  });

  it('smaller margin keeps regions disjoint that would merge at a larger margin', () => {
    // Two 1×1" plugs separated by 0.6". At 0.5" margin they almost-
    // merge (gap < 2 × 0.5 = 1.0"); at 0.2" margin they stay clearly
    // separate (gap > 2 × 0.2 = 0.4"). Per-component OBB sum at the
    // smaller margin should be markedly less than at the larger.
    const w = 500, h = 250;
    const mask = emptyMask(w, h);
    stampRect(mask, w, 50, 75, 100, 100);    // (0.5", 0.75")
    stampRect(mask, w, 210, 75, 100, 100);   // (2.1", 0.75"), gap = 0.6"

    const usageLarge = computePlugStockUsageSqIn(mask, w, h, PPI, 0.5);
    const usageSmall = computePlugStockUsageSqIn(mask, w, h, PPI, 0.2);

    // 0.5" margin: dilated regions touch (gap 0.6 < 2 × 0.5), so single
    // OBB ~ (2.6 + 2 × 0.5) × (1 + 2 × 0.5) = 3.6 × 2.0 ≈ 7.2 sq in.
    expect(usageLarge).toBeGreaterThan(6.8);
    expect(usageLarge).toBeLessThan(7.6);
    // 0.2" margin: two disjoint OBBs ~ 2 × (1.4 × 1.4) = 2 × 1.96 ≈
    // 3.92 sq in. Sum is markedly smaller — about half — even though
    // the geometry didn't change.
    expect(usageSmall).toBeGreaterThan(3.5);
    expect(usageSmall).toBeLessThan(4.3);
    expect(usageSmall).toBeLessThan(usageLarge * 0.7);
  });
});
