/**
 * Connected-component utility for binary masks. Used to place issue
 * locator badges over flagged regions in the analysis previews —
 * small problem areas are otherwise hard to find on a thumbnail-
 * sized image.
 *
 * Masks are W×H Uint8Arrays in row-major order; non-zero pixels
 * belong to the mask, zero pixels are background. 4-connected.
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
