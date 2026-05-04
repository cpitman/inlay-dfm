import { describe, it, expect } from 'vitest';
import { detectAlignmentRisk } from './alignmentRisk';
import { computeBoundary } from './morphology';

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

function stampDisk(mask: Uint8Array, cx: number, cy: number, r: number) {
  const r2 = r * r;
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(CANVAS_W, Math.ceil(cx + r) + 1);
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(CANVAS_H, Math.ceil(cy + r) + 1);
  for (let y = ya; y < yb; y++) {
    const dy = y - cy;
    const row = y * CANVAS_W;
    for (let x = xa; x < xb; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) mask[row + x] = 1;
    }
  }
}

/** Disk of `rOuter` with a `rInner` disk punched out at the same center. */
function stampAnnulus(cx: number, cy: number, rOuter: number, rInner: number): Uint8Array {
  const mask = new Uint8Array(N);
  stampDisk(mask, cx, cy, rOuter);
  const r2 = rInner * rInner;
  const xa = Math.max(0, Math.floor(cx - rInner));
  const xb = Math.min(CANVAS_W, Math.ceil(cx + rInner) + 1);
  const ya = Math.max(0, Math.floor(cy - rInner));
  const yb = Math.min(CANVAS_H, Math.ceil(cy + rInner) + 1);
  for (let y = ya; y < yb; y++) {
    const dy = y - cy;
    const row = y * CANVAS_W;
    for (let x = xa; x < xb; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) mask[row + x] = 0;
    }
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

  it('Circular seam: inner-circle exactly fills the annular hole → full ring detected', () => {
    // Layer 1 (earlier color) is an annulus: outer radius 250 px, hole
    // radius 120 px. Layer 2 (later color) is a filled disk of radius
    // 120 px at the same center, so its outer boundary is exactly the
    // layer-1 hole boundary. The inner ring of layer 1 should be
    // flagged in full; the outer ring (130 px from layer 2 — well
    // past the ~2.65 px threshold) must stay clear.
    //
    // We verify the *full ring* by partitioning layer-1's boundary
    // pixels into inner-ring vs outer-ring via radial distance from
    // the circle center, then asserting every inner-ring pixel is
    // flagged. The aggregate `affectedCount/totalBoundaryCount` ratio
    // alone wouldn't catch a sparse / spotty arc.
    const cx = CANVAS_W / 2, cy = CANVAS_H / 2;
    const R_OUTER = 250, R_HOLE = 120;
    const layer1 = stampAnnulus(cx, cy, R_OUTER, R_HOLE);
    const layer2 = new Uint8Array(N);
    stampDisk(layer2, cx, cy, R_HOLE);

    const { riskMask } = detectAlignmentRisk(
      layer1, layer2, CANVAS_W, CANVAS_H, ALIGN_THRESHOLD_PX,
    );

    const boundary = computeBoundary(layer1, CANVAS_W, CANVAS_H);
    let innerTotal = 0, innerFlagged = 0;
    let outerTotal = 0, outerFlagged = 0;
    for (let y = 0; y < CANVAS_H; y++) {
      const row = y * CANVAS_W;
      const dy = y - cy;
      for (let x = 0; x < CANVAS_W; x++) {
        const k = row + x;
        if (!boundary[k]) continue;
        const dx = x - cx;
        const r = Math.hypot(dx, dy);
        if (Math.abs(r - R_HOLE)  <= 1.5) {
          innerTotal++;
          if (riskMask[k]) innerFlagged++;
        } else if (Math.abs(r - R_OUTER) <= 1.5) {
          outerTotal++;
          if (riskMask[k]) outerFlagged++;
        }
      }
    }

    // Sanity: the partition actually found a reasonable seam length —
    // guards against a future stampAnnulus regression silently
    // producing an empty mask. The digitized boundary set is somewhat
    // shorter than the ideal circumference (2π × radius), so use a
    // conservative floor.
    expect(innerTotal).toBeGreaterThan(500);
    expect(outerTotal).toBeGreaterThan(1000);
    // Every inner-ring boundary pixel must be flagged — no spotty /
    // partial detection along the curve.
    expect(innerFlagged).toBe(innerTotal);
    // The outer ring is far from layer 2; no boundary pixel there
    // should be flagged.
    expect(outerFlagged).toBe(0);
  });

  it('Boundaries 0.05" apart on every side → no risk', () => {
    // Variant of the Positive fixture where Layer 1's hole is 0.05"
    // smaller on every side than Layer 2's rect — i.e., Layer 1
    // extends well past the boundary on every side. Distance between
    // the boundaries (0.05") is much greater than the alignment
    // threshold (0.01"), so detection reports no risk.
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
