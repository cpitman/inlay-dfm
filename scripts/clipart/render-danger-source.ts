/**
 * One-off diagnostic: visualize the `dangerSource` mask used by the
 * fill passes for a single target layer, given the per-layer
 * `final.png` images from a downloaded debug ZIP.
 *
 * Outputs one color-coded PNG per requested target layer:
 *   • red     = earlierUnion  (layer drawn before target → bit-clearance side)
 *   • blue    = backgroundVisible (no layer covers → raw board)
 *   • dark    = the target layer itself (for context)
 *   • mid-gray = "later" layers (not danger; bit doesn't need clearance against
 *               their wood at target carve time, since they're inlaid AFTER
 *               target's pocket is cut)
 *
 * Usage:
 *   npx tsx scripts/clipart/render-danger-source.ts <archive-design-dir> <out-dir>
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
const archiveDesignDir = process.argv[2];
const outDir           = process.argv[3];
if (!archiveDesignDir || !outDir) {
  console.error('usage: render-danger-source <archive-design-dir> <out-dir>');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

// Discover layers from the design dir (folder pattern: layer-NN-HEX/).
const layerDirs = readdirSync(archiveDesignDir)
  .filter(n => /^layer-\d+-[0-9a-f]{6}$/.test(n))
  .sort();
console.log(`found ${layerDirs.length} layers in ${archiveDesignDir}`);

// Use ORIGINAL.png — that's the pre-optimization layer geometry the
// fill algorithm sees as input. final.png reflects post-optimization
// state and would skew the diagnostic.
const layerPngs = layerDirs.map(d =>
  readFileSync(resolve(archiveDesignDir, d, 'original.png'))
);
const layerPngsB64 = layerPngs.map(b => b.toString('base64'));
const layerHexes = layerDirs.map(d => d.match(/-([0-9a-f]{6})$/)![1]);

const browser = await chromium.launch();
const page = await browser.newPage();

const BRIGHTNESS_MAX = 220;

// One image per target index. The browser-side code computes the
// dangerSource for each target and returns N base64 PNGs.
const outBase64s: string[] = await page.evaluate(async ({ layerPngsB64, BRIGHTNESS_MAX }) => {
  const images = await Promise.all(layerPngsB64.map((b64: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img load failed'));
    img.src = 'data:image/png;base64,' + b64;
  })));

  const w = images[0].naturalWidth;
  const h = images[0].naturalHeight;
  const n = w * h;
  const N = images.length;

  // Rasterize each layer to a binary mask (luma threshold).
  const masks: Uint8Array[] = [];
  for (const img of images) {
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const r = data[k * 4], g = data[k * 4 + 1], b = data[k * 4 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < BRIGHTNESS_MAX) mask[k] = 1;
    }
    masks.push(mask);
  }

  // Union of every layer (used for backgroundVisible).
  const allLayers = new Uint8Array(n);
  for (const m of masks) for (let k = 0; k < n; k++) if (m[k]) allLayers[k] = 1;

  const out: string[] = [];
  for (let target = 0; target < N - 1; target++) {  // skip final (no later layers)
    // earlierUnion = layers 0..target-1
    const earlier = new Uint8Array(n);
    for (let i = 0; i < target; i++) {
      for (let k = 0; k < n; k++) if (masks[i][k]) earlier[k] = 1;
    }
    // dangerSource for fill passes = earlierUnion ∪ NOT(allLayers).
    // Render four classes for readability:
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const d = img.data;

    for (let k = 0; k < n; k++) {
      const o = k * 4;
      const inEarlier = earlier[k] === 1;
      const inAny     = allLayers[k] === 1;
      const inTarget  = masks[target][k] === 1;
      d[o + 3] = 255;
      if (inEarlier) {
        // earlierUnion (danger): RED
        d[o]     = 220; d[o + 1] = 50;  d[o + 2] = 50;
      } else if (!inAny) {
        // background-visible (danger): LIGHT BLUE
        d[o]     = 90;  d[o + 1] = 150; d[o + 2] = 220;
      } else if (inTarget) {
        // target layer itself (context): DARK GRAY
        d[o]     = 60;  d[o + 1] = 60;  d[o + 2] = 60;
      } else {
        // later layer only (not danger): LIGHT GRAY
        d[o]     = 200; d[o + 1] = 200; d[o + 2] = 200;
      }
    }
    ctx.putImageData(img, 0, 0);

    const blob = await oc.convertToBlob({ type: 'image/png' });
    const buf  = await blob.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    out.push(btoa(bin));
  }
  return out;
}, { layerPngsB64, BRIGHTNESS_MAX });

for (let i = 0; i < outBase64s.length; i++) {
  const filename = `danger-source-layer-${String(i).padStart(2, '0')}-${layerHexes[i]}.png`;
  const path = resolve(outDir, filename);
  writeFileSync(path, Buffer.from(outBase64s[i], 'base64'));
  console.log(`  wrote ${path}`);
}

await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
