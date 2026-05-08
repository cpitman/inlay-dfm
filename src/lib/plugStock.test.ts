import { describe, it, expect } from 'vitest';
import { convexHull } from './plugStock';

describe('convexHull', () => {
  it('returns the four corners for a square cloud', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 5, y: 5 }, // interior point — should be removed
      { x: 3, y: 7 },
    ];
    const hull = convexHull(pts);
    expect(hull.length).toBe(4);
    // All four corners must appear.
    const has = (x: number, y: number) => hull.some(p => p.x === x && p.y === y);
    expect(has(0, 0)).toBe(true);
    expect(has(10, 0)).toBe(true);
    expect(has(10, 10)).toBe(true);
    expect(has(0, 10)).toBe(true);
  });

  it('handles fewer than 3 points by returning them as-is', () => {
    expect(convexHull([{ x: 1, y: 2 }])).toHaveLength(1);
    expect(convexHull([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toHaveLength(2);
  });

  it('drops collinear interior points', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, // collinear bottom
      { x: 5, y: 10 },
    ];
    const hull = convexHull(pts);
    // Expect a triangle (0,0), (10,0), (5,10) — the middle bottom point
    // is collinear with the two ends and should be dropped.
    expect(hull.length).toBe(3);
  });
});

