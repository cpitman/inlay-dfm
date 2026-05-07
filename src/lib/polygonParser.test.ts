import { describe, it, expect } from 'vitest';
import { svgPathToRings, multiPolygonToSvgPathD, multiPolygonToSvgFragment } from './polygonParser';
import { multiPolygonArea, type MultiPolygon } from './polygon';

describe('svgPathToRings: lines', () => {
  it('M + L + L + L + Z is a quad with 4 vertices', () => {
    const rings = svgPathToRings('M 0 0 L 10 0 L 10 10 L 0 10 Z');
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
    expect(rings[0][0]).toEqual({ x: 0, y: 0 });
    expect(rings[0][2]).toEqual({ x: 10, y: 10 });
  });

  it('drops a closing duplicate vertex', () => {
    // Some authoring tools emit `M…L…L…L p0 Z` with the final L
    // re-stating the M-anchor. The parser should strip it.
    const rings = svgPathToRings('M 0 0 L 10 0 L 10 10 L 0 10 L 0 0 Z');
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('multiple subpaths produce multiple rings', () => {
    const rings = svgPathToRings('M 0 0 L 1 0 L 1 1 L 0 1 Z M 5 5 L 6 5 L 6 6 L 5 6 Z');
    expect(rings).toHaveLength(2);
  });

  it('open subpath without Z is included if non-degenerate', () => {
    const rings = svgPathToRings('M 0 0 L 10 0 L 10 10 L 0 10');
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('relative coords are converted to absolute', () => {
    const rings = svgPathToRings('M 5 5 l 10 0 l 0 10 l -10 0 z');
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual({ x: 5, y: 5 });
    expect(rings[0][1]).toEqual({ x: 15, y: 5 });
    expect(rings[0][2]).toEqual({ x: 15, y: 15 });
  });

  it('horizontal/vertical line commands work', () => {
    const rings = svgPathToRings('M 0 0 H 10 V 10 H 0 Z');
    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });
});

describe('svgPathToRings: cubic Beziers', () => {
  it('a flat cubic flattens to ~2 segments', () => {
    // P0=(0,0) P1=(10,0) P2=(20,0) P3=(30,0) — collinear, perfectly flat.
    const rings = svgPathToRings('M 0 0 C 10 0 20 0 30 0 L 30 10 L 0 10 Z');
    expect(rings).toHaveLength(1);
    // The flat cubic terminates at (30, 0); plus M, then L L = 4 corners total.
    expect(rings[0].length).toBeGreaterThanOrEqual(4);
    expect(rings[0].length).toBeLessThanOrEqual(8); // tolerate small subdivision
  });

  it('a curvy cubic produces many segments at default flatness', () => {
    const rings = svgPathToRings('M 0 0 C 0 50 50 50 50 0 Z');
    // Single-curve subpath; closing snaps back to (0, 0). Should
    // have well above the 3-vertex degenerate threshold.
    expect(rings).toHaveLength(1);
    expect(rings[0].length).toBeGreaterThan(8);
  });

  it('flatness controls subdivision density', () => {
    const tight = svgPathToRings('M 0 0 C 0 50 50 50 50 0 Z', 0.01);
    const loose = svgPathToRings('M 0 0 C 0 50 50 50 50 0 Z', 1.0);
    expect(tight[0].length).toBeGreaterThan(loose[0].length);
  });
});

describe('svgPathToRings: drops degenerate', () => {
  it('a sub-3-vertex ring is dropped', () => {
    const rings = svgPathToRings('M 0 0 L 1 1 Z');
    expect(rings).toHaveLength(0);
  });
});

describe('multiPolygonToSvgPathD', () => {
  it('emits one M…L…Z subpath per ring', () => {
    const mp: MultiPolygon = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    ];
    const d = multiPolygonToSvgPathD(mp);
    expect(d).toBe('M 0 0 L 10 0 L 10 10 Z');
  });

  it('two rings produce two subpaths', () => {
    const mp: MultiPolygon = [
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
      [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }],
    ];
    const d = multiPolygonToSvgPathD(mp);
    expect(d.match(/M /g)).toHaveLength(2);
    expect(d.match(/Z/g)).toHaveLength(2);
  });

  it('formats numbers with trailing-zero trim', () => {
    const mp: MultiPolygon = [[{ x: 1.5, y: 2.0 }, { x: 3, y: 0 }, { x: 0, y: 0 }]];
    expect(multiPolygonToSvgPathD(mp)).toBe('M 1.5 2 L 3 0 L 0 0 Z');
  });

  it('drops degenerate rings', () => {
    const mp: MultiPolygon = [[{ x: 0, y: 0 }, { x: 1, y: 1 }]];
    expect(multiPolygonToSvgPathD(mp)).toBe('');
  });
});

describe('parse → emit → parse round-trip', () => {
  it('preserves a square exactly', () => {
    const original = svgPathToRings('M 0 0 L 10 0 L 10 10 L 0 10 Z');
    const d = multiPolygonToSvgPathD(original);
    const round = svgPathToRings(d);
    expect(round).toEqual(original);
  });

  it('preserves area within numerical tolerance for a curvy path', () => {
    const original = svgPathToRings('M 0 0 C 0 50 50 50 50 0 L 50 -20 L 0 -20 Z');
    const d = multiPolygonToSvgPathD(original, 6);
    const round = svgPathToRings(d);
    expect(multiPolygonArea(round)).toBeCloseTo(multiPolygonArea(original), 3);
  });
});

describe('multiPolygonToSvgFragment', () => {
  it('emits a complete <path /> with fill + fill-rule', () => {
    const mp: MultiPolygon = [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]];
    const out = multiPolygonToSvgFragment(mp, '#ff0000');
    expect(out).toContain('fill="#ff0000"');
    expect(out).toContain('fill-rule="evenodd"');
    expect(out).toContain('d="M 0 0 L 1 0 L 1 1 Z"');
  });

  it('returns empty string for empty input', () => {
    expect(multiPolygonToSvgFragment([], '#ff0000')).toBe('');
  });

  it('passes through extra attributes', () => {
    const mp: MultiPolygon = [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]];
    const out = multiPolygonToSvgFragment(mp, '#ff0000', 'stroke="black"');
    expect(out).toContain('stroke="black"');
  });
});
