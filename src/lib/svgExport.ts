import type { Layer, VectorData } from '@/types';
import { layerToStandaloneSvg, parseViewBox } from './svgLayers';
import { maskToSvgPath } from './maskToPath';

// Higher than the analysis canvas (1200): export is a one-shot, and finer
// detail makes for cleaner CAM toolpaths. Linear cost in pixel count.
const EXPORT_RASTER_WIDTH = 2400;
// Mirror of the per-layer mask threshold used elsewhere — luma < 220 is "in layer".
const MASK_BRIGHTNESS_MAX = 220;

/**
 * Rasterize one layer to a binary mask. Same approach used by the analysis
 * pipeline: render the layer's fragment alone over a white background, then
 * threshold by luminance.
 */
async function rasterizeLayerToMask(
  layer: Layer,
  viewBox: string,
  naturalWidth: number,
  naturalHeight: number,
  rasterW: number,
  rasterH: number,
): Promise<Uint8Array> {
  const oc = new OffscreenCanvas(rasterW, rasterH);
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, rasterW, rasterH);

  const layerSvg = layerToStandaloneSvg(layer, viewBox, naturalWidth, naturalHeight);
  const blob = new Blob([layerSvg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, rasterW, rasterH); resolve(); };
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const { data } = ctx.getImageData(0, 0, rasterW, rasterH);
  const n = rasterW * rasterH;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luma < MASK_BRIGHTNESS_MAX) mask[i] = 1;
  }
  return mask;
}

/**
 * Build a clean export SVG: every layer's geometry is unioned into a single
 * traced polygon path. CAM tools expect contiguous, non-overlapping geometry
 * per cut — our in-app layers can contain multiple overlapping <path> elements
 * after fillEnclosedHoles / extendForRegistration appended new regions, and
 * those overlaps confuse CAM toolpath generators even though they render
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
    const mask = await rasterizeLayerToMask(
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
