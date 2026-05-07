/**
 * Diagnostic: rasterize the target layer and the union of later
 * layers from a per-layer debug dump, then list each connected
 * component of the target with its size and per-component coverage
 * fraction. Mirrors what `findFullyCoveredComponents` in
 * `removeOccludedRegions.ts` decides — if a component is "almost
 * but not quite" 100% covered, this surfaces by how much.
 *
 *   npx tsx scripts/clipart/check-occluded-components.ts <design-dir> <target-folder-name>
 *
 * e.g. … /tmp/pika-occluded/01-pika layer-02-5f3f2c
 */

import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  const designDir    = process.argv[2];
  const targetFolder = process.argv[3];
  if (!designDir || !targetFolder) {
    console.error('usage: check-occluded-components <design-dir> <target-folder-name>');
    process.exit(2);
  }

  const layerFolders = readdirSync(designDir)
    .filter(n => /^layer-\d+-[0-9a-f]{6}$/.test(n))
    .sort();
  const targetIndex = layerFolders.indexOf(targetFolder);
  if (targetIndex < 0) {
    console.error(`target ${targetFolder} not in ${layerFolders.join(', ')}`);
    process.exit(2);
  }

  // Use original.svg for the TARGET (we want to diagnose what
  // removeFullyOccludedRegions saw at the moment it ran on this layer)
  // and final.svg for every OTHER layer (mirrors how pass 3 reads
  // post-hole/hull-fill versions of the later layers as it iterates).
  // Pass `final` as a 5th arg to use final.svg for the TARGET (post-applyFillAll
  // state), useful for comparing pre-fill vs post-fill component connectivity.
  const targetVariant = process.argv[5] === 'final' ? 'final.svg' : 'original.svg';
  const layerSvgs = layerFolders.map((f, i) => {
    const fname = i === targetIndex ? targetVariant : 'final.svg';
    return readFileSync(resolve(designDir, f, fname), 'utf8');
  });
  // Match production: 0.3" clearance margin around earlier-layer
  // boundaries restores any "fully-covered" pixels within range.
  const designWidthInches = process.argv[4] ? parseFloat(process.argv[4]) : 12.596307116982539;
  const EARLIER_BOUNDARY_MARGIN_INCHES = 0.3;
  const layerB64 = layerSvgs.map(svg => Buffer.from(svg, 'utf8').toString('base64'));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn) => fn;
  });
  await page.goto('about:blank');

  const dilatePxArg = process.argv[6] ? parseFloat(process.argv[6]) : 2;
  const result = await page.evaluate(async ({ layerB64, targetIndex, designWidthInches, EARLIER_BOUNDARY_MARGIN_INCHES, dilatePxArg }) => {
    const ALPHA_THRESHOLD = 30;
    const RASTER_WIDTH = 1200;

    const decode = (b64: string) => {
      const bin = atob(b64);
      return bin;
    };

    const renderToMask = async (svg: string, w: number, h: number): Promise<Uint8Array> => {
      const oc = new OffscreenCanvas(w, h);
      const ctx = oc.getContext('2d')!;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        await new Promise<void>((res, rej) => {
          const img = new Image();
          img.onload = () => { ctx.drawImage(img, 0, 0, w, h); res(); };
          img.onerror = () => rej(new Error('svg load'));
          img.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      const data = ctx.getImageData(0, 0, w, h).data;
      const mask = new Uint8Array(w * h);
      for (let k = 0; k < mask.length; k++) {
        if (data[k * 4 + 3] >= ALPHA_THRESHOLD) mask[k] = 1;
      }
      return mask;
    };

    // Find aspect from the FIRST layer's svg viewBox.
    const targetSvg = decode(layerB64[targetIndex]);
    const vbMatch = targetSvg.match(/viewBox\s*=\s*["']([^"']+)["']/);
    let aspect = 1;
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        aspect = parts[3] / parts[2];
      }
    }
    const w = RASTER_WIDTH;
    const h = Math.max(1, Math.round(w * aspect));
    const n = w * h;

    // Rasterize target.
    const target = await renderToMask(targetSvg, w, h);
    let targetPx = 0;
    for (let k = 0; k < n; k++) if (target[k]) targetPx++;

    // Rasterize ALL layers' masks (need them for laterUnion AND
    // dangerSource computation).
    const allMasks: Uint8Array[] = [];
    for (let i = 0; i < layerB64.length; i++) {
      allMasks.push(await renderToMask(decode(layerB64[i]), w, h));
    }
    const laterUnionRaw = new Uint8Array(n);
    for (let i = targetIndex + 1; i < allMasks.length; i++) {
      const m = allMasks[i];
      for (let k = 0; k < n; k++) if (m[k]) laterUnionRaw[k] = 1;
    }
    let laterPx = 0;
    for (let k = 0; k < n; k++) if (laterUnionRaw[k]) laterPx++;

    // Dilate laterUnion by `dilatePx` to mirror production's tolerance of
    // the trace-overshoot expansion that pass 2 hull-fill applies to
    // the target. Configurable via 6th CLI arg (default 2).
    const dilateBy2 = (src: Uint8Array): Uint8Array => {
      const r = dilatePxArg;
      // Distance transform from non-mask pixels back to mask.
      const D1 = 1, D2 = Math.SQRT2, INF = 1e18;
      const d = new Float64Array(n);
      for (let k = 0; k < n; k++) d[k] = src[k] ? 0 : INF;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = y * w + x;
          if (d[k] === 0) continue;
          let v = d[k];
          if (x > 0)              v = Math.min(v, d[k - 1]     + D1);
          if (y > 0)              v = Math.min(v, d[k - w]     + D1);
          if (x > 0 && y > 0)     v = Math.min(v, d[k - w - 1] + D2);
          if (x < w - 1 && y > 0) v = Math.min(v, d[k - w + 1] + D2);
          d[k] = v;
        }
      }
      for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
          const k = y * w + x;
          if (d[k] === 0) continue;
          let v = d[k];
          if (x < w - 1)              v = Math.min(v, d[k + 1]     + D1);
          if (y < h - 1)              v = Math.min(v, d[k + w]     + D1);
          if (x > 0 && y < h - 1)     v = Math.min(v, d[k + w - 1] + D2);
          if (x < w - 1 && y < h - 1) v = Math.min(v, d[k + w + 1] + D2);
          d[k] = v;
        }
      }
      const out = new Uint8Array(n);
      for (let k = 0; k < n; k++) if (d[k] <= r) out[k] = 1;
      return out;
    };
    const laterUnion = dilateBy2(laterUnionRaw);

    // Compute dangerSource = earlier-layer union ∪ background-visible.
    const allLayers = new Uint8Array(n);
    for (const m of allMasks) {
      for (let k = 0; k < n; k++) if (m[k]) allLayers[k] = 1;
    }
    // 1-px dilation of allLayers absorbs sub-pixel boundary stragglers
    // (mirrors `removeOccludedRegions.ts` after the fix).
    const dilateOne = (src: Uint8Array): Uint8Array => {
      const out = new Uint8Array(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = y * w + x;
          if (src[k]) { out[k] = 1; continue; }
          if (x > 0 && src[k - 1]) { out[k] = 1; continue; }
          if (x < w - 1 && src[k + 1]) { out[k] = 1; continue; }
          if (y > 0 && src[k - w]) { out[k] = 1; continue; }
          if (y < h - 1 && src[k + w]) { out[k] = 1; continue; }
        }
      }
      return out;
    };
    const allLayersDilated = dilateOne(allLayers);
    const dangerSource = new Uint8Array(n);
    for (let i = 0; i < targetIndex; i++) {
      const m = allMasks[i];
      for (let k = 0; k < n; k++) if (m[k]) dangerSource[k] = 1;
    }
    for (let k = 0; k < n; k++) {
      if (!dangerSource[k] && !allLayersDilated[k]) dangerSource[k] = 1;
    }

    // Compute the boundary of dangerSource (1-px ring around its
    // edge), then a Chebyshev distance transform from it. Any
    // "removed" pixel within marginPx of this boundary gets restored.
    const dangerBoundary = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!dangerSource[k]) continue;
        // Boundary if any 4-neighbor is NOT in dangerSource.
        if (
          (x > 0     && !dangerSource[k - 1]) ||
          (x < w - 1 && !dangerSource[k + 1]) ||
          (y > 0     && !dangerSource[k - w]) ||
          (y < h - 1 && !dangerSource[k + w])
        ) dangerBoundary[k] = 1;
      }
    }
    // Chamfer (1, √2) DT from dangerBoundary.
    const dist = new Float64Array(n);
    const INF = 1e18;
    for (let k = 0; k < n; k++) dist[k] = dangerBoundary[k] ? 0 : INF;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (dist[k] === 0) continue;
        let d = dist[k];
        if (x > 0)              d = Math.min(d, dist[k - 1]     + 1);
        if (y > 0)              d = Math.min(d, dist[k - w]     + 1);
        if (x > 0 && y > 0)     d = Math.min(d, dist[k - w - 1] + Math.SQRT2);
        if (x < w - 1 && y > 0) d = Math.min(d, dist[k - w + 1] + Math.SQRT2);
        dist[k] = d;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const k = y * w + x;
        if (dist[k] === 0) continue;
        let d = dist[k];
        if (x < w - 1)              d = Math.min(d, dist[k + 1]     + 1);
        if (y < h - 1)              d = Math.min(d, dist[k + w]     + 1);
        if (x > 0 && y < h - 1)     d = Math.min(d, dist[k + w - 1] + Math.SQRT2);
        if (x < w - 1 && y < h - 1) d = Math.min(d, dist[k + w + 1] + Math.SQRT2);
        dist[k] = d;
      }
    }
    const pixelsPerInch = w / designWidthInches;
    const marginPx = EARLIER_BOUNDARY_MARGIN_INCHES * pixelsPerInch;

    // Find connected components of target (4-conn). Also count
    // how many of each component's pixels would survive the
    // danger-zone restoration (i.e., how much would actually be
    // removed in production).
    const visited = new Uint8Array(n);
    const components: { sizePx: number; coveredPx: number; restoredPx: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
    for (let start = 0; start < n; start++) {
      if (!target[start] || visited[start]) continue;
      visited[start] = 1;
      const queue: number[] = [start];
      let sizePx = 0;
      let coveredPx = 0;
      let restoredPx = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let head = 0;
      while (head < queue.length) {
        const k = queue[head++];
        sizePx++;
        if (laterUnion[k]) coveredPx++;
        if (dist[k] <= marginPx) restoredPx++;
        const x = k % w, y = (k - x) / w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const nbrs = [
          x > 0     ? k - 1 : -1,
          x < w - 1 ? k + 1 : -1,
          y > 0     ? k - w : -1,
          y < h - 1 ? k + w : -1,
        ];
        for (const nb of nbrs) {
          if (nb < 0) continue;
          if (!target[nb] || visited[nb]) continue;
          visited[nb] = 1;
          queue.push(nb);
        }
      }
      components.push({ sizePx, coveredPx, restoredPx, minX, maxX, minY, maxY });
    }

    return {
      canvasW: w,
      canvasH: h,
      targetPx,
      laterPx,
      marginPx,
      components: components
        .map(c => ({
          sizePx: c.sizePx,
          coveredPx: c.coveredPx,
          uncoveredPx: c.sizePx - c.coveredPx,
          restoredPx: c.restoredPx,
          bbox: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
        }))
        .sort((a, b) => b.sizePx - a.sizePx),
    };
  }, { layerB64, targetIndex, designWidthInches, EARLIER_BOUNDARY_MARGIN_INCHES, dilatePxArg });

  console.log(`canvas: ${result.canvasW} × ${result.canvasH} px (${result.canvasW * result.canvasH} total)`);
  console.log(`target mask  : ${result.targetPx} px`);
  console.log(`laterUnion   : ${result.laterPx} px`);
  console.log(`danger margin: ${result.marginPx.toFixed(1)} px`);
  console.log(`\nconnected components of target (sorted by size):`);
  result.components.slice(0, 25).forEach((c, i) => {
    const frac = c.sizePx > 0 ? c.coveredPx / c.sizePx : 0;
    const pct = (frac * 100).toFixed(2);
    const restoredPct = c.sizePx > 0 ? (c.restoredPx / c.sizePx * 100).toFixed(0) : '0';
    const passesCoverage = frac >= 0.999;
    const wouldFullyRemove = passesCoverage && c.restoredPx === 0;
    const partlyRestored = passesCoverage && c.restoredPx > 0 && c.restoredPx < c.sizePx;
    const fullyRestored = passesCoverage && c.restoredPx >= c.sizePx;
    const tag = wouldFullyRemove ? '🗑  removed'
              : fullyRestored ? '⛔ FULLY RESTORED by danger zone'
              : partlyRestored ? `⚠️  partly restored (${restoredPct}%)`
              : '';
    const bbox = `bbox=(x=${c.bbox.x}..${c.bbox.x + c.bbox.w - 1}, y=${c.bbox.y}..${c.bbox.y + c.bbox.h - 1})`;
    console.log(`  #${i + 1}: size=${c.sizePx}, covered=${pct}%, restored=${c.restoredPx} (${restoredPct}%), ${bbox} ${tag}`);
  });
  const passesCov = result.components.filter(c => c.sizePx > 0 && c.coveredPx / c.sizePx >= 0.999);
  const actuallyRemoved = passesCov.filter(c => c.restoredPx === 0).length;
  console.log(`\ntotal components: ${result.components.length}`);
  console.log(`passes 99.9% coverage check: ${passesCov.length}`);
  console.log(`survives danger-zone restoration: ${actuallyRemoved} (only these are removed in production)`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
