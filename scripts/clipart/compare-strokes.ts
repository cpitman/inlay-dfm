/**
 * Render source SVG strokes-only AND a polygon-extracted stroke SVG
 * fragment at the same canvas size, side-by-side, then write a diff
 * PNG so the visual stroke-width difference is obvious.
 *
 *   npx tsx scripts/clipart/compare-strokes.ts <source.svg> <polygon-strokes.svg> [<canvas-width>]
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

async function main() {
  const sourcePath = process.argv[2];
  const polygonPath = process.argv[3];
  const canvasW = process.argv[4] ? parseInt(process.argv[4], 10) : 1200;
  if (!sourcePath || !polygonPath) {
    console.error('usage: compare-strokes <source.svg> <polygon-strokes.svg> [canvas-w]');
    process.exit(2);
  }
  const sourceSvg = readFileSync(sourcePath, 'utf8');
  const polygonSvg = readFileSync(polygonPath, 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __name: (fn: unknown) => unknown }).__name = (fn: unknown) => fn;
  });
  await page.goto('about:blank');

  const result = await page.evaluate(async ({ sourceSvg, polygonSvg, canvasW }) => {
    const renderToPng = async (svg: string, w: number, h: number, withFillsSuppressed: boolean): Promise<{ png: string; alpha: Uint8Array }> => {
      let renderSvg = svg;
      if (withFillsSuppressed) {
        // Suppress fills AND recolor strokes black so white-stroked
        // elements (whiskers) are visible against the white bg.
        // Mirrors what the bitmap stroke-detection at v.13 did.
        renderSvg = svg.replace(/<svg\b[^>]*>/i, m => `${m}<style>*{fill:none !important; stroke:#000000 !important}</style>`);
      }
      const oc = new OffscreenCanvas(w, h);
      const ctx = oc.getContext('2d')!;
      const blob = new Blob([renderSvg], { type: 'image/svg+xml' });
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
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] >= 30 ? 1 : 0;
      const blob2 = await oc.convertToBlob({ type: 'image/png' });
      const png = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(new Error('encode'));
        r.readAsDataURL(blob2);
      });
      return { png, alpha };
    };

    const m = sourceSvg.match(/viewBox\s*=\s*"([^"]+)"/i);
    let aspect = 1;
    if (m) {
      const parts = m[1].trim().split(/[\s,]+/).map(parseFloat);
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) aspect = parts[3] / parts[2];
    }
    const canvasH = Math.max(1, Math.round(canvasW * aspect));

    const source = await renderToPng(sourceSvg, canvasW, canvasH, /* fillsSuppressed */ true);
    const polygon = await renderToPng(polygonSvg, canvasW, canvasH, false);

    let sourceCount = 0, polyCount = 0;
    let bothCount = 0, onlySource = 0, onlyPolygon = 0;
    for (let i = 0; i < source.alpha.length; i++) {
      const s = source.alpha[i], p = polygon.alpha[i];
      sourceCount += s;
      polyCount += p;
      if (s && p) bothCount++;
      else if (s && !p) onlySource++;
      else if (!s && p) onlyPolygon++;
    }

    // Visual diff: red = only-source (= bitmap-thicker), blue = only-polygon, black = both.
    const oc = new OffscreenCanvas(canvasW, canvasH);
    const ctx = oc.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const img = ctx.getImageData(0, 0, canvasW, canvasH);
    for (let i = 0; i < source.alpha.length; i++) {
      const o = i * 4;
      const s = source.alpha[i], p = polygon.alpha[i];
      if (s && p) { img.data[o] = 0; img.data[o+1] = 0; img.data[o+2] = 0; img.data[o+3] = 255; }
      else if (s) { img.data[o] = 220; img.data[o+1] = 30; img.data[o+2] = 30; img.data[o+3] = 255; }
      else if (p) { img.data[o] = 30; img.data[o+1] = 30; img.data[o+2] = 220; img.data[o+3] = 255; }
    }
    ctx.putImageData(img, 0, 0);
    const blob3 = await oc.convertToBlob({ type: 'image/png' });
    const diffPng = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(new Error('encode'));
      r.readAsDataURL(blob3);
    });

    return {
      canvasW, canvasH,
      sourcePixelCount: sourceCount,
      polygonPixelCount: polyCount,
      bothCount,
      onlySource,
      onlyPolygon,
      sourcePng: source.png,
      polygonPng: polygon.png,
      diffPng,
    };
  }, { sourceSvg, polygonSvg, canvasW });

  const ratio = result.polygonPixelCount / result.sourcePixelCount;
  console.log(`Canvas: ${result.canvasW}×${result.canvasH}`);
  console.log(`Source strokes-only opaque pixels: ${result.sourcePixelCount}`);
  console.log(`Polygon stroke layer opaque pixels: ${result.polygonPixelCount}`);
  console.log(`Ratio (polygon/source): ${ratio.toFixed(3)}`);
  console.log(`If ratio < 1, polygon is THINNER than source.`);
  console.log(`If ratio ≈ 1, they match.`);

  console.log(`Both source AND polygon: ${result.bothCount} pixels`);
  console.log(`Only in source (= bitmap-thicker): ${result.onlySource}`);
  console.log(`Only in polygon: ${result.onlyPolygon}`);
  const dataUrlToBuf = (dataUrl: string) => Buffer.from(dataUrl.split(',', 2)[1], 'base64');
  writeFileSync('_compare-source.png', dataUrlToBuf(result.sourcePng));
  writeFileSync('_compare-polygon.png', dataUrlToBuf(result.polygonPng));
  writeFileSync('_compare-diff.png', dataUrlToBuf(result.diffPng));
  console.log(`Wrote _compare-{source,polygon,diff}.png. Red = only source, blue = only polygon, black = both.`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
