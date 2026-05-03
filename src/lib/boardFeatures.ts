import type { BoardConfig, BoardWoodKey, EdgeTreatment } from '@/types/board';
import {
  hasTopGroove, hasBottomGroove,
  feetAabbs, undersideHandleAabbs,
  FOOT_DIAMETER_INCHES,
} from '@/types/board';
import { WOOD_SPECIES } from './woodSpecies';
import { applyGrain } from './woodGrain';

/**
 * Render a board surface (top OR bottom view) with the
 * cutting-board features baked in: wood grain background, beveled
 * edge (chamfer or roundover), and side-specific features:
 *
 *   - Top side: top-side juice groove if selected.
 *   - Bottom side: bottom-side juice groove (if selected), feet
 *     (`sided === 'feet'`) drawn as 1" bronze circles inset 1/4"
 *     from each corner, and underside-handle pockets
 *     (`handles === 'underside'`) drawn as 1"-deep × 5"-long dark
 *     recesses flush with each 12"-tall short edge.
 *
 * Inlay-collision metadata for the back-side fixed features lives in
 * `feetAabbs` / `undersideHandleAabbs` (in `types/board.ts`); this
 * function just paints them.
 *
 * Returns a PNG data URL sized at `widthInches × heightInches × ppi`.
 */
export async function renderBoardWithFeatures(
  config: BoardConfig,
  pixelsPerInch: number = 100,
  side: 'top' | 'bottom' = 'top',
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

  // Pre-compute bottom-side feature geometry in pixels (only used when
  // `side === 'bottom'` — cheap to compute either way).
  const showFeet    = side === 'bottom' && config.sided === 'feet';
  const showHandles = side === 'bottom' && config.handles === 'underside';
  const showGroove  =
    side === 'top'    ? hasTopGroove(config.juiceGroove)
    : /* bottom */     hasBottomGroove(config.juiceGroove);

  // Foot centers + radii in pixels.
  const footRadiusPx = (FOOT_DIAMETER_INCHES * pixelsPerInch) / 2;
  const feetCentersPx = showFeet
    ? feetAabbs(config).map(a => ({
        cx: (a.x + a.w / 2) * pixelsPerInch,
        cy: (a.y + a.h / 2) * pixelsPerInch,
      }))
    : [];

  // Handle pockets in pixel rect coords.
  const handleRectsPx = showHandles
    ? undersideHandleAabbs(config).map(a => ({
        x0: a.x * pixelsPerInch,
        y0: a.y * pixelsPerInch,
        x1: (a.x + a.w) * pixelsPerInch,
        y1: (a.y + a.h) * pixelsPerInch,
      }))
    : [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r0, g0, b0] = applyGrain(sp.baseHex, sp.grainHex, x, y);
      let r = r0, g = g0, b = b0;

      // Distance to nearest edge (in px, Chebyshev — gives clean rectangular
      // bevel and groove paths around the perimeter).
      const distFromEdge = Math.min(x, y, w - 1 - x, h - 1 - y);

      // Edge bevel: darkening ramp from outermost edge inward over bevelWidthPx.
      if (distFromEdge < bevelWidthPx) {
        const t = distFromEdge / bevelWidthPx;
        const factor = bevelDarkening(config.edge, t);
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
      }

      // Juice groove (top OR bottom, same band geometry — just selected
      // by side). Reads as a recessed channel via a "valley" gradient.
      if (
        showGroove
        && distFromEdge >= grooveOuterPx
        && distFromEdge <= grooveInnerPx
      ) {
        const center = (grooveOuterPx + grooveInnerPx) / 2;
        const halfWidth = (grooveInnerPx - grooveOuterPx) / 2;
        const tg = Math.abs(distFromEdge - center) / halfWidth;
        const factor = 0.45 + 0.30 * tg;
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
      }

      // Underside-handle pockets (back side only): rectangular dark
      // recess flush with the short edge. Soft tapered gradient inward
      // so it reads as a routed pocket rather than a flat rectangle.
      if (showHandles) {
        for (const rect of handleRectsPx) {
          if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) {
            // Distance from the deepest edge of the pocket — pockets are
            // flush with one of the board's short edges, so the deepest
            // point is the inner edge (the one INSIDE the board). Use
            // the smallest of (x − rect.x0) and (rect.x1 − x) but only
            // for the deepening — a flat dark wash works fine for v1.
            const factor = 0.40;
            r = Math.round(r * factor);
            g = Math.round(g * factor);
            b = Math.round(b * factor);
            break;
          }
        }
      }

      // Feet (back side only): bronze circles. Center brighter, edge
      // slightly darker → reads as a slightly domed metal pad.
      if (showFeet) {
        for (const c of feetCentersPx) {
          const dx = x - c.cx;
          const dy = y - c.cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= footRadiusPx) {
            // Bronze base color, with radial darkening near the edge for
            // shading. Bronze ≈ rgb(170, 110, 60).
            const t = dist / footRadiusPx; // 0 at center, 1 at edge
            const shade = 1.0 - 0.35 * t;
            r = Math.round(170 * shade);
            g = Math.round(110 * shade);
            b = Math.round(60  * shade);
            break;
          }
        }
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
