/**
 * Playwright-driven screening pass. Owns a single headless Chromium
 * instance pointed at the running dev server's
 * `/internal/screen-clipart` route, calls `window.__screenClipart`
 * for each candidate's SVG, and renders a PNG thumbnail in the same
 * page context (so we don't pay browser startup cost twice).
 *
 * Caller is responsible for starting the dev server before
 * constructing a Screener; the constructor probes for it and throws
 * an actionable error if it isn't reachable.
 */

import { chromium, type Browser, type Page } from 'playwright';

export interface ScreeningVerdict {
  ok: boolean;
  allPassed: boolean;
  worstProblemAreaPercent: number;
  hasIsolatedUnreachableComponent: boolean;
  totalAlignmentAffectedPercent: number;
  colorCount: number;
  colors: string[];
  aspectRatio: number;
  reason?: string;
}

export class Screener {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  static async launch(devServerUrl: string): Promise<Screener> {
    const route = `${devServerUrl.replace(/\/$/, '')}/internal/screen-clipart`;
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      // Surface page-side console errors to the script's stderr so
      // analysis crashes inside the headless browser don't disappear silently.
      page.on('console', msg => {
        if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
      });
      page.on('pageerror', err => console.error(`[browser] ${err.message}`));

      const res = await page.goto(route, { waitUntil: 'networkidle', timeout: 30_000 });
      if (!res || !res.ok()) {
        throw new Error(`Failed to load ${route}: HTTP ${res?.status() ?? 'no-response'}. Is "npm run dev" running?`);
      }
      // Wait for the route's useEffect to install __screenClipart on window.
      await page.waitForFunction(() => (window as { __screenClipartReady?: boolean }).__screenClipartReady === true, null, { timeout: 10_000 });
    } catch (e) {
      await browser.close();
      throw e;
    }
    return new Screener(browser, page);
  }

  /**
   * Run the DFM screening verdict for one SVG. Total wall time per
   * candidate is dominated by the per-layer rasterize + EDT + per-
   * preset feasibility passes — typically a few seconds for a
   * non-trivial multi-color design at the screening canvas width.
   */
  async screen(svgText: string): Promise<ScreeningVerdict> {
    return this.page.evaluate(async (svg: string) => {
      const fn = (window as { __screenClipart?: (s: string) => Promise<ScreeningVerdict> }).__screenClipart;
      if (!fn) throw new Error('window.__screenClipart not installed');
      return fn(svg);
    }, svgText);
  }

  /**
   * Render a PNG thumbnail of `svgText` via the headless browser's
   * own SVG → canvas → PNG pipeline. Output is `width × height`
   * pixels, padded letterbox to preserve aspect ratio.
   */
  async renderThumbnail(svgText: string, width: number, height: number): Promise<Uint8Array> {
    const dataUrl = await this.page.evaluate(async ([svg, w, h]: [string, number, number]) => {
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error('SVG image load failed'));
          i.src = url;
        });
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('OffscreenCanvas context unavailable');
        // Letterbox-fit the image into w×h.
        const aspectIn = img.width / img.height;
        const aspectOut = w / h;
        let drawW: number, drawH: number, dx: number, dy: number;
        if (aspectIn > aspectOut) {
          drawW = w;
          drawH = w / aspectIn;
          dx = 0;
          dy = (h - drawH) / 2;
        } else {
          drawH = h;
          drawW = h * aspectIn;
          dy = 0;
          dx = (w - drawW) / 2;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, dx, dy, drawW, drawH);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        const buf = await png.arrayBuffer();
        // Encode to base64 for transport across page.evaluate.
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      } finally {
        URL.revokeObjectURL(url);
      }
    }, [svgText, width, height] as [string, number, number]);
    // Decode base64 back to bytes on the Node side.
    const bin = Buffer.from(dataUrl, 'base64');
    return new Uint8Array(bin);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
