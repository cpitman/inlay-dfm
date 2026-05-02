import type { AnalysisResult } from '@/types';

/**
 * Render the union of every wood's pocket-side `widerBitInfeasibleMask`
 * as a translucent teal PNG so Step 3 can stack it over the design
 * composite, highlighting regions the artist could widen to enable a
 * faster v-bit (and thus reduce machining time / cost).
 *
 * The caller passes the canvas dimensions used by the analysis (every
 * wood's pocket mask is `canvasW × canvasH` in length). When no wood
 * has a wider-bit mask — design is already at the widest preset, or
 * no preset is feasible at all — returns `null`.
 */
export async function renderWiderBitOverlay(
  result: AnalysisResult,
  canvasW: number,
  canvasH: number,
): Promise<string | null> {
  const masks = result.woods
    .map(w => w.widerBitInfeasibleMask?.pocket)
    .filter((m): m is Uint8Array => m !== undefined);
  if (masks.length === 0) return null;
  // Defensive: caller mismatched canvas dims and we'd render garbage.
  if (masks.some(m => m.length !== canvasW * canvasH)) return null;

  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  const img = ctx.createImageData(canvasW, canvasH);
  const d = img.data;

  // Teal — matches the existing PR-2 buildOverlay wider-bit channel
  // rgb(40, 200, 210). Alpha 170 so the design beneath remains legible.
  const R = 40, G = 200, B = 210, A = 170;
  let any = false;
  for (let k = 0; k < canvasW * canvasH; k++) {
    let union = 0;
    for (const m of masks) {
      if (m[k]) { union = 1; break; }
    }
    if (!union) continue;
    any = true;
    d[k * 4]     = R;
    d[k * 4 + 1] = G;
    d[k * 4 + 2] = B;
    d[k * 4 + 3] = A;
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
