/**
 * "Stroke detection" — turn the visible stroke geometry of an SVG
 * upload (the line art / outlines / contours) into a filled-polygon
 * Layer the inlay pipeline can treat as just another color, AND
 * compute a per-fill subtraction so the outline visibly pokes
 * through the foreground fills wherever it was the topmost painted
 * thing in the original SVG.
 *
 * Polygon-native, with browser-DOM pre-flattening: the SVG is
 * mounted hidden, walked via `getCTM()` + `getComputedStyle()` to
 * resolve `transform`, `<g>` inheritance, and CSS stylesheets, then
 * each stroked element's polyline is offset by `width/2` through
 * Clipper to produce exact stroke-band geometry. No rasterization,
 * no chord-error overshoot.
 */

import type { Layer } from '@/types';
import { extractStrokesPolygonViaFlatten } from './polygonStrokeExtraction';
import { multiPolygonDifference } from './clipperOps';
import { multiPolygonArea, multiPolygonIsEmpty } from './polygon';
import {
  multiPolygonToSvgFragment,
  svgFragmentToMultiPolygon,
} from './polygonParser';

export interface StrokeExtraction {
  /** Polygon Layer for the full stroke geometry — covered + visible. */
  strokeLayer: Layer;
  /** Same length and color order as the input fillLayers, with each
   *  fragment retraced where the visible-stroke region overlapped.
   *  Layers untouched by strokes return their original svgFragment
   *  unchanged so we don't pay a re-emit cost or lose Bezier fidelity
   *  for them. */
  fillLayersWithStrokeSubtracted: Layer[];
}

/** Cheap pre-check: does the SVG source mention any non-`none` stroke?
 *  Used to skip the (relatively expensive) extraction step on the
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

/**
 * Drop strokes whose union has too small a footprint to surface as
 * a layer. Mirrors the bitmap path's 0.05% floor — strokes covering
 * effectively zero area aren't worth a separate layer.
 */
function strokeTooSmall(strokeArea: number, viewBoxArea: number): boolean {
  if (viewBoxArea <= 0) return strokeArea < 1e-6;
  return strokeArea / viewBoxArea < 0.0005;
}

/**
 * Run the full stroke-extraction + visible-stroke-subtraction pass.
 * Returns `null` when the cheap pre-check says no strokes are present,
 * or when the extracted stroke geometry is too small to be worth
 * surfacing.
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

  let extraction;
  try {
    extraction = await extractStrokesPolygonViaFlatten(svgText);
  } catch {
    return null;
  }
  const { allStrokesMP, visibleStrokesMP } = extraction;
  if (multiPolygonIsEmpty(allStrokesMP)) return null;

  const vbParts = viewBox.trim().split(/\s+/).map(parseFloat);
  const viewBoxArea = (vbParts.length >= 4 && Number.isFinite(vbParts[2]) && Number.isFinite(vbParts[3]))
    ? vbParts[2] * vbParts[3]
    : naturalWidth * naturalHeight;
  if (strokeTooSmall(multiPolygonArea(allStrokesMP), viewBoxArea)) return null;

  const colorHex = pickStrokeColorHex(existingColors);
  const strokeLayer: Layer = {
    colorHex,
    svgFragment: multiPolygonToSvgFragment(allStrokesMP, colorHex),
  };

  // For each fill layer: compute its polygon, subtract visible-stroke
  // region, re-emit if anything changed.
  const fillLayersWithStrokeSubtracted: Layer[] = [];
  for (const layer of fillLayers) {
    if (multiPolygonIsEmpty(visibleStrokesMP)) {
      fillLayersWithStrokeSubtracted.push(layer);
      continue;
    }
    let layerMP;
    try {
      layerMP = svgFragmentToMultiPolygon(layer.svgFragment);
    } catch {
      fillLayersWithStrokeSubtracted.push(layer);
      continue;
    }
    if (multiPolygonIsEmpty(layerMP)) {
      fillLayersWithStrokeSubtracted.push(layer);
      continue;
    }
    const subtracted = multiPolygonDifference(layerMP, visibleStrokesMP);
    const beforeArea = multiPolygonArea(layerMP);
    const afterArea  = multiPolygonArea(subtracted);
    if (Math.abs(beforeArea - afterArea) < beforeArea * 1e-6) {
      fillLayersWithStrokeSubtracted.push(layer);
      continue;
    }
    fillLayersWithStrokeSubtracted.push({
      colorHex: layer.colorHex,
      svgFragment: multiPolygonToSvgFragment(subtracted, layer.colorHex),
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
