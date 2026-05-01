import { describe, it, expect } from 'vitest';
import { detectAlignmentRisk } from './alignmentRisk';

// These tests model the geometry of the test fixtures in test-fixtures/:
//   - RegistrationErrorTestPositive.svg
//   - RegistrationErrorTestNegative.svg
//
// Both files have the same Layer 1 (red): the full canvas with a hole at
// (515.75, 249) – (809.75, 479). They differ in Layer 2 (blue): in the
// Positive case, Layer 2 exactly fills the hole; in the Negative case,
// Layer 2 is enlarged so that it overlaps Layer 1 well past the hole edge.
//
// We build the masks directly at the SVG's natural pixel resolution rather
// than going through the SVG → canvas rasterization pipeline, because the
// browser canvas APIs aren't available under Vitest's Node runner.
// detectAlignmentRisk operates on Uint8Array masks, so the test can target
// the algorithm itself in isolation.

const CANVAS_W = 1324;
const CANVAS_H = 728;
const DESIGN_WIDTH_INCHES = 5;
const PIXELS_PER_INCH = CANVAS_W / DESIGN_WIDTH_INCHES;     // 264.8 ppi
const ALIGN_THRESHOLD_PX = 0.01 * PIXELS_PER_INCH;          // ~2.65 px
const N = CANVAS_W * CANVAS_H;

// Hole / Positive Layer-2 dimensions, rounded to the integer pixel grid.
const HOLE_X1 = 516, HOLE_Y1 = 249, HOLE_X2 = 810, HOLE_Y2 = 479;

function makeRect(x1: number, y1: number, x2: number, y2: number): Uint8Array {
  const mask = new Uint8Array(N);
  const xa = Math.max(0, x1), xb = Math.min(CANVAS_W, x2);
  const ya = Math.max(0, y1), yb = Math.min(CANVAS_H, y2);
  for (let y = ya; y < yb; y++) {
    const row = y * CANVAS_W;
    for (let x = xa; x < xb; x++) mask[row + x] = 1;
  }
  return mask;
}

/** Full canvas with a rectangular hole punched out (matches the Layer 1 path in both fixtures). */
function makeCanvasMinusHole(hx1: number, hy1: number, hx2: number, hy2: number): Uint8Array {
  const mask = new Uint8Array(N).fill(1);
  for (let y = hy1; y < hy2; y++) {
    const row = y * CANVAS_W;
    for (let x = hx1; x < hx2; x++) mask[row + x] = 0;
  }
  return mask;
}

describe('Registration error detection', () => {
  it('Positive fixture: Layer 2 exactly fills Layer 1\'s hole → risk detected', () => {
    // RegistrationErrorTestPositive.svg
    // Layer 1 (red, drawn first): canvas minus hole at (516, 249)-(810, 479)
    // Layer 2 (blue, drawn on top): rect at the same coordinates
    // Boundaries are identical → registration error would expose the seam.
    const layer1 = makeCanvasMinusHole(HOLE_X1, HOLE_Y1, HOLE_X2, HOLE_Y2);
    const layer2 = makeRect(HOLE_X1, HOLE_Y1, HOLE_X2, HOLE_Y2);

    const result = detectAlignmentRisk(
      layer1, layer2, CANVAS_W, CANVAS_H, ALIGN_THRESHOLD_PX,
    );

    expect(result.affectedCount).toBeGreaterThan(0);
    // The entire hole perimeter should be flagged (subject to corner-pixel rounding).
    expect(result.affectedCount / result.totalBoundaryCount).toBeGreaterThan(0.1);
  });

  it('Negative fixture: Layer 2 overlaps well past the hole → no risk', () => {
    // RegistrationErrorTestNegative.svg
    // Layer 1 (red): same canvas-with-hole as Positive
    // Layer 2 (blue): rect at (442.25, 191.5)-(883.25, 536.5) — extends ~73 px
    // (~0.28") past the hole on every side. Boundaries are far apart, so any
    // realistic registration error is absorbed by the overlap margin.
    const layer1 = makeCanvasMinusHole(HOLE_X1, HOLE_Y1, HOLE_X2, HOLE_Y2);
    const layer2 = makeRect(442, 192, 884, 537);

    const result = detectAlignmentRisk(
      layer1, layer2, CANVAS_W, CANVAS_H, ALIGN_THRESHOLD_PX,
    );

    expect(result.affectedCount).toBe(0);
  });

  it('Positive after extension: Layer 1 hole shrunken by 0.05" → no risk', () => {
    // After running extendForRegistration on the Positive fixture, Layer 1's
    // hole shrinks by EXTENSION_INCHES (0.05") on every side: the lower
    // layer now extends under the upper layer, well past the threshold.
    // 0.05" * 264.8 ppi ≈ 13 px shrinkage on each side.
    const ext = Math.round(0.05 * PIXELS_PER_INCH);
    const layer1 = makeCanvasMinusHole(
      HOLE_X1 + ext, HOLE_Y1 + ext, HOLE_X2 - ext, HOLE_Y2 - ext,
    );
    const layer2 = makeRect(HOLE_X1, HOLE_Y1, HOLE_X2, HOLE_Y2);

    const result = detectAlignmentRisk(
      layer1, layer2, CANVAS_W, CANVAS_H, ALIGN_THRESHOLD_PX,
    );

    expect(result.affectedCount).toBe(0);
  });
});
