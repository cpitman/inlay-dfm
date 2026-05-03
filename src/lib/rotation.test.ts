import { describe, it, expect } from 'vitest';
import {
  ROTATION_VALUES, isValidRotation, isQuarterTurn,
  rotateLeft, rotateRight,
  effectivePlacementAabb, visibleAspectRatio,
  visibleWidthToDesignWidth, designWidthToVisibleWidth,
} from './rotation';
import { boxesOverlap } from './aabb';

describe('isValidRotation', () => {
  it('accepts the four supported values', () => {
    expect(isValidRotation(0)).toBe(true);
    expect(isValidRotation(90)).toBe(true);
    expect(isValidRotation(180)).toBe(true);
    expect(isValidRotation(270)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const v of [45, 89, 360, -90, '90', null, undefined, true]) {
      expect(isValidRotation(v)).toBe(false);
    }
  });
});

describe('isQuarterTurn', () => {
  it('identifies 90° and 270° as quarter turns', () => {
    expect(isQuarterTurn(0)).toBe(false);
    expect(isQuarterTurn(90)).toBe(true);
    expect(isQuarterTurn(180)).toBe(false);
    expect(isQuarterTurn(270)).toBe(true);
  });
  it('treats undefined as 0°', () => {
    expect(isQuarterTurn(undefined)).toBe(false);
  });
});

describe('rotateLeft / rotateRight', () => {
  it('cycles clockwise 0 → 90 → 180 → 270 → 0', () => {
    let r = ROTATION_VALUES[0];
    for (const expected of [90, 180, 270, 0]) {
      r = rotateRight(r);
      expect(r).toBe(expected);
    }
  });
  it('cycles counter-clockwise 0 → 270 → 180 → 90 → 0', () => {
    let r = ROTATION_VALUES[0];
    for (const expected of [270, 180, 90, 0]) {
      r = rotateLeft(r);
      expect(r).toBe(expected);
    }
  });
  it('treats undefined as 0', () => {
    expect(rotateRight(undefined)).toBe(90);
    expect(rotateLeft(undefined)).toBe(270);
  });
});

describe('effectivePlacementAabb', () => {
  // Use a 2:1 portrait design (natural 100×200) so the aspect axis swap
  // is visible: rotated AABB is wider-than-tall instead of taller-than-wide.
  const naturalW = 100;
  const naturalH = 200;

  it('matches the unrotated AABB for 0°', () => {
    const aabb = effectivePlacementAabb(
      { offsetXInches: 1, offsetYInches: 2, designWidthInches: 3 },
      naturalW, naturalH,
    );
    expect(aabb).toEqual({ x: 1, y: 2, w: 3, h: 6 });
  });

  it('treats missing rotationDegrees as 0', () => {
    const aabb = effectivePlacementAabb(
      { offsetXInches: 1, offsetYInches: 2, designWidthInches: 3 },
      naturalW, naturalH,
    );
    expect(aabb).toEqual({ x: 1, y: 2, w: 3, h: 6 });
  });

  it('keeps the AABB unchanged at 180° (no axis swap)', () => {
    const aabb = effectivePlacementAabb(
      { offsetXInches: 1, offsetYInches: 2, designWidthInches: 3, rotationDegrees: 180 },
      naturalW, naturalH,
    );
    expect(aabb).toEqual({ x: 1, y: 2, w: 3, h: 6 });
  });

  it('swaps width and height at 90°', () => {
    const aabb = effectivePlacementAabb(
      { offsetXInches: 1, offsetYInches: 2, designWidthInches: 3, rotationDegrees: 90 },
      naturalW, naturalH,
    );
    expect(aabb).toEqual({ x: 1, y: 2, w: 6, h: 3 });
  });

  it('swaps width and height at 270° (same as 90°)', () => {
    const aabb = effectivePlacementAabb(
      { offsetXInches: 1, offsetYInches: 2, designWidthInches: 3, rotationDegrees: 270 },
      naturalW, naturalH,
    );
    expect(aabb).toEqual({ x: 1, y: 2, w: 6, h: 3 });
  });
});

describe('visibleAspectRatio + width conversions', () => {
  it('returns the natural aspect for 0°/180°, reciprocal for 90°/270°', () => {
    expect(visibleAspectRatio(2, 0)).toBe(2);
    expect(visibleAspectRatio(2, 180)).toBe(2);
    expect(visibleAspectRatio(2, 90)).toBe(0.5);
    expect(visibleAspectRatio(2, 270)).toBe(0.5);
  });
  it('round-trips visW ↔ designW', () => {
    for (const r of ROTATION_VALUES) {
      const dw = 3;
      const vw = designWidthToVisibleWidth(dw, 2, r);
      expect(visibleWidthToDesignWidth(vw, 2, r)).toBeCloseTo(dw, 10);
    }
  });
});

describe('AABB collision interactions', () => {
  // Two designs, side-by-side, that DON'T overlap when both unrotated
  // but DO overlap once one is rotated 90° (because rotation grows the
  // AABB along the orthogonal axis). This is the headline guarantee
  // rotation gives us — collision detection must see it.
  it('rotation can change collision verdict (from no-overlap to overlap)', () => {
    // Design A: 2"×6" portrait at (0, 0). Unrotated AABB: w=2, h=6.
    //   Rotated 90°: AABB w=6, h=2 — extends to x=6.
    // Design B: 2"×6" portrait at (3, 0). Unrotated AABB: w=2, h=6.
    //   At 0° the boxes are 1" apart and don't overlap.
    const a0 = effectivePlacementAabb(
      { offsetXInches: 0, offsetYInches: 0, designWidthInches: 2 },
      100, 300,
    );
    const b0 = effectivePlacementAabb(
      { offsetXInches: 3, offsetYInches: 0, designWidthInches: 2 },
      100, 300,
    );
    expect(boxesOverlap(a0, b0)).toBe(false);

    const a90 = effectivePlacementAabb(
      { offsetXInches: 0, offsetYInches: 0, designWidthInches: 2, rotationDegrees: 90 },
      100, 300,
    );
    expect(boxesOverlap(a90, b0)).toBe(true);
  });
});
