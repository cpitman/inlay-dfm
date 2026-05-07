/**
 * Polygon-native alignment-risk detection. Replaces the bitmap
 * `detectAlignmentRisk` (which works on rasterized boundary pixels
 * with a PCA-derived tangent estimate) with an exact edge-pair
 * scan: for each edge of layer A, find any edge of layer B within
 * `thresholdUnits` whose tangent is within ~15° of parallel.
 *
 * The polygon edge has an EXACT tangent (= unit edge vector), so
 * there's no anisotropy gate or PCA-window dependency. The output
 * carries:
 *   - per-A-edge affected length + total perimeter (drives the
 *     `affectedPercent` reported in the UI's alignment-issues list);
 *   - a risk polygon (= each at-risk edge expanded into a thin
 *     band of width `2 × visualHalfWidth`, all unioned), suitable
 *     for rasterization back into the existing overlay pipeline.
 */

import {
  multiPolygonUnionAll,
} from './clipperOps';
import {
  multiPolygonPerimeter,
  type MultiPolygon,
  type Point,
  type Ring,
} from './polygon';

/** cos(15°) — the same parallel threshold the bitmap version uses. */
export const PARALLEL_DOT_THRESHOLD = Math.cos(15 * Math.PI / 180);

export interface PolygonAlignmentRiskResult {
  /** Sum of all A-ring edge lengths (= total perimeter, design units). */
  totalPerimeter: number;
  /** Sum of at-risk A-edge lengths (= affected perimeter, design units). */
  affectedPerimeter: number;
  /** affectedPerimeter / totalPerimeter, in [0, 1]. 0 when there's no perimeter. */
  affectedFraction: number;
  /** Union of at-risk edges expanded into a band of width 2 × visualHalfWidth. */
  riskPolygon: MultiPolygon;
}

interface EdgeRecord {
  a: Point;
  b: Point;
  /** Unit tangent. */
  tx: number;
  ty: number;
  len: number;
}

function collectEdges(mp: MultiPolygon): EdgeRecord[] {
  const out: EdgeRecord[] = [];
  for (const ring of mp) {
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      out.push({ a, b, tx: dx / len, ty: dy / len, len });
    }
  }
  return out;
}

/** Squared distance from point `p` to segment (a, b). */
function pointToSegmentDistanceSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) {
    const px = p.x - a.x;
    const py = p.y - a.y;
    return px * px + py * py;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return ex * ex + ey * ey;
}

/** True iff segments (a1,a2) and (b1,b2) intersect (proper or touching). */
function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = (b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x);
  const d2 = (b2.x - b1.x) * (a2.y - b1.y) - (b2.y - b1.y) * (a2.x - b1.x);
  const d3 = (a2.x - a1.x) * (b1.y - a1.y) - (a2.y - a1.y) * (b1.x - a1.x);
  const d4 = (a2.x - a1.x) * (b2.y - a1.y) - (a2.y - a1.y) * (b2.x - a1.x);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear-touching cases ignored — they show up as zero-distance via
  // the endpoint checks below in the caller.
  return false;
}

/** Minimum distance between two line segments. */
function segmentSegmentDistance(a1: Point, a2: Point, b1: Point, b2: Point): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  const d2 = Math.min(
    pointToSegmentDistanceSq(a1, b1, b2),
    pointToSegmentDistanceSq(a2, b1, b2),
    pointToSegmentDistanceSq(b1, a1, a2),
    pointToSegmentDistanceSq(b2, a1, a2),
  );
  return Math.sqrt(d2);
}

/** Build an axis-aligned-to-edge rectangle of width 2×halfWidth centered on edge (a,b). */
function edgeToBandRing(a: Point, b: Point, halfWidth: number): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [];
  const nx = -dy / len * halfWidth;
  const ny =  dx / len * halfWidth;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

/**
 * Detect alignment-risk edges of `mpA` against `mpB`.
 *
 *   - thresholdUnits: max distance between A-edge and B-edge for
 *     the pair to be considered "near" (in design units).
 *   - visualHalfWidthUnits: half-width of the band drawn around
 *     each at-risk A-edge for visualization. Defaults to
 *     1.5 × thresholdUnits (mirrors the bitmap path's
 *     `alignVisualPx = max(5, alignThresholdPx * 3)` rule, with
 *     `3 × half-width = 1.5 × full width`).
 */
export function detectAlignmentRiskPolygon(
  mpA: MultiPolygon,
  mpB: MultiPolygon,
  thresholdUnits: number,
  visualHalfWidthUnits?: number,
): PolygonAlignmentRiskResult {
  const aEdges = collectEdges(mpA);
  const bEdges = collectEdges(mpB);

  const totalPerimeter = multiPolygonPerimeter(mpA);

  if (aEdges.length === 0 || bEdges.length === 0 || thresholdUnits <= 0) {
    return {
      totalPerimeter,
      affectedPerimeter: 0,
      affectedFraction: 0,
      riskPolygon: [],
    };
  }

  const halfW = visualHalfWidthUnits ?? thresholdUnits * 1.5;
  let affectedPerimeter = 0;
  const bandRings: MultiPolygon = [];

  for (let i = 0; i < aEdges.length; i++) {
    const ea = aEdges[i];
    let isAtRisk = false;
    for (let j = 0; j < bEdges.length; j++) {
      const eb = bEdges[j];
      const dot = ea.tx * eb.tx + ea.ty * eb.ty;
      if (Math.abs(dot) < PARALLEL_DOT_THRESHOLD) continue;
      const d = segmentSegmentDistance(ea.a, ea.b, eb.a, eb.b);
      if (d <= thresholdUnits) { isAtRisk = true; break; }
    }
    if (isAtRisk) {
      affectedPerimeter += ea.len;
      const ring = edgeToBandRing(ea.a, ea.b, halfW);
      if (ring.length >= 3) bandRings.push(ring);
    }
  }

  const affectedFraction = totalPerimeter > 0 ? affectedPerimeter / totalPerimeter : 0;
  const riskPolygon = bandRings.length === 0
    ? []
    : multiPolygonUnionAll(bandRings.map(r => [r]));

  return {
    totalPerimeter,
    affectedPerimeter,
    affectedFraction,
    riskPolygon,
  };
}
