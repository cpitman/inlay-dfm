/**
 * Diagnostic: take a source SVG, render its strokes-only mask and its
 * fills-only mask, then report per-enclosed-hole coverage at multiple
 * dilation-overshoot levels. Mirrors what `extractStrokeLayer` does
 * BEFORE the polygon round-trip — gives a clean reading on whether
 * `STROKE_TRACE_OVERSHOOT_PX` actually closes the boundary-drift gaps.
 *
 *   npx tsx scripts/clipart/check-stroke-overshoot.ts <svg-path> [<raster-width>]
 *
 * e.g. … public/clipart/pika.svg
 *
 * Defaults raster-width to 1200 (matching `extractStrokeLayer`).
 *
 * Caveat: this skips the marching-squares + DP polygon round-trip
 * that `maskToSvgPath` does in production. The reported coverage is
 * therefore an UPPER BOUND on what downstream consumers see — a
 * 100% coverage here means "the dilated mask covers everything";
 * the polygon trace may eat 0–1 px of that in places.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

async function main() {
  const svgPath = process.argv[2];
  const rasterWidth = process.argv[3] ? parseInt(process.argv[3], 10) : 1200;
  if (!svgPath || !Number.isFinite(rasterWidth)) {
    console.error('usage: check-stroke-overshoot <svg-path> [<raster-width>]');
    process.exit(2);
  }

  const svgText = readFileSync(svgPath, 'utf8');
  const overshootLevels = [0, 1, 2, 3, 4];

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // tsx wraps inner function/arrow expressions with `__name(fn, "name")`
  // when bundling for the browser context. The runtime helper isn't
  // available there, so shim it as identity before the page.evaluate.
  await page.addInitScript(() => {
    (window as unknown as { __name: (fn: unknown) => unknown }).__name =
      (fn: unknown) => fn;
  });
  await page.goto('about:blank');

  const result = await page.evaluate(async ({ svgText, rasterWidth, overshootLevels }) => {
    const ALPHA_THRESHOLD = 30;

    const withInjectedStyle = (svg: string, css: string): string =>
      svg.replace(/<svg\b[^>]*>/i, m => `${m}<style>${css}</style>`);

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

    // Chamfer (1, √2) approximate Euclidean distance transform.
    // Two passes (forward + backward) over the grid.
    const chamferEdt = (src: Uint8Array, w: number, h: number): Float64Array => {
      const n = w * h;
      const dist = new Float64Array(n);
      const INF = 1e18;
      const D1 = 1;
      const D2 = Math.SQRT2;
      for (let k = 0; k < n; k++) dist[k] = src[k] ? 0 : INF;
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
      return dist;
    };

    const dilateMask = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => {
      if (r <= 0) return mask;
      const seeds = new Uint8Array(w * h);
      for (let k = 0; k < seeds.length; k++) seeds[k] = mask[k] ? 1 : 0;
      const dist = chamferEdt(seeds, w, h);
      const out = new Uint8Array(w * h);
      for (let k = 0; k < out.length; k++) {
        if (dist[k] <= r) out[k] = 1;
      }
      return out;
    };

    const findEnclosedHoles = (mask: Uint8Array, w: number, h: number) => {
      const n = w * h;
      const visited = new Uint8Array(n);
      const queue: number[] = [];
      for (let x = 0; x < w; x++) {
        if (!mask[x] && !visited[x]) { visited[x] = 1; queue.push(x); }
        const bot = (h - 1) * w + x;
        if (!mask[bot] && !visited[bot]) { visited[bot] = 1; queue.push(bot); }
      }
      for (let y = 0; y < h; y++) {
        const left = y * w, right = left + w - 1;
        if (!mask[left] && !visited[left]) { visited[left] = 1; queue.push(left); }
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
      const holes: { sizePx: number; touchesEdge: boolean; pixels: number[] }[] = [];
      for (let start = 0; start < n; start++) {
        if (mask[start] || visited[start]) continue;
        visited[start] = 1;
        const compQueue: number[] = [start];
        const pixels: number[] = [];
        let touchesEdge = false;
        let h2 = 0;
        while (h2 < compQueue.length) {
          const k = compQueue[h2++];
          pixels.push(k);
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
        holes.push({ sizePx: pixels.length, touchesEdge, pixels });
      }
      return holes;
    };

    // Compute aspect from viewBox.
    const vbMatch = svgText.match(/viewBox\s*=\s*["']([^"']+)["']/);
    let aspect = 1;
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        aspect = parts[3] / parts[2];
      }
    }
    const w = rasterWidth;
    const h = Math.max(1, Math.round(w * aspect));
    const n = w * h;

    // Render strokes-only and fills-only.
    const fullStrokeMask = await renderToMask(
      withInjectedStyle(svgText, '*{fill:none !important}'),
      w, h,
    );
    const fillUnionMask = await renderToMask(
      withInjectedStyle(svgText, '*{stroke:none !important}'),
      w, h,
    );

    let strokePx = 0, fillPx = 0;
    for (let k = 0; k < n; k++) {
      if (fullStrokeMask[k]) strokePx++;
      if (fillUnionMask[k]) fillPx++;
    }

    // For each overshoot level, dilate stroke mask and report coverage.
    const perLevel: { overshoot: number; targetPx: number; holes: { sizePx: number; coveredPx: number; uncoveredPx: number }[] }[] = [];
    for (const overshoot of overshootLevels) {
      const target = overshoot > 0 ? dilateMask(fullStrokeMask, w, h, overshoot) : fullStrokeMask;
      let targetPx = 0;
      for (let k = 0; k < n; k++) if (target[k]) targetPx++;
      const allHoles = findEnclosedHoles(target, w, h);
      const stats = allHoles
        .filter(hh => !hh.touchesEdge)
        .map(hh => {
          let coveredPx = 0;
          for (const k of hh.pixels) {
            if (fillUnionMask[k]) coveredPx++;
          }
          return { sizePx: hh.sizePx, coveredPx, uncoveredPx: hh.sizePx - coveredPx };
        });
      perLevel.push({ overshoot, targetPx, holes: stats });
    }

    return { canvasW: w, canvasH: h, strokePx, fillPx, perLevel };
  }, { svgText, rasterWidth, overshootLevels });

  console.log(`canvas: ${result.canvasW} × ${result.canvasH} px (${result.canvasW * result.canvasH} total)`);
  console.log(`strokes-only mask: ${result.strokePx} px`);
  console.log(`fills-only mask  : ${result.fillPx} px`);

  for (const level of result.perLevel) {
    const sortedHoles = [...level.holes].sort((a, b) => b.sizePx - a.sizePx).slice(0, 15);
    console.log(`\n--- overshoot ${level.overshoot} px (target=${level.targetPx} px) ---`);
    sortedHoles.forEach((hh, i) => {
      const pct = hh.sizePx > 0 ? (hh.coveredPx / hh.sizePx * 100).toFixed(2) : 'n/a';
      console.log(`  #${i + 1}: size=${hh.sizePx} px, covered=${hh.coveredPx} (${pct}%), uncovered=${hh.uncoveredPx}`);
    });
    const total = level.holes.length;
    const fullyCovered = level.holes.filter(hh => hh.uncoveredPx === 0).length;
    const above995 = level.holes.filter(hh => hh.sizePx > 0 && hh.coveredPx / hh.sizePx >= 0.995).length;
    console.log(`total enclosed: ${total}, fully covered: ${fullyCovered}, ≥99.5%: ${above995}`);
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
