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

import { multiPolygonComponents, multiPolygonOffset } from './clipperOps';
import { multiPolygonIsEmpty, type MultiPolygon, type Point, type Ring } from './polygon';

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

/**
 * Plug-stock packing estimate: total stock-material area required
 * to carve every inlay region of one layer, with `plugMarginInches`
 * of stock around each plug. Polygon-native replacement for the
 * bitmap `computePlugStockUsageSqIn`. Used by the guided quote
 * pipeline to charge for fraction-of-a-sheet rather than full
 * per-sheet pricing.
 *
 * Algorithm — per-component min-area-OBB sum:
 *   1. Outward-offset `pocketMP` by `plugMarginInches`. Each plug's
 *      offset region is the set of points within `marginInches` of
 *      the plug. Two plugs whose original geometry is within
 *      `2 × marginInches` end up in the same offset component.
 *   2. Walk the result's connected components — Clipper's PolyTree
 *      via `multiPolygonComponents`. Each top-level outer ring is
 *      one chunk of stock material.
 *   3. Per component: convex hull of the outer ring, then minimum-
 *      area enclosing rectangle (rotating-calipers candidate test).
 *   4. Sum OBB areas; divide by `designUnitsPerInch²` for sq inches.
 *
 * Boundary case: when two plugs' gap is exactly `2 × marginInches`,
 * Clipper unions their tangent offsets as a single component. The
 * bitmap predecessor's pixel quantization could merge or split
 * that case — a small drift is expected and well within pricing
 * rounding bands.
 */
export function computePlugStockUsageSqInPolygon(
  pocketMP: MultiPolygon,
  plugMarginInches: number,
  designUnitsPerInch: number,
): number {
  if (multiPolygonIsEmpty(pocketMP)) return 0;
  const marginUnits = plugMarginInches * designUnitsPerInch;
  const dilated = marginUnits > 0
    ? multiPolygonOffset(pocketMP, marginUnits, { joinType: 'round' })
    : pocketMP;
  if (multiPolygonIsEmpty(dilated)) return 0;

  let totalAreaUnits = 0;
  for (const comp of multiPolygonComponents(dilated)) {
    if (comp.outer.length < 3) continue;
    const hull = convexHullPolygon([comp.outer]);
    if (hull.length < 3) continue;
    totalAreaUnits += minAreaOBBArea(hull);
  }
  return totalAreaUnits / (designUnitsPerInch * designUnitsPerInch);
}

/**
 * Minimum-area enclosing rectangle of a convex polygon. The optimal
 * rectangle has one side collinear with one of the hull's edges, so
 * we test each edge direction and project all hull vertices onto
 * the edge's tangent + normal to compute that candidate's
 * dimensions. Returns area in sq design units.
 */
function minAreaOBBArea(hull: Ring): number {
  if (hull.length < 3) return 0;
  let minArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len === 0) continue;
    const ux = ex / len, uy = ey / len;
    const nx = -uy, ny = ux;
    let minU = Infinity, maxU = -Infinity;
    let minN = Infinity, maxN = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pn = p.x * nx + p.y * ny;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    const w = maxU - minU;
    const h = maxN - minN;
    const area = w * h;
    if (area < minArea) minArea = area;
  }
  return minArea === Infinity ? 0 : minArea;
}
