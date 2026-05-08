import { describe, it, expect } from 'vitest';
import { removeFullyOccludedRegions } from './removeOccludedRegions';
import { svgFragmentToMultiPolygon } from './polygonParser';
import { multiPolygonComponents } from './clipperOps';
import { multiPolygonArea } from './polygon';
import type { VectorData } from '@/types';

function fixture(layers: Array<{ colorHex: string; svgFragment: string }>): VectorData {
  return {
    svgString: '',
    layers: layers.map(l => ({ colorHex: l.colorHex, svgFragment: l.svgFragment })),
    naturalWidth: 100,
    naturalHeight: 100,
    viewBox: '0 0 100 100',
    fileName: 'test.svg',
    fileType: 'svg',
    detectedColors: layers.map(l => l.colorHex),
  };
}

const RED = '#ff0000';
const BLUE = '#0000ff';

describe('removeFullyOccludedRegions (polygon-native)', () => {
  it('removes a component fully covered by a later layer', async () => {
    const v = fixture([
      // Two disjoint red squares.
      { colorHex: RED, svgFragment: `<path d="M 10 10 L 20 10 L 20 20 L 10 20 Z M 50 50 L 60 50 L 60 60 L 50 60 Z" />` },
      // Later covers ONLY the second (50–60).
      { colorHex: BLUE, svgFragment: `<path d="M 45 45 L 65 45 L 65 65 L 45 65 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(1);
    // Removed area = 10×10 = 100 sq SVG units. At 0.01 sq in/unit² → 1 sq in.
    expect(r.removedAreaSqIn).toBeCloseTo(1, 4);
    // The remaining red is just the first square.
    const remaining = svgFragmentToMultiPolygon(r.layers[0].svgFragment);
    const components = multiPolygonComponents(remaining);
    expect(components).toHaveLength(1);
    expect(multiPolygonArea([components[0].outer])).toBeCloseTo(100, 1);
  });

  it('keeps a component that is only partially covered', async () => {
    const v = fixture([
      { colorHex: RED,  svgFragment: `<path d="M 10 10 L 30 10 L 30 30 L 10 30 Z" />` },
      // Later covers only the LEFT half.
      { colorHex: BLUE, svgFragment: `<path d="M 5 5 L 20 5 L 20 35 L 5 35 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(0);
    expect(r.layers).toBe(v.layers);
  });

  it('keeps a component with NO coverage', async () => {
    const v = fixture([
      { colorHex: RED,  svgFragment: `<path d="M 10 10 L 30 10 L 30 30 L 10 30 Z" />` },
      { colorHex: BLUE, svgFragment: `<path d="M 50 50 L 60 50 L 60 60 L 50 60 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(0);
  });

  it('removes multiple fully-occluded components', async () => {
    // Three red squares; later layer covers all three.
    const reds = `<path d="M 10 10 L 15 10 L 15 15 L 10 15 Z M 30 30 L 35 30 L 35 35 L 30 35 Z M 60 60 L 65 60 L 65 65 L 60 65 Z" />`;
    const v = fixture([
      { colorHex: RED,  svgFragment: reds },
      { colorHex: BLUE, svgFragment: `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(3);
    // 3 × 25 = 75 sq SVG units = 0.75 sq in.
    expect(r.removedAreaSqIn).toBeCloseTo(0.75, 4);
  });

  it('removes a component covered by the UNION of multiple later layers', async () => {
    // Single red square; later layers split over it.
    const v = fixture([
      { colorHex: RED,  svgFragment: `<path d="M 10 10 L 30 10 L 30 30 L 10 30 Z" />` },
      // Layer 2: covers left half.
      { colorHex: '#00ff00', svgFragment: `<path d="M 5 5 L 20 5 L 20 35 L 5 35 Z" />` },
      // Layer 3 (later): covers right half.
      { colorHex: BLUE, svgFragment: `<path d="M 18 5 L 35 5 L 35 35 L 18 35 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(1);
  });

  it('lower (earlier) layers are irrelevant — only later layers count', async () => {
    const EARLIER = '#000000';
    const v = fixture([
      // Earlier layer that surrounds RED.
      { colorHex: EARLIER, svgFragment: `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z" />` },
      // RED is the target.
      { colorHex: RED,     svgFragment: `<path d="M 10 10 L 20 10 L 20 20 L 10 20 Z" />` },
      // BLUE (later) fully covers RED.
      { colorHex: BLUE,    svgFragment: `<path d="M 5 5 L 25 5 L 25 25 L 5 25 Z" />` },
    ]);
    // Earlier layer surrounds RED but it shouldn't matter for removal;
    // only the later BLUE coverage is relevant.
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(1);
  });

  it('no-op when target is the last layer', async () => {
    const v = fixture([
      { colorHex: BLUE, svgFragment: `<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z" />` },
      { colorHex: RED,  svgFragment: `<path d="M 10 10 L 20 10 L 20 20 L 10 20 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(0);
  });

  it('preserves component holes when keeping a component', async () => {
    // Square with a hole; later layer doesn't cover anything.
    const target = `<path d="M 0 0 L 50 0 L 50 50 L 0 50 Z M 20 20 L 20 30 L 30 30 L 30 20 Z" fill-rule="evenodd" />`;
    const v = fixture([
      { colorHex: RED,  svgFragment: target },
      { colorHex: BLUE, svgFragment: `<path d="M 80 80 L 90 80 L 90 90 L 80 90 Z" />` },
    ]);
    const r = await removeFullyOccludedRegions(v, RED, 10);
    expect(r.removedComponentCount).toBe(0);
    // Original is preserved (no removal happened).
    expect(r.layers).toBe(v.layers);
  });
});
