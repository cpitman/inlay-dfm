/**
 * "Stroke detection" — turn the visible stroke geometry of an SVG
 * upload (the line art / outlines / contours) into a filled-polygon
 * Layer the inlay pipeline can treat as just another color, AND
 * compute a per-fill subtraction so the outline visibly pokes
 * through the foreground fills wherever it was the topmost painted
 * thing in the original SVG.
 *
 * Two key passes happen here, both against the original SVG source
 * (the per-color buckets the parser emits already lost stroke
 * styling):
 *
 *   1. **Full stroke geometry** — render the SVG with all fills
 *      suppressed (`* { fill: none !important }`) and trace the
 *      resulting raster back to a filled polygon. That polygon
 *      becomes a Layer at index 0 if the user opts to inlay strokes
 *      — at the back, where `fillEnclosedHoles` can later expand it
 *      to one solid blob per outlined region.
 *
 *   2. **Visible-stroke subtraction** — render the SVG twice with
 *      strokes recolored to two distinct colors (#000 and #fff),
 *      diff per pixel. Pixels that differ are pixels where a stroke
 *      is the topmost painted thing in the original. Subtract those
 *      pixels from each fill layer's mask + retrace; the rebuilt
 *      `Layer[]` is what the QuoteApp swaps in when the user picks
 *      "inlay" so colored fills get a "window" exactly where the
 *      outline visibly pierced through in the source.
 */

import type { Layer } from '@/types';
import {
  MASK_ALPHA_THRESHOLD,
  parseViewBox,
  rasterizeLayerToBinaryMask,
  renderSvgToCanvas,
  renderSvgToCanvasTransparent,
  withInjectedStyle,
} from './svgLayers';
import { maskToSvgPath } from './maskToPath';
import { dilateMask } from './maskOps';

export interface StrokeExtraction {
  /** Polygon Layer for the full stroke geometry — covered + visible. */
  strokeLayer: Layer;
  /** Same length and color order as the input fillLayers, with each
   *  fragment retraced where the visible-stroke region overlapped.
   *  Layers untouched by strokes return their original svgFragment
   *  unchanged so we don't pay a trace cost or lose Bezier fidelity
   *  for them. */
  fillLayersWithStrokeSubtracted: Layer[];
}

/** Cheap pre-check: does the SVG source mention any non-`none` stroke?
 *  Used to skip the (relatively expensive) render-and-trace step on the
 *  vast majority of uploads that have no strokes at all. */
