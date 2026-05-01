import type { VectorData, WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from './woodSpecies';

const CANVAS_WIDTH = 1200;
const COLOR_TOLERANCE_SQ = 900; // ~30 per channel, matches analysis tolerance

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function applyGrain(
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
 * Rasterize the SVG and remap each color region to its assigned wood species
 * grain texture. woodConfigs is in priority order — first entry wins at
 * antialiased border pixels.
 */
export async function generateComposite(
  vector: VectorData,
  woodConfigs: WoodConfig[],
  backgroundSpecies: WoodSpeciesKey,
): Promise<string> {
  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = CANVAS_WIDTH;
  const canvasH = Math.max(1, Math.round(CANVAS_WIDTH * aspect));

  // Render SVG to source canvas
  const src = new OffscreenCanvas(canvasW, canvasH);
  const srcCtx = src.getContext('2d')!;
  srcCtx.fillStyle = 'white';
  srcCtx.fillRect(0, 0, canvasW, canvasH);
  const svgBlob = new Blob([vector.svgString], { type: 'image/svg+xml' });
  const svgUrl = URL.createObjectURL(svgBlob);
  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => { srcCtx.drawImage(img, 0, 0, canvasW, canvasH); resolve(); };
    img.onerror = reject;
    img.src = svgUrl;
  });
  URL.revokeObjectURL(svgUrl);

  const { data: srcData } = srcCtx.getImageData(0, 0, canvasW, canvasH);
  const n = canvasW * canvasH;

  // Pre-parse color targets for fast inner-loop matching
  const targets = woodConfigs.map(wc => ({
    tr: parseInt(wc.colorHex.slice(1, 3), 16),
    tg: parseInt(wc.colorHex.slice(3, 5), 16),
    tb: parseInt(wc.colorHex.slice(5, 7), 16),
    baseHex: WOOD_SPECIES[wc.species].baseHex,
    grainHex: WOOD_SPECIES[wc.species].grainHex,
  }));

  const bg = WOOD_SPECIES[backgroundSpecies];

  // Build composited output
  const out = new OffscreenCanvas(canvasW, canvasH);
  const outCtx = out.getContext('2d')!;
  const outImg = outCtx.createImageData(canvasW, canvasH);
  const d = outImg.data;

  for (let i = 0; i < n; i++) {
    const x = i % canvasW;
    const y = (i - x) / canvasW;
    const pr = srcData[i*4], pg = srcData[i*4+1], pb = srcData[i*4+2];

    let baseHex = bg.baseHex;
    let grainHex = bg.grainHex;

    for (const t of targets) {
      const dr = pr - t.tr, dg = pg - t.tg, db = pb - t.tb;
      if (dr*dr + dg*dg + db*db < COLOR_TOLERANCE_SQ) {
        baseHex  = t.baseHex;
        grainHex = t.grainHex;
        break;
      }
    }

    const [r, g, b] = applyGrain(baseHex, grainHex, x, y);
    d[i*4] = r; d[i*4+1] = g; d[i*4+2] = b; d[i*4+3] = 255;
  }

  outCtx.putImageData(outImg, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
