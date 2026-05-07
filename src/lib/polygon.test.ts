import { describe, it, expect } from 'vitest';
import {
  ringSignedArea,
  multiPolygonArea,
  multiPolygonSignedArea,
  multiPolygonPerimeter,
  multiPolygonBounds,
  multiPolygonIsEmpty,
  type Ring,
  type MultiPolygon,
} from './polygon';

const square: Ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const squareCW: Ring = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
const innerSquare: Ring = [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }];

describe('ringSignedArea', () => {
  it('CCW unit square has area +1', () => {
    expect(ringSignedArea(square)).toBeCloseTo(1);
  });
  it('CW unit square has signed area −1', () => {
    expect(ringSignedArea(squareCW)).toBeCloseTo(-1);
  });
  it('degenerate (< 3 vertices) returns 0', () => {
    expect(ringSignedArea([])).toBe(0);
    expect(ringSignedArea([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(0);
  });
});

describe('multiPolygonArea', () => {
  it('empty multi-polygon has 0 area', () => {
    expect(multiPolygonArea([])).toBe(0);
  });
  it('single CCW square has area 1', () => {
    expect(multiPolygonArea([square])).toBeCloseTo(1);
  });
  it('square with CW inner hole (outer 1 + hole −0.25) → |0.75| = 0.75 area', () => {
    // Even-odd interpretation: net signed area (CCW outer + CW hole)
    // is 1 − 0.25 = 0.75. Magnitude = 0.75.
    const sqCWInner = innerSquare.slice().reverse();
    const mp: MultiPolygon = [square, sqCWInner];
    expect(multiPolygonArea(mp)).toBeCloseTo(0.75);
  });
  it('signed area can be negative for an all-CW input', () => {
    expect(multiPolygonSignedArea([squareCW])).toBeCloseTo(-1);
  });
});

describe('multiPolygonPerimeter', () => {
  it('unit square has perimeter 4', () => {
    expect(multiPolygonPerimeter([square])).toBeCloseTo(4);
  });
  it('square with inner hole sums both perimeters', () => {
    expect(multiPolygonPerimeter([square, innerSquare])).toBeCloseTo(4 + 2);
  });
});

describe('multiPolygonBounds', () => {
  it('returns null for empty', () => {
    expect(multiPolygonBounds([])).toBeNull();
  });
  it('reports inclusive AABB of all rings', () => {
    expect(multiPolygonBounds([square])).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });
});

describe('multiPolygonIsEmpty', () => {
  it('empty array', () => {
    expect(multiPolygonIsEmpty([])).toBe(true);
  });
  it('only-degenerate rings', () => {
    expect(multiPolygonIsEmpty([[{ x: 0, y: 0 }]])).toBe(true);
    expect(multiPolygonIsEmpty([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])).toBe(true);
  });
  it('valid rings', () => {
    expect(multiPolygonIsEmpty([square])).toBe(false);
  });
});
