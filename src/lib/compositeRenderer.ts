import type { VectorData, WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from './woodSpecies';
import { applyGrain } from './woodGrain';

const CANVAS_WIDTH = 1200;
const COLOR_TOLERANCE_SQ = 900; // ~30 per channel, matches analysis tolerance

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
