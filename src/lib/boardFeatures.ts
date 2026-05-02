import type { BoardConfig, BoardWoodKey, EdgeTreatment } from '@/types/board';
import { hasTopGroove } from '@/types/board';
import { WOOD_SPECIES } from './woodSpecies';
import { applyGrain } from './woodGrain';

/**
 * Render a board surface (top view) with optional cutting-board features
 * baked in: wood grain background, beveled edge (chamfer or roundover),
 * and a top-side juice groove path.
 *
 * Features that aren't visible from the top view are tracked in
 * BoardConfig but NOT drawn here:
 *   - Bottom-side juice groove (only visible when flipped over)
 *   - Inset handles — recessed into the sides of the board
 *   - Underside-pocket handles — recessed into the bottom face
 *   - Feet — protrude from the underside
 *
 * Returns a PNG data URL sized at `widthInches × heightInches × ppi`.
 */
export async function renderBoardWithFeatures(
  config: BoardConfig,
  pixelsPerInch: number = 100,
): Promise<string> {
  const w = Math.max(1, Math.round(config.widthInches  * pixelsPerInch));
  const h = Math.max(1, Math.round(config.heightInches * pixelsPerInch));
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d')!;

  const sp = WOOD_SPECIES[config.wood as BoardWoodKey];
  const img = ctx.createImageData(w, h);
  const d = img.data;

  // Geometry constants in pixels.
  const bevelWidthPx  = Math.round(0.25 * pixelsPerInch); // ~0.25" rim
  // Juice groove: 3/4" wide band whose outer edge sits 1/4" from the
  // board edge. Pixels at distFromEdge in [grooveOuter, grooveInner]
  // belong to the band.
  const grooveOuterPx = Math.round(0.25 * pixelsPerInch);
  const grooveInnerPx = Math.round(1.00 * pixelsPerInch);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r0, g0, b0] = applyGrain(sp.baseHex, sp.grainHex, x, y);
      let r = r0, g = g0, b = b0;

      // Distance to nearest edge (in px, Chebyshev — gives clean rectangular
      // bevel and groove paths around the perimeter).
      const distFromEdge = Math.min(x, y, w - 1 - x, h - 1 - y);

      // Edge bevel: darkening ramp from outermost edge inward over bevelWidthPx.
      if (distFromEdge < bevelWidthPx) {
        const t = distFromEdge / bevelWidthPx; // 0 at edge, 1 at inner side of bevel
        const factor = bevelDarkening(config.edge, t);
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
      }

      // Top juice groove: a recessed 3/4" band around the perimeter.
      // Outer edge of the band is at distFromEdge = grooveOuterPx;
      // inner edge at distFromEdge = grooveInnerPx.
      if (
        hasTopGroove(config.juiceGroove)
        && distFromEdge >= grooveOuterPx
        && distFromEdge <= grooveInnerPx
      ) {
        // Soft "valley" gradient: darkest at the band centerline, lighter
        // near the edges of the band. Reads as a recessed channel.
        const center = (grooveOuterPx + grooveInnerPx) / 2;
        const halfWidth = (grooveInnerPx - grooveOuterPx) / 2;
        const tg = Math.abs(distFromEdge - center) / halfWidth; // 0 at center, 1 at edges
        const factor = 0.45 + 0.30 * tg;
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
      }

      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const blob = await oc.convertToBlob({ type: 'image/png' });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Edge darkening factor by treatment + normalized depth `t` in [0, 1]
 * (0 = outermost edge pixel, 1 = inner end of the bevel).
 *
 *   - chamfer:   linear ramp from 0.65 at the edge to 1.0 at the inner end.
 *                Reads as a flat 45° cut — visually a uniform-tone dark rim.
 *   - roundover: smoothstep gives a softer transition that reads like a
 *                rounded corner catching highlights toward the inside.
 */
function bevelDarkening(edge: EdgeTreatment, t: number): number {
  if (edge === 'chamfer') return 0.65 + 0.35 * t;
  // smoothstep(t) = 3t² − 2t³ — gentle in/out curve.
  const s = t * t * (3 - 2 * t);
  return 0.62 + 0.38 * s;
}
