import type { WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from './woodSpecies';

/** Decode a "#rrggbb" hex string into an RGB tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Procedural wood grain — a horizontal sine band of `grain` color over a
 * `base` background, plus a slow figured variation. Same model used by both
 * the inlay composite and the standalone board surface so the design and
 * the board around it match visually.
 */
export function applyGrain(
  baseHex: string,
  grainHex: string,
  x: number,
  y: number,
): [number, number, number] {
  const [br, bg, bb] = hexToRgb(baseHex);
  const [gr, gg, gb] = hexToRgb(grainHex);
  // Primary grain lines: horizontal sine at ~7px period
  const t = Math.abs(Math.sin((y * Math.PI) / 7));
  // Subtle long-range figure variation
  const figure = 0.97 + 0.03 * Math.sin(y / 55 + x / 130);
  const f = Math.min(1, t * figure);
  return [
    Math.round(gr + (br - gr) * f),
    Math.round(gg + (bg - gg) * f),
    Math.round(gb + (bb - gb) * f),
  ];
}

/**
 * Render an empty board surface (no design) in the given species' wood
 * grain at the requested inch dimensions. Resolution defaults to 100 px/in;
 * adequate for the composite-view preview at any zoom level we expect.
 */
export async function renderBoardSurface(
  species: WoodSpeciesKey,
  widthInches: number,
  heightInches: number,
  pixelsPerInch: number = 100,
): Promise<string> {
  const w = Math.max(1, Math.round(widthInches  * pixelsPerInch));
  const h = Math.max(1, Math.round(heightInches * pixelsPerInch));
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d')!;
  const sp = WOOD_SPECIES[species];

  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = applyGrain(sp.baseHex, sp.grainHex, x, y);
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
