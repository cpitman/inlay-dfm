import type { AnalysisResult } from '@/types';
import { dilateMask } from './maskOps';

interface RGBA { r: number; g: number; b: number; a: number }

/**
 * Pocket-side problem regions — features inside an inlay shape that
 * are too narrow for the v-bit. Matches the existing buildOverlay
 * problem channel.
 */
const POCKET_RED:    RGBA = { r: 220, g: 35,  b: 35,  a: 175 };
/**
 * Plug-side problem regions — base-board slivers between adjacent
 * inlays that no v-bit can carve. Yellow (not orange — that's already
 * used by the thin-wall channel in `buildOverlay`).
 */
const PLUG_YELLOW:   RGBA = { r: 230, g: 195, b: 25,  a: 195 };
/**
 * Pocket-side wider-bit suggestion — widen this thin feature to enable
 * a faster bit. Matches the existing wider-bit channel.
 */
const POCKET_TEAL:   RGBA = { r: 40,  g: 200, b: 210, a: 170 };
/**
 * Plug-side wider-bit suggestion — widen this gap. Lighter cyan so it
 * reads as "different but related" to teal.
 */
const PLUG_CYAN:     RGBA = { r: 110, g: 230, b: 235, a: 170 };

/** Physical-size target for the rasterized splash radius. Plug-side
 *  problems are typically 1-3 pixels wide at any analysis resolution;
 *  expanding them to ~0.04" of physical coverage keeps the highlight
 *  visible at thumbnail display size regardless of canvas ppi. The
 *  guided flow runs at 240 ppi → 10 px; the expert flow's 100-200 ppi
 *  → 4-8 px. Centroids are NOT dilated — they continue to point at
 *  the true problem location. */
const DILATE_PHYSICAL_INCHES = 0.04;

/** Public color tokens so the legend in Step3QuoteDisplay can render
 *  the same hues as the overlay PNG. */
export const OVERLAY_COLORS = {
  pocketRed:  POCKET_RED,
  plugYellow: PLUG_YELLOW,
  pocketTeal: POCKET_TEAL,
  plugCyan:   PLUG_CYAN,
} as const;

/** Format an RGBA tuple as a CSS `rgba(...)` string for use in JSX styles. */
export function rgbaCss(c: RGBA): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;
}

/**
 * Render two color bands (pocket-side issues + plug-side issues) into
 * a single translucent PNG, dilated for visibility. Pocket pixels win
 * wherever the dilated bands overlap (feature-side issues are the
 * primary signal; gap-side is secondary).
 *
 * Returns `null` when both unioned masks are empty.
 */
async function renderTwoBandOverlay(opts: {
  pocketMasks: Uint8Array[];
  plugMasks:   Uint8Array[];
  canvasW: number;
  canvasH: number;
  pixelsPerInch: number;
  pocketColor: RGBA;
  plugColor:   RGBA;
  dilateRadiusPx?: number;
}): Promise<string | null> {
  const { pocketMasks, plugMasks, canvasW, canvasH, pixelsPerInch, pocketColor, plugColor } = opts;
  const dilateRadius = opts.dilateRadiusPx
    ?? Math.max(2, Math.round(DILATE_PHYSICAL_INCHES * pixelsPerInch));
  const n = canvasW * canvasH;

  // Validate sizes; bail rather than rasterize garbage.
  for (const m of pocketMasks) if (m.length !== n) return null;
  for (const m of plugMasks)   if (m.length !== n) return null;
  if (pocketMasks.length === 0 && plugMasks.length === 0) return null;

  // Union per side, then dilate per side.
  const unionPocket = new Uint8Array(n);
  for (const m of pocketMasks) {
    for (let k = 0; k < n; k++) if (m[k]) unionPocket[k] = 1;
  }
  const unionPlug = new Uint8Array(n);
  for (const m of plugMasks) {
    for (let k = 0; k < n; k++) if (m[k]) unionPlug[k] = 1;
  }

  const dilatedPocket = dilateMask(unionPocket, canvasW, canvasH, dilateRadius);
  const dilatedPlug   = dilateMask(unionPlug,   canvasW, canvasH, dilateRadius);

  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  const img = ctx.createImageData(canvasW, canvasH);
  const d = img.data;

  let any = false;
  for (let k = 0; k < n; k++) {
    let color: RGBA | null = null;
    if (dilatedPocket[k])    color = pocketColor;
    else if (dilatedPlug[k]) color = plugColor;
    if (!color) continue;
    any = true;
    d[k * 4]     = color.r;
    d[k * 4 + 1] = color.g;
    d[k * 4 + 2] = color.b;
    d[k * 4 + 3] = color.a;
  }
  if (!any) return null;
  ctx.putImageData(img, 0, 0);

  const blob = await oc.convertToBlob({ type: 'image/png' });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Pull pocket-and-plug masks off the analysis result for a given field. */
function collectMasksBySide(
  result: AnalysisResult,
  pick: (w: AnalysisResult['woods'][number]) => { pocket: Uint8Array; plug: Uint8Array } | null,
): { pocketMasks: Uint8Array[]; plugMasks: Uint8Array[] } {
  const pocketMasks: Uint8Array[] = [];
  const plugMasks:   Uint8Array[] = [];
  for (const wood of result.woods) {
    const m = pick(wood);
    if (!m) continue;
    pocketMasks.push(m.pocket);
    plugMasks.push(m.plug);
  }
  return { pocketMasks, plugMasks };
}

/**
 * Render the union of every wood's `widerBitInfeasibleMask` as a
 * teal (pocket) + cyan (plug) PNG so Step 3 can highlight regions the
 * artist could widen to enable a faster v-bit. Returns `null` when no
 * wood has such a mask (design is already at the widest preset, or no
 * preset is feasible).
 */
export async function renderWiderBitOverlay(
  result: AnalysisResult,
  canvasW: number,
  canvasH: number,
): Promise<string | null> {
  const { pocketMasks, plugMasks } = collectMasksBySide(result, w => w.widerBitInfeasibleMask);
  return renderTwoBandOverlay({
    pocketMasks, plugMasks, canvasW, canvasH,
    pixelsPerInch: result.pixelsPerInch,
    pocketColor: POCKET_TEAL,
    plugColor:   PLUG_CYAN,
  });
}

/**
 * Render the union of every wood's `irreducibleProblemMask` as a
 * red (pocket) + yellow (plug) PNG. Used by Step 3 in the guided
 * quote flow when no v-bit preset can carve the design. Returns
 * `null` when no wood has such a mask.
 */
export async function renderIrreducibleProblemOverlay(
  result: AnalysisResult,
  canvasW: number,
  canvasH: number,
): Promise<string | null> {
  const { pocketMasks, plugMasks } = collectMasksBySide(result, w => w.irreducibleProblemMask);
  return renderTwoBandOverlay({
    pocketMasks, plugMasks, canvasW, canvasH,
    pixelsPerInch: result.pixelsPerInch,
    pocketColor: POCKET_RED,
    plugColor:   PLUG_YELLOW,
  });
}
