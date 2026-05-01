import { distanceTransform } from './distanceTransform';

/**
 * Plug-stock geometry helpers.
 *
 * For each layer's pocket mask we model the plug's wood stock as the
 * Minkowski sum of (convex hull of the pocket) with a disc of radius
 * `marginPx`. Plug carved area = stock − pocket. This is the area the
 * CNC has to clear from the inlay material to expose the plug.
 *
 * Why convex hull + dilation instead of bounding box: a non-convex shape
 * (e.g. an L) has a much smaller convex hull than its bounding box, so the
 * carved area is more realistic; meanwhile the disc dilation rounds the
 * corners (Minkowski sum), giving the natural "extra room to cut the plug
 * out after machining" the user described.
 */

interface Point { x: number; y: number }

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Andrew's monotone-chain convex hull. O(n log n). Returns hull vertices
 * in counter-clockwise order with collinear interior points removed.
 */
export function convexHull(points: Point[]): Point[] {
  const n = points.length;
  if (n < 3) return points.slice();

  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Drop the last point of each list because it's the first of the other.
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Scan-line fill of a convex polygon onto a binary mask. Uses the
 * half-open `[topY, bottomY)` edge convention so each scanline gets at
 * most two crossings (at left and right of the polygon for that y).
 */
export function rasterizeConvexPolygon(
  vertices: Point[],
  canvasW: number,
  canvasH: number,
): Uint8Array {
  const mask = new Uint8Array(canvasW * canvasH);
  if (vertices.length < 3) return mask;

  let minY = Infinity, maxY = -Infinity;
  for (const v of vertices) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const yStart = Math.max(0, Math.ceil(minY));
  const yEnd   = Math.min(canvasH - 1, Math.floor(maxY));

  for (let y = yStart; y <= yEnd; y++) {
    let xMin = Infinity, xMax = -Infinity;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      if (a.y === b.y) continue; // skip horizontal edges
      const top    = a.y < b.y ? a : b;
      const bottom = a.y < b.y ? b : a;
      // Half-open: include top vertex, exclude bottom vertex.
      if (top.y <= y && y < bottom.y) {
        const t = (y - top.y) / (bottom.y - top.y);
        const x = top.x + t * (bottom.x - top.x);
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
    if (xMin === Infinity) continue;
    const xa = Math.max(0, Math.ceil(xMin));
    const xb = Math.min(canvasW - 1, Math.floor(xMax));
    for (let x = xa; x <= xb; x++) mask[y * canvasW + x] = 1;
  }
  return mask;
}

/**
 * Plug stock mask: convex hull of `layerMask` dilated by `marginPx`. This
 * is the modeled wood stock the plug is cut from.
 *
 * Approach:
 *   1. Collect leftmost + rightmost mask pixel per scan-row — sufficient
 *      input for convex hull (extremes of the mask are all here).
 *   2. Compute convex hull (O(H log H) where H = canvas height).
 *   3. Rasterize hull polygon → hullMask.
 *   4. EDT of (1 − hullMask) gives distance from each pixel to the hull;
 *      pixels with distance ≤ marginPx form the dilated stock. This is the
 *      Minkowski sum of the hull with a disc of radius marginPx, giving
 *      naturally rounded corners.
 */
export function computePlugStockMask(
  layerMask: Uint8Array,
  marginPx: number,
  canvasW: number,
  canvasH: number,
): Uint8Array {
  const n = canvasW * canvasH;

  // Step 1: per-row extremes.
  const points: Point[] = [];
  for (let y = 0; y < canvasH; y++) {
    let xMin = -1, xMax = -1;
    const row = y * canvasW;
    for (let x = 0; x < canvasW; x++) {
      if (layerMask[row + x]) {
        if (xMin < 0) xMin = x;
        xMax = x;
      }
    }
    if (xMin >= 0) {
      points.push({ x: xMin, y });
      if (xMax !== xMin) points.push({ x: xMax, y });
    }
  }
  if (points.length < 3) return new Uint8Array(n);

  // Step 2-3: convex hull, rasterize.
  const hull = convexHull(points);
  const hullMask = rasterizeConvexPolygon(hull, canvasW, canvasH);

  // Step 4: distance from each pixel to hull (seeds = hull pixels).
  const seeds = new Uint8Array(n);
  for (let k = 0; k < n; k++) seeds[k] = hullMask[k] ? 0 : 1;
  const distToHull = distanceTransform(seeds, canvasW, canvasH);

  // Stock = pixels within marginPx of hull.
  const stock = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (distToHull[k] <= marginPx) stock[k] = 1;
  return stock;
}

/**
 * Plug carved mask: stock − layer. The area the CNC has to clear away
 * from the inlay material to leave the plug raised.
 */
export function computePlugCarvedMask(
  layerMask: Uint8Array,
  marginPx: number,
  canvasW: number,
  canvasH: number,
): Uint8Array {
  const stock = computePlugStockMask(layerMask, marginPx, canvasW, canvasH);
  const n = canvasW * canvasH;
  const carved = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (stock[k] && !layerMask[k]) carved[k] = 1;
  }
  return carved;
}
