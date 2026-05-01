import { describe, it, expect } from 'vitest';
import { findEnclosedHoles } from './morphology';

function makeRect(w: number, h: number, x1: number, y1: number, x2: number, y2: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) m[y * w + x] = 1;
  return m;
}

describe('findEnclosedHoles', () => {
  it('returns no holes for a solid rectangle', () => {
    const w = 20, h = 20;
    const mask = makeRect(w, h, 5, 5, 15, 15);
    const holes = findEnclosedHoles(mask, w, h);
    expect(holes).toHaveLength(0);
  });

  it('finds a single-pixel hole punched out of a solid square', () => {
    const w = 20, h = 20;
    const mask = makeRect(w, h, 5, 5, 15, 15);
    // Punch out one interior pixel at (10, 10).
    mask[10 * w + 10] = 0;

    const holes = findEnclosedHoles(mask, w, h);
    expect(holes).toHaveLength(1);
    expect(holes[0].pixels).toEqual([10 * w + 10]);
  });

  it('finds two disjoint holes as separate components', () => {
    const w = 30, h = 30;
    const mask = makeRect(w, h, 5, 5, 25, 25);
    // Hole A: 2×2 at (10..11, 10..11)
    for (let y = 10; y <= 11; y++) for (let x = 10; x <= 11; x++) mask[y * w + x] = 0;
    // Hole B: 1 pixel at (20, 20)
    mask[20 * w + 20] = 0;

    const holes = findEnclosedHoles(mask, w, h);
    expect(holes).toHaveLength(2);
    const sizes = holes.map(h => h.pixels.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 4]);
  });

  it('does NOT count canvas-edge-touching non-mask regions as holes', () => {
    const w = 20, h = 20;
    // Rectangle that touches the right canvas edge — the non-mask area to
    // the right of the rectangle is "outside" (reaches the canvas edge),
    // not an enclosed hole.
    const mask = makeRect(w, h, 0, 5, 15, 15);
    // Even though the top-left non-mask region is bounded on most sides
    // by the rectangle, it touches the canvas edge → outside.
    const holes = findEnclosedHoles(mask, w, h);
    expect(holes).toHaveLength(0);
  });

  it('handles an empty mask without crashing (everything is outside)', () => {
    const w = 5, h = 5;
    const mask = new Uint8Array(w * h);
    const holes = findEnclosedHoles(mask, w, h);
    expect(holes).toHaveLength(0);
  });

  it('detects a donut hole', () => {
    // 11×11 mask filled, with a 5×5 hole carved out of the middle.
    const w = 13, h = 13;
    const mask = makeRect(w, h, 1, 1, 12, 12);
    for (let y = 4; y < 9; y++) for (let x = 4; x < 9; x++) mask[y * w + x] = 0;

    const holes = findEnclosedHoles(mask, w, h);
    expect(holes).toHaveLength(1);
    expect(holes[0].pixels.length).toBe(25);
  });
});
