import { describe, it, expect } from 'vitest';
import { boxesOverlap, findFreeSpot, overlapsAny } from './aabb';

describe('boxesOverlap', () => {
  it('returns false for fully-disjoint boxes', () => {
    expect(boxesOverlap({ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 })).toBe(false);
  });

  it('returns false for boxes that share only an edge (touching)', () => {
    // a's right edge == b's left edge.
    expect(boxesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false);
    // a's bottom edge == b's top edge.
    expect(boxesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 })).toBe(false);
  });

  it('returns false for boxes sharing only a corner pixel', () => {
    expect(boxesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 2, w: 2, h: 2 })).toBe(false);
  });

  it('returns true for partial overlap', () => {
    expect(boxesOverlap({ x: 0, y: 0, w: 3, h: 3 }, { x: 2, y: 2, w: 3, h: 3 })).toBe(true);
  });

  it('returns true when one box is fully nested inside another', () => {
    expect(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 3, y: 3, w: 2, h: 2 })).toBe(true);
  });

  it('is symmetric', () => {
    const a = { x: 0, y: 0, w: 3, h: 3 };
    const b = { x: 1, y: 1, w: 3, h: 3 };
    expect(boxesOverlap(a, b)).toBe(boxesOverlap(b, a));
  });
});

describe('overlapsAny', () => {
  it('returns false for an empty list', () => {
    expect(overlapsAny({ x: 0, y: 0, w: 1, h: 1 }, [])).toBe(false);
  });

  it('returns false when none of the others overlap', () => {
    const probe = { x: 0, y: 0, w: 1, h: 1 };
    const others = [{ x: 5, y: 5, w: 1, h: 1 }, { x: 10, y: 10, w: 1, h: 1 }];
    expect(overlapsAny(probe, others)).toBe(false);
  });

  it('returns true when any one overlaps', () => {
    const probe = { x: 4, y: 4, w: 2, h: 2 };
    const others = [{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 }];
    expect(overlapsAny(probe, others)).toBe(true);
  });
});

describe('findFreeSpot', () => {
  const bounds = { x: 0, y: 0, w: 18, h: 12 };

  it('returns the bounds origin when there are no existing boxes', () => {
    expect(findFreeSpot(4, 4, bounds, [])).toEqual({ x: 0, y: 0 });
  });

  it('places the new box to the right of an existing box when there is room', () => {
    const existing = [{ x: 0, y: 0, w: 4, h: 4 }];
    expect(findFreeSpot(4, 4, bounds, existing)).toEqual({ x: 4, y: 0 });
  });

  it('places below when no room to the right', () => {
    // 16-wide existing leaves only 2" on the right — not enough for a 4" box.
    const existing = [{ x: 0, y: 0, w: 16, h: 4 }];
    expect(findFreeSpot(4, 4, bounds, existing)).toEqual({ x: 0, y: 4 });
  });

  it('returns null when nothing fits', () => {
    // A 5"×5" box can't fit a 6"×6" probe.
    const tinyBounds = { x: 0, y: 0, w: 5, h: 5 };
    expect(findFreeSpot(6, 6, tinyBounds, [])).toBeNull();
  });

  it('returns null when the only free space is too small', () => {
    // Bounds 18x12, existing 16x10 — leaves 2" right strip + 2" bottom band,
    // neither big enough for a 4×4 probe.
    const existing = [{ x: 0, y: 0, w: 16, h: 10 }];
    expect(findFreeSpot(4, 4, bounds, existing)).toBeNull();
  });

  it('clamps a placement candidate to within bounds', () => {
    // Existing box ends past the right edge if interpreted naively, but
    // the candidate gets clamped back inside.
    const existing = [{ x: 14, y: 0, w: 4, h: 4 }]; // right edge at 18
    // Right-of attempt -> x = 18, w=4 -> clamp to x = 14 -> overlaps.
    // Below attempt -> x = 14, y = 4 -> 4×4 fits inside bounds (right edge at 18).
    expect(findFreeSpot(4, 4, bounds, existing)).toEqual({ x: 14, y: 4 });
  });
});
