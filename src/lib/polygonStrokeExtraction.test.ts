import { describe, it, expect } from 'vitest';
import {
  parseSvgStrokeElements,
  extractStrokesPolygon,
} from './polygonStrokeExtraction';
import {
  multiPolygonOffsetOpenPolyline,
  multiPolygonOffsetClosedLine,
} from './clipperOps';
import { multiPolygonArea, multiPolygonIsEmpty } from './polygon';

describe('multiPolygonOffsetOpenPolyline', () => {
  it('produces a band of approximately 2×length for a straight segment', () => {
    const band = multiPolygonOffsetOpenPolyline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      1,
      { endType: 'butt' },
    );
    // Butt caps: rectangle 10×2 = area 20.
    expect(multiPolygonArea(band)).toBeCloseTo(20, 1);
  });

  it('produces a longer band with square caps', () => {
    const band = multiPolygonOffsetOpenPolyline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      1,
      { endType: 'square' },
    );
    // Square caps add 1 (= half-width) to each end → length 12, width 2 → area 24.
    expect(multiPolygonArea(band)).toBeCloseTo(24, 1);
  });

  it('returns empty for delta = 0', () => {
    expect(multiPolygonOffsetOpenPolyline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      0,
    )).toEqual([]);
  });
});

describe('multiPolygonOffsetClosedLine', () => {
  it('produces an annular band around a closed square', () => {
    const band = multiPolygonOffsetClosedLine(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      1,
    );
    // Outer: 12×12, inner: 8×8, band area ≈ 144 - 64 = 80 (with rounded corners
    // the outer is slightly less than 144 but within ~1%).
    expect(multiPolygonArea(band)).toBeGreaterThan(75);
    expect(multiPolygonArea(band)).toBeLessThan(82);
  });
});

describe('parseSvgStrokeElements', () => {
  it('extracts stroke metadata from a single <line>', () => {
    const svg = `<svg><line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-width="2"/></svg>`;
    const els = parseSvgStrokeElements(svg);
    expect(els).toHaveLength(1);
    expect(els[0].hasStroke).toBe(true);
    expect(els[0].strokeWidth).toBe(2);
    expect(els[0].subpaths).toEqual([{
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      closed: false,
    }]);
  });

  it('returns hasStroke=false for stroke="none"', () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" stroke="none" stroke-width="2"/></svg>`;
    const els = parseSvgStrokeElements(svg);
    expect(els[0].hasStroke).toBe(false);
  });

  it('treats stroke specified via inline style', () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" style="stroke: red; stroke-width: 3;"/></svg>`;
    const els = parseSvgStrokeElements(svg);
    expect(els[0].hasStroke).toBe(true);
    expect(els[0].strokeWidth).toBe(3);
  });

  it('preserves document order via zIndex', () => {
    const svg = `
      <svg>
        <rect x="0" y="0" width="10" height="10" stroke="#000"/>
        <circle cx="5" cy="5" r="3" stroke="#000"/>
        <line x1="0" y1="0" x2="10" y2="0" stroke="#000"/>
      </svg>
    `;
    const els = parseSvgStrokeElements(svg);
    expect(els.map(e => e.zIndex)).toEqual([0, 1, 2]);
  });

  it('flattens path data with cubic bezier into points', () => {
    const svg = `<svg><path d="M 0 0 C 10 0 10 10 0 10" stroke="#000" stroke-width="1"/></svg>`;
    const els = parseSvgStrokeElements(svg);
    expect(els).toHaveLength(1);
    expect(els[0].subpaths).toHaveLength(1);
    // Flattened curve has many points.
    expect(els[0].subpaths[0].points.length).toBeGreaterThan(2);
    expect(els[0].subpaths[0].closed).toBe(false);
  });

  it('marks Z-closed subpaths as closed', () => {
    const svg = `<svg><path d="M 0 0 L 10 0 L 10 10 L 0 10 Z" stroke="#000" stroke-width="1"/></svg>`;
    const els = parseSvgStrokeElements(svg);
    expect(els[0].subpaths[0].closed).toBe(true);
  });

  it('detects fill=none correctly', () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" stroke="#000" fill="none"/></svg>`;
    const els = parseSvgStrokeElements(svg);
    expect(els[0].hasFill).toBe(false);
  });
});

describe('extractStrokesPolygon', () => {
  it('produces an empty result for an SVG with no strokes', () => {
    const svg = `<svg><rect x="0" y="0" width="10" height="10" fill="red"/></svg>`;
    const r = extractStrokesPolygon(svg);
    expect(multiPolygonIsEmpty(r.allStrokesMP)).toBe(true);
    expect(multiPolygonIsEmpty(r.visibleStrokesMP)).toBe(true);
  });

  it('extracts stroke band for a single stroked line', () => {
    const svg = `<svg><line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-width="2"/></svg>`;
    const r = extractStrokesPolygon(svg);
    expect(multiPolygonIsEmpty(r.allStrokesMP)).toBe(false);
    // Stroke band area for length 10, width 2, butt caps = 20.
    expect(multiPolygonArea(r.allStrokesMP)).toBeCloseTo(20, 0);
  });

  it('subtracts later fills from visibleStrokes (z-order)', () => {
    // Stroke at z=0 (drawn first). Fill on top at z=1 covers it.
    const svg = `
      <svg>
        <line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-width="2"/>
        <rect x="0" y="-5" width="10" height="10" fill="red"/>
      </svg>
    `;
    const r = extractStrokesPolygon(svg);
    // allStrokes still has the stroke band (just visibility differs).
    expect(multiPolygonIsEmpty(r.allStrokesMP)).toBe(false);
    // visibleStrokes is empty because the rect covers everything.
    expect(multiPolygonIsEmpty(r.visibleStrokesMP)).toBe(true);
  });

  it('preserves visibleStrokes when stroke is on top', () => {
    // Fill at z=0; stroke at z=1 (drawn last, on top).
    const svg = `
      <svg>
        <rect x="0" y="-5" width="10" height="10" fill="red"/>
        <line x1="0" y1="0" x2="10" y2="0" stroke="#000" stroke-width="2"/>
      </svg>
    `;
    const r = extractStrokesPolygon(svg);
    expect(multiPolygonArea(r.visibleStrokesMP)).toBeCloseTo(20, 0);
  });
});
