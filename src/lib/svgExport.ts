import type { VectorData } from '@/types';
import { svgFragmentToMultiPolygon, multiPolygonToSvgFragment } from './polygonParser';

/**
 * Build a clean export SVG: every layer's geometry is unioned into a
 * single canonical MultiPolygon and emitted as one `<path>` per layer.
 * CAM tools expect contiguous, non-overlapping geometry per cut — our
 * in-app layers can contain multiple overlapping `<path>` elements
 * after `fillEnclosedHoles` appended new regions, and those overlaps
 * confuse CAM toolpath generators even though they render identically
 * in the browser.
 *
 * Polygon-native: `svgFragmentToMultiPolygon` parses every shape in
 * the layer (paths, polygons, rects, circles, ellipses), respects
 * each path's fill-rule (nonzero vs evenodd), and self-unions the
 * result via Clipper. The output is one MultiPolygon under even-odd
 * with overlaps merged. `multiPolygonToSvgFragment` then emits a
 * single `<path d="…" fill-rule="evenodd" fill="#…">` per layer.
 *
 * No raster step. Vertex coordinates come straight from the source
 * Bezier flattening (chord error ≤ 0.05 design units), much tighter
 * than the prior round-trip's ~1 px Douglas-Peucker tolerance.
 */
export function buildUnionedSvgString(vector: VectorData): string {
  const fragments: string[] = [];
  for (const layer of vector.layers) {
    const mp = svgFragmentToMultiPolygon(layer.svgFragment);
    if (mp.length === 0) continue;
    const path = multiPolygonToSvgFragment(mp, layer.colorHex);
    if (path) fragments.push(path);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.viewBox}" width="${vector.naturalWidth}" height="${vector.naturalHeight}">
${fragments.join('\n')}
</svg>`;
}

/** Trigger a browser download of the current design as an SVG file. */
export function downloadSvg(vector: VectorData, filenameHint?: string): void {
  const svgString = buildUnionedSvgString(vector);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = svgFileName(vector, filenameHint);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function svgFileName(vector: VectorData, hint?: string): string {
  const base = (hint ?? vector.fileName).replace(/\.(svg|dxf)$/i, '');
  return `${base || 'design'}.modified.svg`;
}
