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
 * Wrap an SVG document with an injected `<style>` rule that applies
 * to every element. `!important` on author CSS overrides SVG
 * presentation attributes, so this rewrites stroke / fill /
 * shape-rendering regardless of how the source set them.
 */
export function withInjectedStyle(svgText: string, css: string): string {
  return svgText.replace(/<svg\b[^>]*>/i, m => `${m}<style>${css}</style>`);
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
 * Alpha threshold for the binary-mask convention. Pixels whose
 * rendered alpha ≥ this value count as "in layer." Lower threshold =
 * wider masks (more anti-aliased band captured); higher threshold =
 * tighter masks.
 *
 * Calibrated to roughly match the legacy `luma < 220` behavior for
 * typical dark strokes: a 12% pixel coverage with a black stroke
 * over white blends to luma ~225, just at the old threshold's edge.
 * Alpha 30 ≈ 12% coverage, catching the same anti-aliased boundary
 * pixels — but consistently, regardless of layer color (the old
 * luma threshold caught boundary pixels for dark strokes but missed
 * them for light/grayish layers, which is what produced the
 * adjacent-layer mask gaps).
 */
export const MASK_ALPHA_THRESHOLD = 30;

/**
 * Like `renderSvgToCanvas` but does NOT pre-fill the canvas with
 * white. Pixels not painted by the SVG keep alpha = 0; painted
 * pixels (including anti-aliased boundaries) keep their natural
 * geometric-coverage alpha. Used by mask extraction (where the
 * MASK_ALPHA_THRESHOLD convention applies); visual rendering
 * stays on `renderSvgToCanvas` so wood-tone backdrops show through.
 *
 * `crisp: true` injects `* { shape-rendering: crispEdges }` to
 * request no anti-aliasing. Counterintuitively, this hurts the
 * adjacent-layer-boundary case the mask pipeline cares about: AA
 * makes both adjacent layers' rasterizations register their soft
 * edges at the alpha threshold, so they overlap by ~1 px and tile
 * cleanly. With crispEdges, each layer's boundary is binary at its
 * own geometric edge, and any sub-pixel mismatch in the source SVG
 * becomes a hard 1-px gap where neither layer claims the pixel.
 * Measured on Pika: ear/body holes' uncovered counts went from
 * ~40 px (AA) to ~300+ px (crisp). The opt-in stays in the API
 * because it's measured infrastructure, but mask-extraction
 * callers should leave it OFF.
 */
export async function renderSvgToCanvasTransparent(
  svgString: string,
  canvasW: number,
  canvasH: number,
  opts?: { crisp?: boolean },
): Promise<OffscreenCanvas> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  // Intentionally NO fillRect — leave the canvas transparent.
  const finalSvg = opts?.crisp
    ? withInjectedStyle(svgString, '*{shape-rendering:crispEdges}')
    : svgString;
  const blob = new Blob([finalSvg], { type: 'image/svg+xml' });
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
 * Convenience: Layer → standalone SVG → transparent canvas →
 * Uint8Array binary mask via `MASK_ALPHA_THRESHOLD`. The single
 * canonical implementation of "what does it mean for a pixel to
 * belong to this layer's mask" — replaces the duplicated white-
 * fillRect + drawImage + luma-threshold pattern that used to live
 * inline at every rasterization site.
 *
 * Pass `opts.crisp: true` to disable AA at rasterization (see
 * `renderSvgToCanvasTransparent`). Recommended for any caller that
 * wants a binary mask — alpha is then 0 or 255, eliminating the
 * sub-pixel boundary stragglers that adjacent-layer rasterizations
 * would otherwise leak under AA.
 */
export async function rasterizeLayerToBinaryMask(
  layer: Layer,
  viewBox: string,
  naturalWidth: number,
  naturalHeight: number,
  canvasW: number,
  canvasH: number,
  opts?: { crisp?: boolean },
): Promise<Uint8Array> {
  const svg = layerToStandaloneSvg(layer, viewBox, naturalWidth, naturalHeight);
  const oc = await renderSvgToCanvasTransparent(svg, canvasW, canvasH, opts);
  const ctx = oc.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvasW, canvasH).data;
  const n = canvasW * canvasH;
  const mask = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (data[k * 4 + 3] >= MASK_ALPHA_THRESHOLD) mask[k] = 1;
  }
  return mask;
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
