/**
 * Helpers that bridge the polygon analytical representation to the
 * canvas / Uint8Array world used by the existing overlay and depth-
 * map PNG builders.
 *
 * `rasterizeMultiPolygonToMask` is a pure-JS scanline fill so it
 * works in vitest (no OffscreenCanvas) and on the browser side.
 * `polygonToPath2D` is browser-only — used by the overlay / depth-
 * map builders that already require Canvas.
 */

import {
  multiPolygonOffset,
} from './clipperOps';
import {
  multiPolygonIsEmpty,
  type MultiPolygon,
} from './polygon';

/**
 * Affine transform from design (= SVG viewBox) coordinates to canvas
 * pixel coordinates. `scaleX`, `scaleY` are pixels per design unit;
 * `offsetX`, `offsetY` are the viewBox origin in design units.
 *
 *   pixelX = (designX − offsetX) × scaleX
 *   pixelY = (designY − offsetY) × scaleY
 */
export interface DesignToCanvasTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Scanline polygon fill under the even-odd rule. Result is a
 * `Uint8Array` of length `canvasW * canvasH`, with `1` for inside-
 * polygon pixels.
 *
 * Handles MultiPolygon as a flat ring list (= same convention as
 * everywhere else in the polygon pipeline). Each scanline collects
 * x-intersections from every edge that straddles the line, sorts
 * them, and fills alternate spans.
 */
export function rasterizeMultiPolygonToMask(
  mp: MultiPolygon,
  canvasW: number,
  canvasH: number,
  t: DesignToCanvasTransform,
): Uint8Array {
  const mask = new Uint8Array(canvasW * canvasH);
  if (multiPolygonIsEmpty(mp) || canvasW <= 0 || canvasH <= 0) return mask;

  const xs: number[] = [];
  for (let y = 0; y < canvasH; y++) {
    // Sample at pixel center to reduce flicker of edge-passing pixels.
    const yDesign = (y + 0.5) / t.scaleY + t.offsetY;
    xs.length = 0;
    for (const ring of mp) {
      if (ring.length < 3) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j];
        const b = ring[i];
        const aAbove = a.y > yDesign;
        const bAbove = b.y > yDesign;
        if (aAbove === bAbove) continue;
        const tEdge = (yDesign - a.y) / (b.y - a.y);
        const xDesign = a.x + tEdge * (b.x - a.x);
        xs.push((xDesign - t.offsetX) * t.scaleX);
      }
    }
    if (xs.length === 0) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i] - 0.5));
      const x1 = Math.min(canvasW - 1, Math.floor(xs[i + 1] - 0.5));
      const row = y * canvasW;
      for (let x = x0; x <= x1; x++) mask[row + x] = 1;
    }
  }
  return mask;
}

/**
 * Build a Path2D for a MultiPolygon, transformed to canvas pixels.
 * Browser-only (Path2D is a DOM type). Use with `ctx.fill(path, 'evenodd')`
 * for even-odd hole semantics.
 */
export function polygonToPath2D(
  mp: MultiPolygon,
  t: DesignToCanvasTransform,
): Path2D {
  const path = new Path2D();
  for (const ring of mp) {
    if (ring.length < 3) continue;
    const p0 = ring[0];
    path.moveTo((p0.x - t.offsetX) * t.scaleX, (p0.y - t.offsetY) * t.scaleY);
    for (let i = 1; i < ring.length; i++) {
      const p = ring[i];
      path.lineTo((p.x - t.offsetX) * t.scaleX, (p.y - t.offsetY) * t.scaleY);
    }
    path.closePath();
  }
  return path;
}

/**
 * Render a polygon-derived depth map onto `target` ctx, on top of
 * whatever's already drawn there. Depth at point P = distance from
 * P to the carved boundary, capped at `fullDepthRadius`.
 *
 * Implementation: render `levels` successive inward offsets of
 * `carvedMP` in increasingly green colors. The interior of offset
 * #k contains all points with distance ≥ k × R / levels from the
 * carved boundary, so successive draws build up the depth gradient.
 *
 * Plug-fit branch: when `plugFit` is provided, the deepest level is
 * recolored cyan-ward by `surfaceGap / inlayDepth` to mark the
 * flat-bottom region. Mirrors the bitmap version's plug-fit tint.
 */
export function renderDepthMapToContext(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  carvedMP: MultiPolygon,
  fullDepthRadius: number,
  transform: DesignToCanvasTransform,
  options?: {
    levels?: number;
    plugFit?: { glueGapInches: number; surfaceGapInches: number; inlayDepthInches: number };
  },
): void {
  if (multiPolygonIsEmpty(carvedMP) || fullDepthRadius <= 0) return;
  const levels = options?.levels ?? 14;

  // Wall (depth 0): paint the entire carved area in red — successive
  // offsets paint over the interior with progressively greener tones.
  ctx.fillStyle = 'rgba(220, 40, 30, 0.82)';
  ctx.fill(polygonToPath2D(carvedMP, transform), 'evenodd');

  for (let k = 1; k <= levels; k++) {
    const r = (k / levels) * fullDepthRadius;
    const offset = multiPolygonOffset(carvedMP, -r, { joinType: 'round' });
    if (multiPolygonIsEmpty(offset)) break;
    let depthRatio = k / levels;
    if (options?.plugFit) {
      // Mirror the bitmap formula: effective depth = baseRatio*inlay
      // − glueGap (tapered) or inlay − glueGap + surfaceGap (flat).
      // Here baseRatio == k/levels; depthRatio is the resulting
      // ratio after the glue/surface adjustments.
      const inlay = options.plugFit.inlayDepthInches;
      const glue  = options.plugFit.glueGapInches;
      const sgap  = options.plugFit.surfaceGapInches;
      const baseRatio = k / levels;
      const baseDepth = baseRatio * inlay;
      const eff = (baseRatio >= 1)
        ? Math.max(0, inlay - glue + sgap)
        : Math.max(0, baseDepth - glue);
      depthRatio = inlay > 0 ? eff / inlay : 0;
    }
    const dr = Math.min(1, depthRatio);
    const r_ch = Math.round(220 - 180 * dr);
    const g_ch = Math.round(40  + 160 * dr);
    ctx.fillStyle = `rgba(${r_ch}, ${g_ch}, 30, 0.82)`;
    ctx.fill(polygonToPath2D(offset, transform), 'evenodd');
  }
}
