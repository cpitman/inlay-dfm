import { describe, it, expect } from 'vitest';
import { distanceTransform } from './distanceTransform';
import { machiningTimeForMask } from './machiningTime';

// We construct masks at the SVG's natural resolution and run the algorithm
// directly — no SVG → canvas rasterization (which would need browser APIs).

const PIXELS_PER_INCH = 200;
const INLAY_DEPTH = 0.125;

// Sample rates picked to make the hand-math obvious.
const CLEARANCE_DIAMETER = 0.25;     // 1/4" bit
const CLEARANCE_MRR = 1.5;           // in³/min
const VBIT_MRR = 0.30;               // in³/min
const VBIT_FEED = 35;                // in/min

function dist1Of(mask: Uint8Array, w: number, h: number): Float32Array {
  // dist1[k] for a mask is the EDT of (1 - mask): distance from each pixel
  // in the mask to the nearest pixel outside it. This matches what
  // analyzeMask produces for pocket masks in the real analyzer.
  const seeds = new Uint8Array(w * h);
  for (let k = 0; k < seeds.length; k++) seeds[k] = mask[k];
  return distanceTransform(seeds, w, h);
}

describe('machiningTimeForMask', () => {
  it('1×1" square: clearance bit clears most of it; perimeter ≈ 4"', () => {
    // 200 ppi, 1" square = 200×200 mask
    const w = 220, h = 220; // small canvas margin around the square
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 210; y++) {
      for (let x = 10; x < 210; x++) mask[y * w + x] = 1;
    }
    const dist1 = dist1Of(mask, w, h);

    const t = machiningTimeForMask(
      mask, dist1, w, h, PIXELS_PER_INCH, INLAY_DEPTH,
      CLEARANCE_DIAMETER, CLEARANCE_MRR, VBIT_MRR, VBIT_FEED,
    );

    // Total area = 1.0 in². Clearance bit (1/4" dia, 1/8" radius) can reach
    // nearly all of a 1" square except a thin strip along the boundary.
    expect(t.clearanceAreaSqIn).toBeGreaterThan(0.5);
    expect(t.clearanceAreaSqIn).toBeLessThan(1.0);
    // Areas sum to total mask area.
    expect(t.clearanceAreaSqIn + t.vbitAreaSqIn).toBeCloseTo(1.0, 1);
    // Perimeter ≈ 4" (boundary pixel count / ppi). Boundary is one pixel
    // thick on each of 4 sides → close to 4".
    expect(t.perimeterIn).toBeGreaterThan(3.5);
    expect(t.perimeterIn).toBeLessThan(4.5);

    // Time components positive & total = sum.
    expect(t.totalTimeMin).toBeCloseTo(
      t.clearanceTimeMin + t.vbitAreaTimeMin + t.vbitPerimeterTimeMin, 6,
    );
    expect(t.clearanceTimeMin).toBeGreaterThan(0);
    expect(t.vbitPerimeterTimeMin).toBeGreaterThan(0);
  });

  it('Plug-fit effective depth scales clearance and v-bit area times linearly', () => {
    // Same 1×1" square. Pass two different effective depths (one with no
    // plug-fit, one with glueGap < surfaceGap so net depth is larger) and
    // verify clearance + v-bit-area times scale proportionally; perimeter
    // time is independent of depth.
    const w = 220, h = 220;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 210; y++) {
      for (let x = 10; x < 210; x++) mask[y * w + x] = 1;
    }
    const dist1 = dist1Of(mask, w, h);

    const tBase = machiningTimeForMask(
      mask, dist1, w, h, PIXELS_PER_INCH, INLAY_DEPTH,
      CLEARANCE_DIAMETER, CLEARANCE_MRR, VBIT_MRR, VBIT_FEED,
    );
    // Net effective depth = inlay - 0.005 + 0.010 = inlay + 0.005.
    const effective = INLAY_DEPTH - 0.005 + 0.010;
    const tPlug = machiningTimeForMask(
      mask, dist1, w, h, PIXELS_PER_INCH, effective,
      CLEARANCE_DIAMETER, CLEARANCE_MRR, VBIT_MRR, VBIT_FEED,
    );
    const ratio = effective / INLAY_DEPTH;
    expect(tPlug.clearanceTimeMin).toBeCloseTo(tBase.clearanceTimeMin * ratio, 6);
    expect(tPlug.vbitAreaTimeMin).toBeCloseTo(tBase.vbitAreaTimeMin * ratio, 6);
    expect(tPlug.vbitPerimeterTimeMin).toBeCloseTo(tBase.vbitPerimeterTimeMin, 6); // unaffected
  });

  it('Thin 0.05" wide strip: clearance bit cannot fit → all time is V-bit', () => {
    // 200 ppi, 0.05" × 1" strip = 10 px × 200 px. Clearance bit radius is
    // 25 px, so it can never sit anywhere inside a 10-px-wide strip.
    const w = 220, h = 220;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 210; y++) {
      for (let x = 10; x < 20; x++) mask[y * w + x] = 1;
    }
    const dist1 = dist1Of(mask, w, h);

    const t = machiningTimeForMask(
      mask, dist1, w, h, PIXELS_PER_INCH, INLAY_DEPTH,
      CLEARANCE_DIAMETER, CLEARANCE_MRR, VBIT_MRR, VBIT_FEED,
    );

    expect(t.clearanceAreaSqIn).toBe(0);
    expect(t.clearanceTimeMin).toBe(0);
    expect(t.vbitAreaSqIn).toBeCloseTo(0.05, 2);
    expect(t.vbitAreaTimeMin).toBeGreaterThan(0);
    expect(t.vbitPerimeterTimeMin).toBeGreaterThan(0);
    expect(t.totalTimeMin).toBeCloseTo(
      t.vbitAreaTimeMin + t.vbitPerimeterTimeMin, 6,
    );
  });
});