export function svgLooksLikeItHasStrokes(svgText: string): boolean {
  for (const m of svgText.matchAll(/\bstroke\s*=\s*["']([^"']+)["']/gi)) {
    const v = m[1].trim().toLowerCase();
    if (v && v !== 'none') return true;
  }
  for (const m of svgText.matchAll(/(?:^|[;{\s])stroke\s*:\s*([^;}"']+)/gi)) {
    const v = m[1].trim().toLowerCase();
    if (v && v !== 'none') return true;
  }
  return false;
}

const RASTER_WIDTH = 1200;
/**
 * Dilate the full-stroke raster by this many pixels before tracing
 * to a polygon. Marching-squares + Douglas-Peucker simplification at
 * `simplifyEpsilonPx: 1` can drift the polygon edge by ~1 px, leaving
 * a thin ring of pixels uncovered when downstream callers check
 * "are this stroke layer's holes fully covered by later fills?".
 * The 2 px overshoot guarantees the polygon spans the full true
 * stroke band even after DP. Visually invisible: this layer sits at
 * z-index 0 (back) and is covered by any fill above it. Mirrors
 * `TRACE_OVERSHOOT_PX` in `fillEnclosedHoles.ts`.
 */
const STROKE_TRACE_OVERSHOOT_PX = 2;

/** Render an SVG onto a WHITE-backed canvas and return its raw pixel
 *  data. Used by the recolored-strokes diff (where the visible-stroke
 *  detection compares RGB between two recolored renders — a transparent
 *  canvas would change the blend math and break the diff). */
async function renderToWhitePixels(svgText: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const oc = await renderSvgToCanvas(svgText, w, h);
  return oc.getContext('2d')!.getImageData(0, 0, w, h).data;
}

/** Render an SVG onto a TRANSPARENT canvas, return its alpha-thresholded
 *  binary mask. Used by mask-extraction paths that need consistent
 *  boundaries regardless of the layer's color (so adjacent layers don't
 *  leave 1-pixel gaps from luma threshold inconsistency). */
async function alphaMaskFromSvg(svgText: string, w: number, h: number): Promise<Uint8Array> {
  const oc = await renderSvgToCanvasTransparent(svgText, w, h);
  const data = oc.getContext('2d')!.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (data[i * 4 + 3] >= MASK_ALPHA_THRESHOLD) mask[i] = 1;
  }
  return mask;
}

/**
 * Run the full stroke-extraction + visible-stroke-subtraction pass.
 * Returns `null` when the cheap pre-check says no strokes are present,
 * or when the rendered "strokes-only" mask has too few set pixels to
 * be worth surfacing.
 */
export async function extractStrokeLayer(
  svgText: string,
  viewBox: string,
  naturalWidth: number,
  naturalHeight: number,
  fillLayers: readonly Layer[],
  existingColors: readonly string[],
): Promise<StrokeExtraction | null> {
  if (!svgLooksLikeItHasStrokes(svgText)) return null;

  const aspect = naturalHeight / naturalWidth;
  const rasterW = RASTER_WIDTH;
  const rasterH = Math.max(1, Math.round(rasterW * aspect));
  const n = rasterW * rasterH;

  // Strokes-only render → fullStrokeMask (geometry of the synthesized
  // outline layer). Alpha threshold so the mask consistently covers
  // the stroke band regardless of the source stroke's color.
  let fullStrokeMask: Uint8Array;
  try {
    fullStrokeMask = await alphaMaskFromSvg(
      withInjectedStyle(svgText, '*{fill:none !important}'),
      rasterW, rasterH,
    );
  } catch {
    return null;
  }

  let setCount = 0;
  for (let i = 0; i < n; i++) if (fullStrokeMask[i]) setCount++;
  const minSetPixels = Math.max(20, Math.round(n * 0.0005));
  if (setCount < minSetPixels) return null;

  // Visible-stroke mask via two recolored renders. Pixels where the
  // two renders differ are pixels where the topmost painted thing is
  // a stroke (no fill above covered it; both renders would show the
  // same fill color in that case).
  let visibleMask: Uint8Array;
  try {
    const blackData = await renderToWhitePixels(
      withInjectedStyle(svgText, '*{stroke:#000000 !important}'),
      rasterW, rasterH,
    );
    const whiteData = await renderToWhitePixels(
      withInjectedStyle(svgText, '*{stroke:#ffffff !important}'),
      rasterW, rasterH,
    );
    visibleMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (
        blackData[o]     !== whiteData[o] ||
        blackData[o + 1] !== whiteData[o + 1] ||
        blackData[o + 2] !== whiteData[o + 2]
      ) visibleMask[i] = 1;
    }
  } catch {
    // Fall back to using fullStrokeMask as the visible mask. Slightly
    // over-eager (some hidden strokes get treated as visible) but the
    // visual result is still acceptable.
    visibleMask = fullStrokeMask;
  }

  const vb = parseViewBox(viewBox);
  const traceOpts = {
    scaleX: naturalWidth  / rasterW,
    scaleY: naturalHeight / rasterH,
    offsetX: vb.x,
    offsetY: vb.y,
    simplifyEpsilonPx: 1,
    minAreaPx: 4,
  };

  // Build the strokeLayer's SVG fragment from the full stroke mask,
  // dilated by `STROKE_TRACE_OVERSHOOT_PX` so the polygon overshoots
  // its true band on every side, bridging marching-squares + DP
  // inset and ensuring downstream fills see 100% hole coverage. Use
  // a separate variable; the original `fullStrokeMask` stays precise
  // because the visible-stroke fallback below reads it directly.
  const tracedStrokeMask = dilateMask(fullStrokeMask, rasterW, rasterH, STROKE_TRACE_OVERSHOOT_PX);
  const strokePath = maskToSvgPath(tracedStrokeMask, rasterW, rasterH, {
    fill: '',
    ...traceOpts,
  });
  if (!strokePath) return null;
  const colorHex = pickStrokeColorHex(existingColors);
  const strokeLayer: Layer = {
    colorHex,
    svgFragment: strokePath.replace(/fill="[^"]*"/, `fill="${colorHex}"`),
  };

  // For each fill layer: rasterize solo at the same raster size via
  // the shared alpha-threshold helper, AND-NOT the visibleMask,
  // retrace if the subtraction changed anything.
  const fillLayersWithStrokeSubtracted: Layer[] = [];
  for (const layer of fillLayers) {
    let layerMask: Uint8Array;
    try {
      layerMask = await rasterizeLayerToBinaryMask(
        layer, viewBox, naturalWidth, naturalHeight, rasterW, rasterH,
      );
    } catch {
      // If this single layer fails to render, keep it untouched —
      // partial-failure is preferable to skipping the whole feature.
      fillLayersWithStrokeSubtracted.push(layer);
      continue;
    }
    let removed = 0;
    for (let i = 0; i < n; i++) {
      if (layerMask[i] && visibleMask[i]) {
        layerMask[i] = 0;
        removed++;
      }
    }
    if (removed === 0) {
      // No overlap with the visible stroke — preserve the original
      // fragment (and its higher-quality Bezier curves).
      fillLayersWithStrokeSubtracted.push(layer);
      continue;
    }
    const path = maskToSvgPath(layerMask, rasterW, rasterH, {
      fill: layer.colorHex,
      ...traceOpts,
    });
    fillLayersWithStrokeSubtracted.push({
      colorHex: layer.colorHex,
      svgFragment: path ?? '',
    });
  }

  return { strokeLayer, fillLayersWithStrokeSubtracted };
}

function pickStrokeColorHex(existing: readonly string[]): string {
  const taken = new Set(existing.map(c => c.toLowerCase()));
  const candidates = [
    '#0a0a0a', '#0b0b0b', '#0c0c0c', '#0d0d0d', '#0e0e0e', '#0f0f0f',
    '#1a1a1a', '#1b1b1b', '#1c1c1c', '#101010', '#111111', '#121212',
  ];
  for (const c of candidates) if (!taken.has(c)) return c;
  for (let v = 32; v < 256; v++) {
    const h = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
    if (!taken.has(h)) return h;
  }
  return '#0a0a0a';
}
