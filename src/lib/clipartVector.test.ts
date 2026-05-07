import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clipartToVectorData } from './clipartVector';
import type { ClipartManifestEntry } from './clipartCatalog';
import type { VectorData } from '@/types';

// `parseSvg` uses browser-only DOMParser; mock it out and assert the
// wiring (fetch URL, File wrapping, fileName override) instead.
vi.mock('./vectorParser', () => ({
  parseSvg: vi.fn(async (file: File): Promise<VectorData> => {
    const text = await file.text();
    return {
      svgString: text,
      layers: [{ colorHex: '#aa0000', svgFragment: '<path d="M0 0L10 10"/>' }],
      naturalWidth:  100,
      naturalHeight: 50,
      viewBox: '0 0 100 50',
      fileName: file.name,
      fileType: 'svg',
      detectedColors: ['#aa0000'],
    };
  }),
}));

const FOX_ENTRY: ClipartManifestEntry = {
  id: 'fox-running',
  title: 'Fox Running',
  tags: ['animal'],
  source: 'openclipart',
  sourceUrl: 'https://openclipart.org/detail/fox-running',
  license: 'CC0',
  colorCount: 1,
  colors: ['#aa0000'],
  aspectRatio: 2,
  rank: 5,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => `<svg viewBox="0 0 100 50"><path d="M0 0L10 10" fill="#aa0000"/></svg>`,
    headers: { get: () => 'image/svg+xml' },
  })) as unknown as typeof fetch);
});

describe('clipartToVectorData', () => {
  it('fetches /clipart/{id}.svg', async () => {
    await clipartToVectorData(FOX_ENTRY);
    expect(fetch).toHaveBeenCalledWith('/clipart/fox-running.svg');
  });

  it('returns a VectorData with the entry title as fileName', async () => {
    const v = await clipartToVectorData(FOX_ENTRY);
    expect(v.fileName).toBe('Fox Running');
    expect(v.fileType).toBe('svg');
    expect(v.layers).toHaveLength(1);
    expect(v.detectedColors).toEqual(['#aa0000']);
  });

  it('throws on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    })) as unknown as typeof fetch);
    await expect(clipartToVectorData(FOX_ENTRY)).rejects.toThrow(/fox-running/);
  });
});
