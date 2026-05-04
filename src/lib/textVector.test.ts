import { describe, it, expect, vi, beforeEach } from 'vitest';
import { textToVectorData, TEXT_FONT_CATALOG } from './textVector';

// Mock opentype.js with a tiny stub: parse() returns a Font whose
// getPath returns a Path with a bounding box and a toSVG output —
// just enough for textToVectorData to assemble a VectorData. The
// real opentype.js is exercised indirectly when the dev server
// loads a real .ttf at runtime; this test pins the synthesis-layer
// contract.
vi.mock('opentype.js', () => {
  // Tiny stub: each character → one glyph with a 10-unit advance and
  // a single moveTo/lineTo path. textToVectorData walks glyphs and
  // assembles them into the synthesized path; this gives just enough
  // shape (bounding box scales with content length) to validate the
  // result envelope.
  class FakePath {
    commands: Array<{ type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }> = [];
    getBoundingBox() {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const c of this.commands) {
        const xs = [c.x, c.x1, c.x2].filter((v): v is number => typeof v === 'number');
        const ys = [c.y, c.y1, c.y2].filter((v): v is number => typeof v === 'number');
        for (const x of xs) { if (x < x1) x1 = x; if (x > x2) x2 = x; }
        for (const y of ys) { if (y < y1) y1 = y; if (y > y2) y2 = y; }
      }
      return { x1, y1, x2, y2 };
    }
    toPathData() {
      return this.commands.map(c => {
        if (c.type === 'M') return `M${c.x} ${c.y}`;
        if (c.type === 'L') return `L${c.x} ${c.y}`;
        if (c.type === 'Z') return 'Z';
        return '';
      }).join(' ');
    }
  }
  const makeGlyph = () => ({
    advanceWidth: 1000, // in font units
    getPath: (x: number, y: number) => {
      const p = new FakePath();
      // Tiny "glyph" shape: a 10×80 box at (x, y).
      p.commands = [
        { type: 'M', x,        y       },
        { type: 'L', x: x + 10, y      },
        { type: 'L', x: x + 10, y: y + 80 },
        { type: 'L', x,        y: y + 80 },
        { type: 'Z' },
      ];
      return p;
    },
  });
  const fakeFont = {
    unitsPerEm: 1000,
    charToGlyph: () => makeGlyph(),
  };
  return {
    parse: () => fakeFont,
    Path: FakePath,
  };
});

beforeEach(() => {
  // Stub the global fetch so loadFont's network step resolves.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch);
});

describe('TEXT_FONT_CATALOG', () => {
  it('lists all 3 families × 4 styles = 12 entries', () => {
    expect(TEXT_FONT_CATALOG).toHaveLength(12);
  });
  it('every entry has a unique (family, style) pair', () => {
    const keys = new Set(TEXT_FONT_CATALOG.map(d => `${d.family}/${d.style}`));
    expect(keys.size).toBe(12);
  });
  it('every entry points to a /fonts/*.ttf URL', () => {
    for (const d of TEXT_FONT_CATALOG) {
      expect(d.url.startsWith('/fonts/')).toBe(true);
      expect(d.url.endsWith('.ttf')).toBe(true);
    }
  });
});

describe('textToVectorData', () => {
  it('throws on empty content', async () => {
    await expect(textToVectorData({
      content: '',
      fontFamily: 'Inter',
      fontStyle: 'regular',
      species: 'cherry',
    })).rejects.toThrow(/empty/i);
  });

  it('produces a VectorData with the expected shape', async () => {
    const v = await textToVectorData({
      content: 'Hello',
      fontFamily: 'Inter',
      fontStyle: 'regular',
      species: 'cherry',
    });

    // Single layer keyed to the species's base color (lowercased).
    expect(v.layers).toHaveLength(1);
    expect(v.layers[0].colorHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(v.layers[0].svgFragment).toContain('<path');
    expect(v.layers[0].svgFragment).toContain(`fill="${v.layers[0].colorHex}"`);

    // Detected colors mirrors the layer set.
    expect(v.detectedColors).toEqual([v.layers[0].colorHex]);

    // Synthesized dimensions track the (mocked) bounding box.
    expect(v.naturalWidth).toBeGreaterThan(0);
    expect(v.naturalHeight).toBeGreaterThan(0);
    expect(v.viewBox).toBe(`0 0 ${v.naturalWidth} ${v.naturalHeight}`);

    // Wrapped svgString includes both viewBox and the layer fragment.
    expect(v.svgString).toContain(v.viewBox);
    expect(v.svgString).toContain(v.layers[0].svgFragment);

    // Filed as an SVG so downstream consumers (validators, etc.)
    // route it through the SVG path, but with a slug-style fileName
    // so it's distinguishable in saves.
    expect(v.fileType).toBe('svg');
    expect(v.fileName).toMatch(/^text-/);
    expect(v.fileName).toContain('hello');
  });

  it('width scales with content length (sanity for the mock)', async () => {
    const a = await textToVectorData({
      content: 'A',         fontFamily: 'Inter', fontStyle: 'regular', species: 'walnut',
    });
    const longer = await textToVectorData({
      content: 'AAAAAAAAAA', fontFamily: 'Inter', fontStyle: 'regular', species: 'walnut',
    });
    expect(longer.naturalWidth).toBeGreaterThan(a.naturalWidth);
  });

  it('different species → different layer color', async () => {
    const a = await textToVectorData({
      content: 'X', fontFamily: 'Inter', fontStyle: 'regular', species: 'cherry',
    });
    const b = await textToVectorData({
      content: 'X', fontFamily: 'Inter', fontStyle: 'regular', species: 'maple',
    });
    expect(a.layers[0].colorHex).not.toBe(b.layers[0].colorHex);
  });

  it('layer colorHex is always lowercase', async () => {
    const v = await textToVectorData({
      content: 'X', fontFamily: 'Inter', fontStyle: 'regular', species: 'cherry',
    });
    expect(v.layers[0].colorHex).toBe(v.layers[0].colorHex.toLowerCase());
  });
});
