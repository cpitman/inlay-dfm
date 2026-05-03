import type { Layer } from '@/types';

/**
 * Parse a viewBox attribute string ("x y w h") into its four components.
 * After the parse-time whitespace trim, viewBox origins (x, y) can be
 * non-zero, so any code that emits geometry relative to the viewBox
 * needs the origin to align with unchanged layer fragments.
 */
export function parseViewBox(viewBox: string): { x: number; y: number; w: number; h: number } {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  return {
    x: Number.isFinite(parts[0]) ? parts[0] : 0,
    y: Number.isFinite(parts[1]) ? parts[1] : 0,
    w: Number.isFinite(parts[2]) ? parts[2] : 0,
    h: Number.isFinite(parts[3]) ? parts[3] : 0,
  };
}

/** Wrap a single layer's fragment as a standalone, renderable SVG document. */
export function layerToStandaloneSvg(layer: Layer, viewBox: string, w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">
${layer.svgFragment}
</svg>`;
}

/**
 * Rasterize an SVG document string to an `OffscreenCanvas`. Used by
 * the DFM analyzer and the layer-order pre-pass to extract per-layer
 * pixel masks at any chosen resolution.
 *
 * The canvas is filled white before draw so non-painted regions
 * threshold to "background" (luma ≥ 220) consistently across SVGs
 * with or without an explicit fill.
 */
export async function renderSvgToCanvas(
  svgString: string,
  canvasW: number,
  canvasH: number,
): Promise<OffscreenCanvas> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasW, canvasH);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvasW, canvasH); resolve(); };
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return oc;
}

/**
 * Combine per-layer SVG fragments into a single rendered SVG. Layers are emitted
 * in the order given — later layers stack on top of earlier ones (matches the
 * staged-inlay z-order: earlier inlay extensions are covered by later inlays).
 */
export function combineLayers(layers: Layer[], viewBox: string, w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">
${layers.map(l => l.svgFragment).join('\n')}
</svg>`;
}

/** Replace one layer's fragment by colorHex. Returns a new array; original is untouched. */
export function replaceLayerFragment(layers: Layer[], colorHex: string, svgFragment: string): Layer[] {
  return layers.map(l => (l.colorHex === colorHex ? { ...l, svgFragment } : l));
}

/** Reorder layers to match a given colorHex order. Unmatched layers keep their original index. */
export function reorderLayers(layers: Layer[], colorOrder: string[]): Layer[] {
  const map = new Map(layers.map(l => [l.colorHex, l]));
  const ordered: Layer[] = [];
  for (const c of colorOrder) {
    const l = map.get(c);
    if (l) { ordered.push(l); map.delete(c); }
  }
  // Append any layers not mentioned in colorOrder (defensive)
  for (const l of map.values()) ordered.push(l);
  return ordered;
}
