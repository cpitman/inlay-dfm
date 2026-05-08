/**
 * Polygon-native plug stock outline. Replaces the bitmap path's
 * convex-hull-via-Andrew's-monotone-chain on mask pixels +
 * dilation, with a polygon-vertex hull + Clipper outward offset.
 *
 * The plug stock = the smallest convex region around the inlay
 * shape, dilated by `plugMarginInches`. Used by the plug-side
 * machining-time analysis (= the carved region around the plug
 * shape that the bit has to remove from the stock material).
 */

import { multiPolygonOffset } from './clipperOps';
import type { MultiPolygon, Point, Ring } from './polygon';

/**
 * Convex hull of a polygon's vertex set via Andrew's monotone chain.
 * Returns a single CCW ring. Multi-ring inputs are flattened to a
 * vertex set first; the hull doesn't care about ring topology.
 */
export function convexHullPolygon(mp: MultiPolygon): Ring {
  const points: Point[] = [];
  for (const ring of mp) {
    for (const p of ring) points.push(p);
  }
  if (points.length < 3) return points.length === 0 ? [] : [...points];

  // Sort by x then y.
  points.sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  // Lower hull.
  const lower: Point[] = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  // Upper hull.
  const upper: Point[] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  // Concatenate, dropping duplicate endpoints.
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

/**
 * Plug stock outline: convex hull of `pocketMP`, dilated outward
 * by `plugMarginInches`. The result is the polygon outline of the
 * stock material from which the plug is cut; the plug-side carved
 * region is `stockMP − pocketMP`.
 */
export function computePlugStockPolygon(
  pocketMP: MultiPolygon,
  plugMarginInches: number,
  designUnitsPerInch: number,
): MultiPolygon {
  const hullRing = convexHullPolygon(pocketMP);
  if (hullRing.length < 3) return [];
  const marginUnits = plugMarginInches * designUnitsPerInch;
  if (marginUnits <= 0) return [hullRing];
  return multiPolygonOffset([hullRing], marginUnits, { joinType: 'round' });
}
