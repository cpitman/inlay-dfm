import { describe, it, expect } from 'vitest';
import { detectAlignmentRiskPolygon } from './polygonAlignmentRisk';
import type { MultiPolygon } from './polygon';

function rect(x: number, y: number, w: number, h: number): MultiPolygon {
  return [[
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ]];
}

describe('detectAlignmentRiskPolygon', () => {
  it('flags an A-edge that runs parallel and close to a B-edge', () => {
    // A is a thin horizontal stripe; B is below it, shifted right
    // so that A's RIGHT and LEFT edges are far from any B-edge.
    // Only A's BOTTOM should register (it's parallel to and 0.5
    // below B's TOP edge).
    const A = rect(0, 0, 60, 10);             // y in [0, 10]
    const B = rect(20, 10.5, 60, 10);         // y in [10.5, 20.5], x ∈ [20, 80]
    const r = detectAlignmentRiskPolygon(A, B, 1.0);
    // A's bottom edge (y=10, length 60) is the at-risk edge.
    expect(r.affectedPerimeter).toBeCloseTo(60, 0);
    expect(r.totalPerimeter).toBeCloseTo(140, 0);
    expect(r.affectedFraction).toBeCloseTo(60 / 140, 2);
    expect(r.riskPolygon.length).toBeGreaterThan(0);
  });

  it('does not flag perpendicular edges that touch', () => {
    // Horizontal stripe + vertical stripe; they cross perpendicularly.
    // No A-edge has a parallel B-edge within threshold.
    const A = rect(0, 5, 100, 1);    // horizontal
    const B = rect(50, 0, 1, 100);   // vertical
    const r = detectAlignmentRiskPolygon(A, B, 0.5);
    expect(r.affectedPerimeter).toBe(0);
    expect(r.affectedFraction).toBe(0);
  });

  it('does not flag when gap exceeds threshold', () => {
    const A = rect(0, 0, 60, 10);
    const B = rect(20, 20, 60, 10);  // gap 10 > threshold 1
    const r = detectAlignmentRiskPolygon(A, B, 1.0);
    expect(r.affectedPerimeter).toBe(0);
  });

  it('handles touching parallel edges (gap = 0)', () => {
    // Same horizontal-shift trick to keep side edges far from B.
    const A = rect(0, 0, 60, 10);
    const B = rect(20, 10, 60, 10);  // shares y=10 along x ∈ [20, 60]
    const r = detectAlignmentRiskPolygon(A, B, 1.0);
    expect(r.affectedPerimeter).toBeCloseTo(60, 0);
  });

  it('handles empty inputs', () => {
    expect(detectAlignmentRiskPolygon([], rect(0, 0, 10, 10), 1.0).affectedPerimeter).toBe(0);
    expect(detectAlignmentRiskPolygon(rect(0, 0, 10, 10), [], 1.0).affectedPerimeter).toBe(0);
  });

  it('flags both side edges when A and B are vertically stacked with the same width', () => {
    // Side edges of A at x=0 and x=100 are collinear with B's side
    // edges and only 0.5 apart vertically — they ARE alignment-
    // sensitive (a vertical shift of B would visibly misalign the
    // side seams). This is the over-flagging the polygon path
    // accepts for whole-edge granularity vs. the bitmap's
    // per-pixel granularity.
    const A = rect(0, 0, 100, 10);
    const B = rect(0, 10.5, 100, 10);
    const r = detectAlignmentRiskPolygon(A, B, 1.0);
    // top (100) + left (10) + right (10) flagged.
    expect(r.affectedPerimeter).toBeCloseTo(120, 0);
  });

  it('produces a riskPolygon along each at-risk edge', () => {
    const A = rect(0, 0, 60, 10);
    const B = rect(20, 10.5, 60, 10);
    const r = detectAlignmentRiskPolygon(A, B, 1.0, /* halfW */ 2);
    expect(r.riskPolygon.length).toBeGreaterThan(0);
    // Single at-risk edge of length 60 expanded to band 60×4 = 240
    // (rectangle area).
    const bandArea = r.riskPolygon.reduce((s, ring) => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        a += p.x * q.y - q.x * p.y;
      }
      return s + Math.abs(a) / 2;
    }, 0);
    expect(bandArea).toBeGreaterThan(220);
    expect(bandArea).toBeLessThan(260);
  });
});
