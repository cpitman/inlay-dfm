/**
 * Whitespace trim for parsed designs.
 *
 * Many design files (especially Illustrator/Inkscape exports) have a
 * viewBox that's much larger than the visible content — the document
 * was sized to a page or canvas, but the inlay artwork only occupies
 * part of it. That whitespace would otherwise pad every analysis canvas,
 * waste pixels on rasterization, and constrain how the user can scale /
 * place the design on the composite-view board (since the design's
 * effective width includes the empty margin).
 *
 * Strategy: rasterize the combined SVG at a moderate resolution, find
 * the bounding box of pixels that are darker than near-white, pad
 * slightly, and return a tightened viewBox. The rasterizer naturally
 * handles Bezier curves — even cubic Beziers that extend past their
 * control points appear correctly in the rasterized image, so the
 * pixel bbox already captures their full extent.
 *
 * The original layer fragments are kept untouched; only the viewBox
 * window changes. SVG's viewBox attribute defines a sub-region in the
 * existing coordinate system rather than translating geometry, so a
 * tighter viewBox just clips off the empty margins.
 */

const TRIM_RASTER_WIDTH = 800;
const PAD_FRACTION = 0.005;       // 0.5% of the larger viewBox dimension
const MIN_PAD_VIEWBOX_UNITS = 1;  // never less than 1 vb unit, in case a design is very small
const NEAR_WHITE_LUMA = 220;      // matches the per-layer mask threshold

export interface TrimResult {
  viewBox: string;       // "x y w h" — origin and size in the original viewBox's coordinate system
  naturalWidth: number;  // = w of the new viewBox
  naturalHeight: number; // = h of the new viewBox
}

/**
 * Compute a tightened viewBox for `svgString`. `viewBoxW` and `viewBoxH`
 * are the document's current viewBox dimensions in user units.
 */
export async function computeTrimmedViewBox(
  svgString: string,
  viewBoxW: number,
  viewBoxH: number,
): Promise<TrimResult> {
  const aspect = viewBoxH / viewBoxW;
  const rasterW = TRIM_RASTER_WIDTH;
  const rasterH = Math.max(1, Math.round(rasterW * aspect));

  const oc = new OffscreenCanvas(rasterW, rasterH);
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, rasterW, rasterH);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
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
  let minX = rasterW, minY = rasterH, maxX = -1, maxY = -1;
  for (let y = 0; y < rasterH; y++) {
    for (let x = 0; x < rasterW; x++) {
      const i = (y * rasterW + x) * 4;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < NEAR_WHITE_LUMA) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // No content (or all white) — return the original viewBox unchanged.
  if (maxX < 0) {
    return {
      viewBox: `0 0 ${viewBoxW} ${viewBoxH}`,
      naturalWidth: viewBoxW,
      naturalHeight: viewBoxH,
    };
  }

  // Convert pixel bbox to viewBox units. Pad outward by a small fraction
  // of the larger dimension (and never less than 1 vb unit) to avoid
  // clipping antialiased edges or stroke widths that the bbox missed.
  const sx = viewBoxW / rasterW;
  const sy = viewBoxH / rasterH;
  const pad = Math.max(MIN_PAD_VIEWBOX_UNITS, Math.max(viewBoxW, viewBoxH) * PAD_FRACTION);
  const x1 = Math.max(0,         minX       * sx - pad);
  const y1 = Math.max(0,         minY       * sy - pad);
  const x2 = Math.min(viewBoxW, (maxX + 1)  * sx + pad);
  const y2 = Math.min(viewBoxH, (maxY + 1)  * sy + pad);
  const newW = x2 - x1;
  const newH = y2 - y1;

  return {
    viewBox: `${x1} ${y1} ${newW} ${newH}`,
    naturalWidth:  newW,
    naturalHeight: newH,
  };
}
