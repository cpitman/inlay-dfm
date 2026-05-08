/**
 * Polygon-native thin-wall detection. Replaces the bitmap row/column-
 * scan in `analyzeMask` with a polygon-edge ray-cast at the same
 * conceptual resolution.
 *
 * "Thin wall" = a strip of un-carved (= the hard wood between cut
 * features for pockets, or a thin raised plug feature for plugs)
 * narrower than `thresholdUnits` perpendicular to the design's
 * grain direction.
 *
 * Algorithm:
 *   - For grain="horizontal" (grain runs left-right), thin walls
 *     run vertically: at each y-sample, find x-intersections with
 *     `carvedMP`, identify un-carved intervals bounded by carved on
 *     both sides, emit ones with width < threshold.
 *   - For grain="vertical", scan x-samples for thin y-runs.
 *   - For grain="end", no thin-wall analysis (end-grain is
 *     dimensionally stable, narrow features hold).
 *
 * Each emitted thin run becomes a small rectangle covering one
 * sample step's worth of length. After all samples are scanned,
 * the rectangles are unioned via Clipper into compact thin-wall
 * components. Components below `minAreaSqUnits` are dropped (= the
 * polygon analog of the bitmap path's `MIN_THIN_WALL_AREA_SQ_IN`
 * filter).
 */

import { canonicalizeRings, multiPolygonComponents } from './clipperOps';
import {
  multiPolygonArea,
  multiPolygonIsEmpty,
  type MultiPolygon,
  type Ring,
} from './polygon';

export type GrainDirection = 'horizontal' | 'vertical' | 'end';

export interface PolygonThinWallOptions {
  /** Grain runs along this axis. Thin walls are perpendicular to it. */
  grainDirection: GrainDirection;
  /** Maximum thin-wall width in design units. Below this = thin. */
  thresholdUnits: number;
  /** Design bounds (= where to bound un-carved intervals' ends). */
  designBounds: { x0: number; y0: number; x1: number; y1: number };
  /**
   * Sample step in design units. Smaller = finer detection at
   * higher cost. Defaults to threshold / 4.
   */
  sampleStepUnits?: number;
  /** Minimum thin-wall component area to keep (sq design units). */
  minAreaSqUnits?: number;
}

/**
 * Find all x-coordinates where the polygon's edges cross the
 * horizontal line y = `y`. Sorted ascending. Even-odd interpretation:
 * pairs of consecutive xs bracket "inside" the polygon.
 */
function findXIntersectionsAtY(mp: MultiPolygon, y: number): number[] {
  const xs: number[] = [];
  for (const ring of mp) {
    if (ring.length < 3) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      const aAbove = a.y > y;
      const bAbove = b.y > y;
      if (aAbove === bAbove) continue;
      const t = (y - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
  }
  xs.sort((p, q) => p - q);
  return xs;
}

/** Find all y-coordinates where the polygon's edges cross the vertical line x = `x`. */
function findYIntersectionsAtX(mp: MultiPolygon, x: number): number[] {
  const ys: number[] = [];
  for (const ring of mp) {
    if (ring.length < 3) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      const aRight = a.x > x;
      const bRight = b.x > x;
      if (aRight === bRight) continue;
      const t = (x - a.x) / (b.x - a.x);
      ys.push(a.y + t * (b.y - a.y));
    }
  }
  ys.sort((p, q) => p - q);
  return ys;
}

/**
 * Compute the thin-wall MultiPolygon for a layer. `carvedMP` is
 * the layer's mass (pocket: the inlay shape; plug: the inverted
 * complement). Thin walls = un-carved strips perpendicular to grain
 * narrower than `thresholdUnits`, bounded by carved on both sides.
 */
export function polygonThinWalls(
  carvedMP: MultiPolygon,
  options: PolygonThinWallOptions,
): MultiPolygon {
  if (options.grainDirection === 'end') return [];
  if (multiPolygonIsEmpty(carvedMP)) return [];

  const threshold = options.thresholdUnits;
  if (!(threshold > 0)) return [];
  const step = options.sampleStepUnits ?? threshold / 4;
  if (!(step > 0)) return [];
  const bounds = options.designBounds;

  const thinRects: MultiPolygon = [];

  if (options.grainDirection === 'horizontal') {
    // grain=horizontal → thin walls perpendicular = vertical → scan rows.
    for (let y = bounds.y0 + step / 2; y < bounds.y1; y += step) {
      const xs = findXIntersectionsAtY(carvedMP, y);
      // Process carved intervals at indices 0,1 / 2,3 / ... and
      // identify un-carved gaps bounded between them.
      let prevCarvedEnd = bounds.x0;
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const carvedStart = xs[i];
        const uncarvedStart = prevCarvedEnd;
        const uncarvedEnd = carvedStart;
        const isFirst = i === 0;
        const width = uncarvedEnd - uncarvedStart;
        if (!isFirst && width > 0 && width < threshold) {
          // Bounded on both sides (= prev carved + this carved).
          const ring: Ring = [
            { x: uncarvedStart, y: y - step / 2 },
            { x: uncarvedEnd,   y: y - step / 2 },
            { x: uncarvedEnd,   y: y + step / 2 },
            { x: uncarvedStart, y: y + step / 2 },
          ];
          thinRects.push(ring);
        }
        prevCarvedEnd = xs[i + 1];
      }
    }
  } else {
    // grain=vertical → thin walls perpendicular = horizontal → scan columns.
    for (let x = bounds.x0 + step / 2; x < bounds.x1; x += step) {
      const ys = findYIntersectionsAtX(carvedMP, x);
      let prevCarvedEnd = bounds.y0;
      for (let i = 0; i + 1 < ys.length; i += 2) {
        const carvedStart = ys[i];
        const uncarvedStart = prevCarvedEnd;
        const uncarvedEnd = carvedStart;
        const isFirst = i === 0;
        const height = uncarvedEnd - uncarvedStart;
        if (!isFirst && height > 0 && height < threshold) {
          const ring: Ring = [
            { x: x - step / 2, y: uncarvedStart },
            { x: x + step / 2, y: uncarvedStart },
            { x: x + step / 2, y: uncarvedEnd },
            { x: x - step / 2, y: uncarvedEnd },
          ];
          thinRects.push(ring);
        }
        prevCarvedEnd = ys[i + 1];
      }
    }
  }

  if (thinRects.length === 0) return [];

  // Union all thin-run rectangles into compact components.
  const merged = canonicalizeRings(thinRects, 'nonzero');
  if (multiPolygonIsEmpty(merged)) return [];

  // Filter components below minAreaSqUnits.
  const minArea = options.minAreaSqUnits ?? 0;
  if (minArea <= 0) return merged;

  const components = multiPolygonComponents(merged);
  const kept: Ring[] = [];
  for (const c of components) {
    const componentMP: MultiPolygon = [c.outer, ...c.holes.map(h => h.ring)];
    if (multiPolygonArea(componentMP) >= minArea) {
      kept.push(c.outer, ...c.holes.map(h => h.ring));
    }
  }
  return kept;
}
