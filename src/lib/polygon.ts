/**
 * Polygon-with-holes geometry primitives, used as the analytical
 * representation in the polygon-native v-carve pipeline.
 *
 * Conventions:
 *   - Coordinates are floats in the same coordinate system as the
 *     source SVG's viewBox (the "design coordinate system"). All
 *     pixel-space conversions live at the visualization boundary.
 *   - A `MultiPolygon` is a flat array of `Ring`s. Interpretation is
 *     even-odd: a point is "inside" iff the ray-cast crosses an odd
 *     number of rings. This matches SVG's default fill rule and
 *     Clipper's `PolyFillType.EvenOdd`. We do NOT pre-classify rings
 *     as outer/hole; the ops just work on the rings as a set.
 *   - Rings are NOT closed in this representation — the first vertex
 *     is implicitly the same as the last for area/perimeter math.
 *     Callers MUST NOT push a duplicate closing vertex.
 *
 * The underlying Clipper boolean ops + offset produce valid
 * `MultiPolygon`s on any sane input (deduplicated, non-self-
 * intersecting after canonicalization). Callers that need a stricter
 * outer/hole hierarchy can derive it via point-in-polygon.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * A single closed ring. Adjacent points are connected; the last
 * connects back to the first. No closing duplicate. Winding is
 * irrelevant under the even-odd rule we adopt.
 */
export type Ring = Point[];

/**
 * Polygon-with-holes (or multi-polygon) under the even-odd fill
 * rule. Use a flat array of rings; the rule decides which points
 * are inside.
 */
export type MultiPolygon = Ring[];

/** Empty multi-polygon (no rings). */
export const EMPTY_MULTIPOLYGON: MultiPolygon = [];

/**
 * Signed area of a single ring via the shoelace formula. Positive
 * for CCW-wound rings, negative for CW. Useful as the per-ring
 * contribution to `multiPolygonArea` (which sums absolute values
 * weighted by the even-odd rule, but for typical SVG output where
 * outer rings are CCW + holes are CW, the SUM of signed areas
 * coincides with the even-odd interpretation).
 */
export function ringSignedArea(ring: Ring): number {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

/**
 * Total absolute area of a multi-polygon. The sum-of-signed-areas
 * coincides with the even-odd-rule area when outer rings are CCW
 * and holes are CW (the standard convention Clipper produces). For
 * general input, this returns the SIGNED sum, which a caller can
 * `Math.abs` if they only want magnitude.
 */
export function multiPolygonSignedArea(mp: MultiPolygon): number {
  let s = 0;
  for (const r of mp) s += ringSignedArea(r);
  return s;
}

/** Convenience: absolute area of a multi-polygon. */
export function multiPolygonArea(mp: MultiPolygon): number {
  return Math.abs(multiPolygonSignedArea(mp));
}

/** Sum of all ring perimeters. */
export function multiPolygonPerimeter(mp: MultiPolygon): number {
  let p = 0;
  for (const r of mp) {
    if (r.length < 2) continue;
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      p += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return p;
}

/** Axis-aligned bounding box. Returns null for an empty polygon. */
export function multiPolygonBounds(mp: MultiPolygon): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const r of mp) {
    for (const p of r) {
      any = true;
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return any ? { x0, y0, x1, y1 } : null;
}

/** True iff the multi-polygon contains no rings (or only degenerate rings). */
export function multiPolygonIsEmpty(mp: MultiPolygon): boolean {
  if (mp.length === 0) return true;
  for (const r of mp) if (r.length >= 3) return false;
  return true;
}

/**
 * Even-odd ray-cast point-in-polygon test. The horizontal ray
 * extends from `p` in the +x direction; an edge contributes a
 * crossing iff it straddles `p.y` (one endpoint above, one below
 * or at) AND the ray hits the edge to the right of `p.x`.
 *
 * The strict `<= p.y` half-open convention on one endpoint and
 * `< p.y` (= !`<=`) on the other prevents double-counting at
 * vertex-coincident rays. Each ring's parity is XOR'd to honor the
 * even-odd interpretation of `MultiPolygon`.
 */
export function pointInMultiPolygon(p: Point, mp: MultiPolygon): boolean {
  let inside = false;
  for (const ring of mp) {
    if (ring.length < 3) continue;
    let parity = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      const aAbove = a.y > p.y;
      const bAbove = b.y > p.y;
      if (aAbove === bAbove) continue;
      const xCross = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (xCross > p.x) parity = !parity;
    }
    if (parity) inside = !inside;
  }
  return inside;
}
