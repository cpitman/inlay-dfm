import { describe, it, expect } from 'vitest';
import { polygonProblemStats } from './polygonPocketStats';
import type { MultiPolygon } from './polygon';

/** A square as a MultiPolygon with one CCW ring. */
function square(x: number, y: number, w: number, h: number): MultiPolygon {
  return [[
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]];
}

/** A square with a square hole (CCW outer + CW hole). */
function squareWithHole(x: number, y: number, w: number, h: number, hx: number, hy: number, hw: number, hh: number): MultiPolygon {
  return [
    [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
    [{ x: hx, y: hy }, { x: hx, y: hy + hh }, { x: hx + hw, y: hy + hh }, { x: hx + hw, y: hy }],
  ];
}

describe('polygonProblemStats', () => {
  it('passes when the carved area easily fits the bit at full depth', async () => {
    // 1000×1000 square, R = 5. The bit's round tip can't fit
    // into the four sharp outer corners — that's a real geometric
    // limitation, but it's tiny relative to the total area
    // (~0.002%) so the passes threshold (0.1%) holds.
    const carved = square(0, 0, 1000, 1000);
    const r = polygonProblemStats(carved, 5);
    expect(r.passed).toBe(true);
    expect(r.hasAnyFullDepth).toBe(true);
    expect(r.hasIsolatedComponent).toBe(false);
    expect(r.percent).toBeLessThan(0.1);
    // Inward offset = 990×990 = 980100, of 1e6 → ~98.01%.
    expect(r.fullDepthPercent).toBeCloseTo(98.01, 1);
  });

  it('flags the entire carved area as problem when bit cannot fit anywhere', async () => {
    // 4×4 square; R = 5 → bit can't fit at all.
    const carved = square(0, 0, 4, 4);
    const r = polygonProblemStats(carved, 5);
    expect(r.hasAnyFullDepth).toBe(false);
    expect(r.fullDepthPercent).toBe(0);
    expect(r.percent).toBeCloseTo(100, 0);
    expect(r.hasIsolatedComponent).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('flags an isolated component too narrow for the bit', async () => {
    // Big component (passes) + small component (too small).
    // MultiPolygon with two disjoint squares.
    const carved: MultiPolygon = [
      ...square(0, 0, 50, 50),
      ...square(60, 0, 4, 4),
    ];
    const r = polygonProblemStats(carved, 5);
    expect(r.hasIsolatedComponent).toBe(true);
    expect(r.passed).toBe(false);
    // Some full-depth area exists from the big component.
    expect(r.hasAnyFullDepth).toBe(true);
  });

  it('returns the problem polygon when requested', async () => {
    // L-shape with a thin arm. The arm's tip should fall in problem.
    const carved: MultiPolygon = [[
      { x: 0,  y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 50 },
      { x: 0,  y: 50 },
    ]];
    const r = polygonProblemStats(carved, 8, { returnPolygon: true });
    expect(r.problemPolygon).toBeDefined();
    // Arm width is 10; bit radius 8 means bit body sweep covers ±8
    // of any seed point. Arm seed = 1-pixel-wide line down the
    // middle. Bit-body sweep covers (almost) the full arm but not
    // the very tip. Some non-zero problem expected.
    expect(r.percent).toBeGreaterThan(0);
  });

  it('plug mode counts the design-boundary band as full-depth', async () => {
    // 4×4 square at (0,0); R = 5. Without plug mode, no bit fits at
    // full depth → fail. With plug mode + designBounds = the square,
    // the boundary band counts as full-depth → fully reachable.
    const carved = square(0, 0, 4, 4);
    const noPlug = polygonProblemStats(carved, 5);
    expect(noPlug.passed).toBe(false);
    const plug = polygonProblemStats(carved, 5, {
      plugMode: true,
      designBounds: { x0: 0, y0: 0, x1: 4, y1: 4 },
    });
    expect(plug.passed).toBe(true);
    expect(plug.hasAnyFullDepth).toBe(true);
    expect(plug.hasIsolatedComponent).toBe(false);
  });

  it('handles a hole-with-island carved shape', async () => {
    // 1000×1000 outer with a 600×600 hole, plus a 200×200 island
    // in the hole. R = 5 is small relative to all features, so
    // both the outer ring and the island fit comfortably.
    const carved = squareWithHole(0, 0, 1000, 1000, 200, 200, 600, 600);
    carved.push(...square(400, 400, 200, 200));
    const r = polygonProblemStats(carved, 5);
    expect(r.passed).toBe(true);
    expect(r.hasAnyFullDepth).toBe(true);
  });

  it('R = 0 short-circuits to "pass with empty problem"', async () => {
    const carved = square(0, 0, 10, 10);
    const r = polygonProblemStats(carved, 0);
    expect(r.passed).toBe(true);
    expect(r.percent).toBe(0);
  });

  it('empty carved short-circuits to pass', async () => {
    const r = polygonProblemStats([], 5);
    expect(r.passed).toBe(true);
    expect(r.percent).toBe(0);
    expect(r.hasIsolatedComponent).toBe(false);
  });

  it('clears small-corner problem area below the per-component 5% tolerance', () => {
    // 100×100 square, R = 5. Disc-fits model leaves 4 sharp outer
    // corners as "problem" — total ~21.5 sq units of 10000 = 0.215%.
    // That exceeds the 0.1% strict pass threshold but is well below
    // the 5% per-component tolerance, so the cleanup clears the
    // problem region entirely.
    const carved = square(0, 0, 100, 100);
    const r = polygonProblemStats(carved, 5, { returnPolygon: true });
    expect(r.percent).toBe(0);
    expect(r.passed).toBe(true);
    expect(r.problemPolygon).toEqual([]);
  });

  it('keeps problem area when it exceeds the per-component tolerance', () => {
    // A 30×30 square carved with R = 8. Inward offset by 8 leaves a
    // 14×14 seed; bit body sweep leaves a substantial corner band.
    // Problem area is large enough relative to the 900 carved units
    // to exceed the 5% tolerance, so cleanup keeps it.
    const carved = square(0, 0, 30, 30);
    const r = polygonProblemStats(carved, 8, { returnPolygon: true });
    expect(r.percent).toBeGreaterThanOrEqual(5);
    expect(r.problemPolygon).toBeDefined();
    expect(r.problemPolygon!.length).toBeGreaterThan(0);
  });

  it('keeps a stranded component flagged regardless of size (100% problem within)', () => {
    // Big component (passes) + small isolated component (no FD seeds).
    // The isolated component's problem ratio is 100% within itself,
    // way above 5%, so it stays flagged.
    const carved: MultiPolygon = [
      ...square(0, 0, 50, 50),    // big — easily covered at R=5
      ...square(60, 0, 4, 4),     // small — too narrow for R=5
    ];
    const r = polygonProblemStats(carved, 5, { returnPolygon: true });
    expect(r.hasIsolatedComponent).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.problemPolygon).toBeDefined();
    // The kept problem region is the small square (= 16 sq units).
    // The big square's tiny corner artifacts get cleared.
    const problemArea = r.problemPolygon!.length === 0
      ? 0
      : r.problemPolygon!.reduce((a, ring) => {
          // Sum-of-ring-areas as a sanity proxy for total area.
          let s = 0;
          for (let i = 0; i < ring.length; i++) {
            const j = (i + 1) % ring.length;
            s += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
          }
          return a + Math.abs(s) / 2;
        }, 0);
    // ~16 sq units (the small isolated square). Allow a bit of
    // Clipper rounding slack.
    expect(problemArea).toBeGreaterThan(15);
    expect(problemArea).toBeLessThan(20);
  });
});
