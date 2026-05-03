/**
 * Connected-component utilities for binary masks. Used to:
 *   - estimate plug-stock area (`plugStockPacking.ts`), and
 *   - place issue locator badges over flagged regions in the analysis
 *     previews (small problem areas are otherwise hard to find on a
 *     thumbnail-sized image).
 *
 * Masks are W×H Uint8Arrays in row-major order; non-zero pixels belong
 * to the mask, zero pixels are background. 4-connected.
 */

export interface MaskComponent {
  /** Centroid x in pixel coordinates (mean of member pixels). */
  cx: number;
  /** Centroid y in pixel coordinates. */
  cy: number;
  /** Number of pixels in the component. */
  areaPx: number;
  /** Member pixel indices, row-major (y * w + x). Useful when callers
   *  need to do follow-up work on the component (e.g., compute a hull).
   *  Iterating once is cheap; pre-allocating saves the caller a pass. */
  pixels: number[];
}

/**
 * Find every 4-connected component in `mask`. Returns one entry per
 * component in scan order (top-left to bottom-right of the first pixel
 * encountered).
 */
export function findMaskComponents(
  mask: Uint8Array,
  w: number,
  h: number,
): MaskComponent[] {
  const n = w * h;
  const visited = new Uint8Array(n);
  const out: MaskComponent[] = [];
  const queue: number[] = [];

  for (let start = 0; start < n; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    const pixels: number[] = [];
    let sumX = 0, sumY = 0;
    let head = 0;
    while (head < queue.length) {
      const k = queue[head++];
      pixels.push(k);
      const x = k % w;
      const y = (k - x) / w;
      sumX += x;
      sumY += y;
      if (x > 0) {
        const nk = k - 1;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
      if (x < w - 1) {
        const nk = k + 1;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
      if (y > 0) {
        const nk = k - w;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
      if (y < h - 1) {
        const nk = k + w;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
    }
    out.push({
      cx: sumX / pixels.length,
      cy: sumY / pixels.length,
      areaPx: pixels.length,
      pixels,
    });
  }
  return out;
}

/**
 * Lightweight variant for callers that only need badge placement —
 * skips the per-component pixel array allocation.
 */
export function findMaskComponentCentroids(
  mask: Uint8Array,
  w: number,
  h: number,
): { cx: number; cy: number; areaPx: number }[] {
  const n = w * h;
  const visited = new Uint8Array(n);
  const out: { cx: number; cy: number; areaPx: number }[] = [];
  const queue: number[] = [];

  for (let start = 0; start < n; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let sumX = 0, sumY = 0, count = 0;
    let head = 0;
    while (head < queue.length) {
      const k = queue[head++];
      const x = k % w;
      const y = (k - x) / w;
      sumX += x; sumY += y; count++;
      if (x > 0) {
        const nk = k - 1;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
      if (x < w - 1) {
        const nk = k + 1;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
      if (y > 0) {
        const nk = k - w;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
      if (y < h - 1) {
        const nk = k + w;
        if (mask[nk] && !visited[nk]) { visited[nk] = 1; queue.push(nk); }
      }
    }
    out.push({ cx: sumX / count, cy: sumY / count, areaPx: count });
  }
  return out;
}
