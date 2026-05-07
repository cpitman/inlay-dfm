/**
 * Diagnostic: at the lite-pass resolution, rasterize the target
 * layer + every later layer, then run `findEnclosedHoles` on the
 * target's mask and report each hole's size + how many of its pixels
 * are covered by `laterUnion`. Mirrors the per-hole logic inside
 * `runDfmAnalysisLite` / `fillEnclosedHoles` so the output matches
 * what those functions actually see.
 *
 *   npx tsx scripts/clipart/check-enclosed-holes.ts <design-dir> <design-width-inches> <target-folder-name>
 *
 * e.g. … /tmp/inlay-debug/01-pika 12.5963 layer-01-0a0a0a
 */

import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  const designDir         = process.argv[2];
  const designWidthInches = parseFloat(process.argv[3]);
  const targetFolder      = process.argv[4];
  // Optional 4th arg: dilate the target mask by N px before finding
  // holes. Simulates what `STROKE_TRACE_OVERSHOOT_PX` does upstream
  // in `extractStrokeLayer` — the polygon stored on disk was traced
  // WITHOUT the dilation, so post-hoc dilation here approximates the
  // mask that a fresh upload (with the dilation applied at trace
  // time) would produce.
  const targetDilatePx = process.argv[5] ? parseInt(process.argv[5], 10) : 0;
  if (!designDir || !Number.isFinite(designWidthInches) || !targetFolder) {
    console.error('usage: check-enclosed-holes <design-dir> <design-width-inches> <target-folder-name> [target-dilate-px]');
    process.exit(2);
  }

  const LITE_PIXELS_PER_INCH = 120;
  const liteCanvasWidth = Math.max(1, Math.ceil(designWidthInches * LITE_PIXELS_PER_INCH));

  // Discover layer folders, deduce target index from name match.
  const layerFolders = readdirSync(designDir)
    .filter(n => /^layer-\d+-[0-9a-f]{6}$/.test(n))
    .sort();
  const targetIndex = layerFolders.indexOf(targetFolder);
  if (targetIndex < 0) {
    console.error(`target ${targetFolder} not in ${layerFolders.join(', ')}`);
    process.exit(2);
  }

  // Read every layer's original.svg (so the rasterization here
  // matches what `rasterizeLayerMask` does in the actual analysis,
  // not a resampling of an already-rasterized PNG).
  const layerSvgs = layerFolders.map(f =>
    readFileSync(resolve(designDir, f, 'original.svg'), 'utf8')
  );
  // Convert each SVG string to base64 for transport into the page.
  const layerPngsB64 = layerSvgs.map(svg =>
    Buffer.from(svg, 'utf8').toString('base64')
  );

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const result: { holes: { sizePx: number; touchesEdge: boolean; coveredPx: number; uncoveredPx: number }[]; canvasW: number; canvasH: number; targetMaskPx: number; laterUnionPx: number } = await page.evaluate(async ({ layerPngsB64, liteCanvasWidth, targetIndex, targetDilatePx }) => {
    // Decode SVG bytes to URL → load via Image → rasterize at the
    // lite resolution. Mirrors `rasterizeLayerMask` exactly.
    const images = await Promise.all(layerPngsB64.map((b64: string) => new Promise<HTMLImageElement>((res, rej) => {
      const svgText = atob(b64);
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const i = new Image();
      i.onload = () => { URL.revokeObjectURL(url); res(i); };
      i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('svg load')); };
      i.src = url;
    })));
    const aspect = images[0].naturalHeight / images[0].naturalWidth;
    const w = liteCanvasWidth;
    const h = Math.max(1, Math.round(w * aspect));
    const n = w * h;

    // Rasterize each layer to a binary mask at the lite resolution.
    // Mirrors the new `rasterizeLayerToBinaryMask` in
    // `src/lib/svgLayers.ts`: TRANSPARENT canvas + alpha-threshold.
    const ALPHA_THRESHOLD = 30;
    const masks: Uint8Array[] = [];
    for (const img of images) {
      const oc = new OffscreenCanvas(w, h);
      const ctx = oc.getContext('2d')!;
      // No fillRect — leave transparent.
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const m = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        if (data[k * 4 + 3] >= ALPHA_THRESHOLD) m[k] = 1;
      }
      masks.push(m);
    }
    let mask = masks[targetIndex];
    // Optional post-hoc dilation of the target mask. Simulates the
    // upstream `STROKE_TRACE_OVERSHOOT_PX` that `extractStrokeLayer`
    // applies before tracing — the on-disk polygon was traced WITHOUT
    // it, so dilating here is a reasonable proxy for the mask a fresh
    // upload would produce.
    if (targetDilatePx > 0) {
      const D1 = 1, D2 = Math.SQRT2;
      const INF = 1e18;
      const dist = new Float64Array(n);
      for (let k = 0; k < n; k++) dist[k] = mask[k] ? 0 : INF;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = y * w + x;
          if (dist[k] === 0) continue;
          let d = dist[k];
          if (x > 0)              d = Math.min(d, dist[k - 1]     + D1);
          if (y > 0)              d = Math.min(d, dist[k - w]     + D1);
          if (x > 0 && y > 0)     d = Math.min(d, dist[k - w - 1] + D2);
          if (x < w - 1 && y > 0) d = Math.min(d, dist[k - w + 1] + D2);
          dist[k] = d;
        }
      }
      for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
          const k = y * w + x;
          if (dist[k] === 0) continue;
          let d = dist[k];
          if (x < w - 1)              d = Math.min(d, dist[k + 1]     + D1);
          if (y < h - 1)              d = Math.min(d, dist[k + w]     + D1);
          if (x > 0 && y < h - 1)     d = Math.min(d, dist[k + w - 1] + D2);
          if (x < w - 1 && y < h - 1) d = Math.min(d, dist[k + w + 1] + D2);
          dist[k] = d;
        }
      }
      const out = new Uint8Array(n);
      for (let k = 0; k < n; k++) if (dist[k] <= targetDilatePx) out[k] = 1;
      mask = out;
    }
    // Build laterUnion via a SINGLE COMBINED rasterization of every
    // later layer's SVG together. Diagnoses whether the per-hole
    // "uncovered" pixels are sub-pixel artifacts from separate
    // adjacent-layer rasterizations vs real geometric features.
    const laterSvgs = layerPngsB64.slice(targetIndex + 1).map(b64 => atob(b64));
    let laterUnion: Uint8Array;
    if (laterSvgs.length > 0) {
      // Each per-layer SVG already wraps in <svg viewBox=…>. To combine
      // we need to extract their inner contents and concatenate.
      // Easier: just render each onto the SAME transparent canvas in
      // sequence — the result is the union by alpha threshold.
      const oc = new OffscreenCanvas(w, h);
      const ctx = oc.getContext('2d')!;
      // Transparent — leave alpha 0 outside any layer.
      for (const svgText of laterSvgs) {
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const blob = new Blob([svgText], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          const i = new Image();
          i.onload = () => { URL.revokeObjectURL(url); res(i); };
          i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('svg load')); };
          i.src = url;
        });
        ctx.drawImage(img, 0, 0, w, h);
      }
      const data = ctx.getImageData(0, 0, w, h).data;
      laterUnion = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        if (data[k * 4 + 3] >= ALPHA_THRESHOLD) laterUnion[k] = 1;
      }
    } else {
      laterUnion = new Uint8Array(n);
    }
    let targetMaskPx = 0, laterUnionPx = 0;
    for (let k = 0; k < n; k++) {
      if (mask[k]) targetMaskPx++;
      if (laterUnion[k]) laterUnionPx++;
    }

    // Inline findEnclosedHoles: BFS from canvas edge through NOT-mask, then
    // collect remaining NOT-mask pixels as components.
    const visited = new Uint8Array(n);
    const queue: number[] = [];
    for (let x = 0; x < w; x++) {
      if (!mask[x] && !visited[x]) { visited[x] = 1; queue.push(x); }
      const bot = (h - 1) * w + x;
      if (!mask[bot] && !visited[bot]) { visited[bot] = 1; queue.push(bot); }
    }
    for (let y = 0; y < h; y++) {
      const left  = y * w;
      const right = left + w - 1;
      if (!mask[left]  && !visited[left])  { visited[left]  = 1; queue.push(left);  }
      if (!mask[right] && !visited[right]) { visited[right] = 1; queue.push(right); }
    }
    let head = 0;
    while (head < queue.length) {
      const k = queue[head++];
      const x = k % w, y = (k - x) / w;
      const nbrs = [
        x > 0     ? k - 1 : -1,
        x < w - 1 ? k + 1 : -1,
        y > 0     ? k - w : -1,
        y < h - 1 ? k + w : -1,
      ];
      for (const nb of nbrs) {
        if (nb < 0) continue;
        if (mask[nb] || visited[nb]) continue;
        visited[nb] = 1;
        queue.push(nb);
      }
    }

    // Components of remaining unvisited non-mask pixels = holes.
    const holes: { sizePx: number; touchesEdge: boolean; coveredPx: number; uncoveredPx: number }[] = [];
    for (let start = 0; start < n; start++) {
      if (mask[start] || visited[start]) continue;
      visited[start] = 1;
      const compQueue: number[] = [start];
      let size = 0;
      let coveredPx = 0;
      let uncoveredPx = 0;
      let touchesEdge = false;
      let h2 = 0;
      while (h2 < compQueue.length) {
        const k = compQueue[h2++];
        size++;
        if (laterUnion[k]) coveredPx++; else uncoveredPx++;
        const x = k % w, y = (k - x) / w;
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touchesEdge = true;
        const nbrs = [
          x > 0     ? k - 1 : -1,
          x < w - 1 ? k + 1 : -1,
          y > 0     ? k - w : -1,
          y < h - 1 ? k + w : -1,
        ];
        for (const nb of nbrs) {
          if (nb < 0) continue;
          if (mask[nb] || visited[nb]) continue;
          visited[nb] = 1;
          compQueue.push(nb);
        }
      }
      holes.push({ sizePx: size, touchesEdge, coveredPx, uncoveredPx });
    }

    return { holes, canvasW: w, canvasH: h, targetMaskPx, laterUnionPx };
  }, { layerPngsB64, liteCanvasWidth, targetIndex, targetDilatePx });

  console.log(`canvas: ${result.canvasW} × ${result.canvasH} px (${result.canvasW * result.canvasH} total)`);
  console.log(`target layer mask: ${result.targetMaskPx} px`);
  console.log(`laterUnion        : ${result.laterUnionPx} px`);
  console.log(`enclosed holes (NOT touching canvas edge):`);
  result.holes
    .filter(h => !h.touchesEdge)
    .sort((a, b) => b.sizePx - a.sizePx)
    .slice(0, 15)
    .forEach((h, i) => {
      const pct = h.sizePx > 0 ? (h.coveredPx / h.sizePx * 100).toFixed(1) : 'n/a';
      console.log(`  #${i + 1}: size=${h.sizePx} px, covered=${h.coveredPx} (${pct}%), uncovered=${h.uncoveredPx}`);
    });
  const enclosedCount = result.holes.filter(h => !h.touchesEdge).length;
  const fullyCovered  = result.holes.filter(h => !h.touchesEdge && h.uncoveredPx === 0).length;
  console.log(`total enclosed: ${enclosedCount}, fully covered: ${fullyCovered}`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
