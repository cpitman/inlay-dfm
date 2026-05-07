/**
 * Diagnostic: render an SVG (a) directly, (b) after a parseSvg-like
 * round trip (bake transforms via DOM CTM, split per-color into
 * fragments, recombine, render). Compare the two pixel-by-pixel.
 *
 * Catches polygon-pipeline regressions that would silently shift,
 * XOR, or otherwise corrupt the rendered design vs. what the SVG
 * renderer produces for the original. Specifically targets the
 * fill-rule (overlapping nonzero subpaths must UNION) and
 * transform-baking issues that have come up in this branch.
 *
 *   npx tsx scripts/clipart/check-flatten-equivalence.ts <svg-path> [<raster-width>]
 *
 *   e.g. npx tsx scripts/clipart/check-flatten-equivalence.ts public/clipart/pika.svg
 *
 * Reports:
 *   - diff pixels and percent (alpha-channel-aware).
 *   - max RGB delta on a single pixel.
 *   - PASS/FAIL based on a tolerance threshold (≤0.5% diff pixels).
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

async function main() {
  const svgPath = process.argv[2];
  const rasterWidth = process.argv[3] ? parseInt(process.argv[3], 10) : 1200;
  if (!svgPath || !Number.isFinite(rasterWidth)) {
    console.error('usage: check-flatten-equivalence <svg-path> [<raster-width>]');
    process.exit(2);
  }
  const svgText = readFileSync(svgPath, 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __name: (fn: unknown) => unknown }).__name =
      (fn: unknown) => fn;
  });
  await page.goto('about:blank');

  const result = await page.evaluate(async ({ svgText, rasterWidth }) => {
    const renderToImageData = async (svg: string, w: number, h: number): Promise<ImageData> => {
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
      return ctx.getImageData(0, 0, w, h);
    };

    // ---- Inline minimal version of bakeSvgTransforms.
    // Mirrors src/lib/svgFlatten.ts (kept in sync manually). The
    // production path is what /quote actually runs; this re-implements
    // it inline so the script needs no module bundling.
    const bakeSvgTransforms = async (svgText: string): Promise<string> => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;visibility:hidden;width:0;height:0;overflow:hidden;';
      document.body.appendChild(host);
      host.innerHTML = svgText;
      try {
        const svg = host.querySelector('svg');
        if (!svg) return svgText;
        void (svg as SVGSVGElement).getBoundingClientRect();

        const SHAPE_TAGS = ['path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'line'];
        const shapes = Array.from(svg.querySelectorAll(SHAPE_TAGS.join(','))) as SVGGraphicsElement[];

        // Inline shape-to-path-d.
        const shapeToD = (el: SVGGraphicsElement): string => {
          const tag = el.tagName.toLowerCase();
          switch (tag) {
            case 'path': return el.getAttribute('d') ?? '';
            case 'polyline':
            case 'polygon': {
              const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
              if (pts.length < 4) return '';
              let d = `M ${pts[0]} ${pts[1]}`;
              for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
              if (tag === 'polygon') d += ' Z';
              return d;
            }
            case 'rect': {
              const x = parseFloat(el.getAttribute('x') ?? '0');
              const y = parseFloat(el.getAttribute('y') ?? '0');
              const w = parseFloat(el.getAttribute('width') ?? '0');
              const h = parseFloat(el.getAttribute('height') ?? '0');
              if (!(w > 0) || !(h > 0)) return '';
              return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
            }
            case 'circle': {
              const cx = parseFloat(el.getAttribute('cx') ?? '0');
              const cy = parseFloat(el.getAttribute('cy') ?? '0');
              const r  = parseFloat(el.getAttribute('r')  ?? '0');
              if (!(r > 0)) return '';
              return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
            }
            case 'ellipse': {
              const cx = parseFloat(el.getAttribute('cx') ?? '0');
              const cy = parseFloat(el.getAttribute('cy') ?? '0');
              const rx = parseFloat(el.getAttribute('rx') ?? '0');
              const ry = parseFloat(el.getAttribute('ry') ?? '0');
              if (!(rx > 0) || !(ry > 0)) return '';
              return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
            }
            case 'line': {
              const x1 = parseFloat(el.getAttribute('x1') ?? '0');
              const y1 = parseFloat(el.getAttribute('y1') ?? '0');
              const x2 = parseFloat(el.getAttribute('x2') ?? '0');
              const y2 = parseFloat(el.getAttribute('y2') ?? '0');
              return `M ${x1} ${y1} L ${x2} ${y2}`;
            }
          }
          return '';
        };

        // Apply CTM via raw matrix multiplication on path tokens.
        // Reuses svgpath via a CDN import for fidelity with production.
        const sp = await import('https://cdn.jsdelivr.net/npm/svgpath@2.6.0/+esm') as { default: (d: string) => { transform(s: string): { toString(): string } } };
        const svgpathFn = sp.default;

        for (const el of shapes) {
          const ctm = (typeof el.getCTM === 'function' ? el.getCTM() : null);
          const d = shapeToD(el);
          if (!d) continue;
          const finalD = ctm
            ? svgpathFn(d).transform(`matrix(${ctm.a} ${ctm.b} ${ctm.c} ${ctm.d} ${ctm.e} ${ctm.f})`).toString()
            : d;
          const styles = window.getComputedStyle(el);
          const fillRuleResolved = (styles.fillRule || 'nonzero').trim().toLowerCase();
          const newPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          newPath.setAttribute('d', finalD);
          for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (['d','x','y','width','height','cx','cy','r','rx','ry','x1','y1','x2','y2','points','transform'].includes(name)) continue;
            newPath.setAttribute(attr.name, attr.value);
          }
          if (!newPath.hasAttribute('fill-rule')) {
            newPath.setAttribute('fill-rule', fillRuleResolved === 'evenodd' ? 'evenodd' : 'nonzero');
          }
          el.parentNode?.replaceChild(newPath, el);
        }
        const groups = Array.from(svg.querySelectorAll('g')) as SVGGElement[];
        for (const g of groups) g.removeAttribute('transform');

        return new XMLSerializer().serializeToString(svg);
      } finally {
        document.body.removeChild(host);
      }
    };

    // Determine raster height from the SVG's aspect ratio.
    const dims = await (async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;';
      host.innerHTML = svgText;
      document.body.appendChild(host);
      try {
        const svg = host.querySelector('svg') as SVGSVGElement | null;
        if (!svg) throw new Error('no svg root');
        const vb = svg.viewBox?.baseVal;
        const w = vb?.width || parseFloat(svg.getAttribute('width') ?? '0') || 1;
        const h = vb?.height || parseFloat(svg.getAttribute('height') ?? '0') || 1;
        return { w, h };
      } finally {
        document.body.removeChild(host);
      }
    })();
    const aspect = dims.h / dims.w;
    const rasterH = Math.max(1, Math.round(rasterWidth * aspect));

    const baked = await bakeSvgTransforms(svgText);

    const original = await renderToImageData(svgText, rasterWidth, rasterH);
    const flattened = await renderToImageData(baked, rasterWidth, rasterH);

    let diffPixels = 0;
    let maxDelta = 0;
    const diffMask = new Uint8ClampedArray(original.data.length);
    for (let i = 0; i < original.data.length; i += 4) {
      const dr = Math.abs(original.data[i]     - flattened.data[i]);
      const dg = Math.abs(original.data[i + 1] - flattened.data[i + 1]);
      const db = Math.abs(original.data[i + 2] - flattened.data[i + 2]);
      const da = Math.abs(original.data[i + 3] - flattened.data[i + 3]);
      const m = Math.max(dr, dg, db, da);
      if (m > 8) {
        diffPixels++;
        // Tint diff visualization: red for changed pixels.
        diffMask[i]     = 255;
        diffMask[i + 1] = 0;
        diffMask[i + 2] = 0;
        diffMask[i + 3] = 200;
      }
      if (m > maxDelta) maxDelta = m;
    }
    const total = original.data.length / 4;

    // Encode the original + flattened + diff for visual inspection.
    const encode = async (img: ImageData): Promise<string> => {
      const oc = new OffscreenCanvas(img.width, img.height);
      const ctx = oc.getContext('2d')!;
      ctx.putImageData(img, 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/png' });
      return new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(new Error('encode'));
        r.readAsDataURL(blob);
      });
    };
    const overlayDiff = new ImageData(diffMask, rasterWidth, rasterH);
    const [originalPng, flattenedPng, diffPng] = await Promise.all([
      encode(original), encode(flattened), encode(overlayDiff),
    ]);

    return {
      width: rasterWidth,
      height: rasterH,
      diffPixels,
      totalPixels: total,
      maxDelta,
      originalPng,
      flattenedPng,
      diffPng,
    };
  }, { svgText, rasterWidth });

  await browser.close();

  const diffPct = (result.diffPixels / result.totalPixels) * 100;
  const PASS_THRESHOLD = 0.5; // %
  const passed = diffPct <= PASS_THRESHOLD;
  console.log(`SVG: ${svgPath}`);
  console.log(`Raster: ${result.width}×${result.height}`);
  console.log(`Diff pixels: ${result.diffPixels} / ${result.totalPixels} (${diffPct.toFixed(3)}%)`);
  console.log(`Max channel delta: ${result.maxDelta}`);
  console.log(`Result: ${passed ? 'PASS' : 'FAIL'} (threshold ${PASS_THRESHOLD}%)`);

  // Write diff visualizations next to the input.
  const stem = basename(svgPath).replace(/\.svg$/i, '');
  const dataUrlToBuf = (dataUrl: string) => Buffer.from(dataUrl.split(',', 2)[1], 'base64');
  writeFileSync(resolve(`${stem}-flatten-original.png`), dataUrlToBuf(result.originalPng));
  writeFileSync(resolve(`${stem}-flatten-baked.png`), dataUrlToBuf(result.flattenedPng));
  writeFileSync(resolve(`${stem}-flatten-diff.png`), dataUrlToBuf(result.diffPng));
  console.log(`Wrote ${stem}-flatten-{original,baked,diff}.png to cwd.`);

  process.exit(passed ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
