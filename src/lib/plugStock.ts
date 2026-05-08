/**
 * Andrew's monotone-chain convex hull, kept for `fillConvexHullCovered`'s
 * polygon-vertex hull computation. The bitmap plug-stock helpers it
 * once supported (`computePlugStockMask`, `computePlugCarvedMask`,
 * `rasterizeConvexPolygon`) have been retired in favor of the polygon
 * pipeline (`computePlugStockPolygon`).
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

