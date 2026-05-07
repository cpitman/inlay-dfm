import type { VectorData } from '@/types';
import { parseViewBox, rasterizeLayerToBinaryMask } from './svgLayers';
import { maskToSvgPath } from './maskToPath';

// Higher than the analysis canvas (1200): export is a one-shot, and finer
// detail makes for cleaner CAM toolpaths. Linear cost in pixel count.
const EXPORT_RASTER_WIDTH = 2400;

/**
 * Build a clean export SVG: every layer's geometry is unioned into a single
 * traced polygon path. CAM tools expect contiguous, non-overlapping geometry
 * per cut — our in-app layers can contain multiple overlapping <path> elements
 * after fillEnclosedHoles appended new regions, and those overlaps confuse
 * CAM toolpath generators even though they render
 * identically in the browser.
 *
 * The round-trip (Bezier → mask → marching squares + Douglas-Peucker → polygon)
 * shifts boundaries by ~1 px in places. That's fine for a CAM hand-off — CAM
 * tools have their own tolerance — and is the price of producing clean topology.
 */
export async function buildUnionedSvgString(vector: VectorData): Promise<string> {
  const aspect = vector.naturalHeight / vector.naturalWidth;
  const rasterW = EXPORT_RASTER_WIDTH;
  const rasterH = Math.max(1, Math.round(rasterW * aspect));
  const vb = parseViewBox(vector.viewBox);
  const scaleX = vector.naturalWidth  / rasterW;
  const scaleY = vector.naturalHeight / rasterH;

  const fragments: string[] = [];
  for (const layer of vector.layers) {
    const mask = await rasterizeLayerToBinaryMask(
      layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight, rasterW, rasterH,
    );
    const path = maskToSvgPath(mask, rasterW, rasterH, {
      fill: layer.colorHex,
      scaleX,
      scaleY,
      offsetX: vb.x,
      offsetY: vb.y,
      simplifyEpsilonPx: 1,
      minAreaPx: 4,
    });
    if (path) fragments.push(path);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.viewBox}" width="${vector.naturalWidth}" height="${vector.naturalHeight}">
${fragments.join('\n')}
</svg>`;
}

/** Trigger a browser download of the current design as an SVG file. */
export async function downloadSvg(vector: VectorData, filenameHint?: string): Promise<void> {
  const svgString = await buildUnionedSvgString(vector);
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
