/**
 * Polygon-native pocket / plug feasibility analysis for one V-bit
 * angle. Replaces the bitmap monotonic-ascent BFS with an exact
 * Minkowski model of the bit's full-depth body sweep.
 *
 * Bit geometry, in a nutshell. A V-bit at half-angle α descending
 * to depth D has a tip footprint of radius R = D · tan(α). For the
 * bit to cut at full depth at point P, the bit's tip — a disc of
 * radius R — must fit inside the carved region somewhere within R
 * of P. So:
 *   - seeds = inward offset of carved by R (= bit-tip-fits region).
 *   - full-depth coverage = outward dilation of seeds by R, clipped
 *     to carved (= bit-body sweep at full depth).
 *   - problem = carved − full-depth coverage.
 *
 * The bitmap algorithm approximates this via a level-set BFS from
 * the seeds; the polygon version computes the same area exactly.
 */

import {
  multiPolygonComponents,
  multiPolygonDifference,
  multiPolygonIntersection,
  multiPolygonOffset,
  multiPolygonUnion,
} from './clipperOps';
import {
  multiPolygonArea,
  multiPolygonIsEmpty,
  type MultiPolygon,
} from './polygon';

/** Pass threshold copied from `dfmAnalysis.ts` to keep the two implementations in lockstep. */
export const POLYGON_POCKET_PASS_THRESHOLD_PERCENT = 0.1;

export interface PolygonProblemStats {
  /** Percent of carved area that's "problem" (= unreachable at full depth). */
  percent: number;
  /** Percent of carved area at full depth (= seed area). */
  fullDepthPercent: number;
  /** True iff at least some part of carved reaches full depth. */
  hasAnyFullDepth: boolean;
  /** True iff at least one carved component has zero full-depth seeds. */
  hasIsolatedComponent: boolean;
  /** percent < PASS_THRESHOLD_PERCENT && !hasIsolatedComponent. */
  passed: boolean;
  /** Problem area, only when `returnPolygon: true`. */
  problemPolygon?: MultiPolygon;
  /** Full-depth seed area, only when `returnSeeds: true`. */
  seedsPolygon?: MultiPolygon;
  /** Full-depth bit-body coverage, only when `returnCoverage: true`. */
  coveragePolygon?: MultiPolygon;
}

export interface PolygonProblemStatsOptions {
  /**
   * Plug mode: the bit can come from off-canvas without geometric
   * constraint, so the band of width R from the design's bounding
   * box edge counts as a full-depth seed. (Bitmap analog:
   * `applyOutsideFullDepthSeeds`.)
   */
  plugMode?: boolean;
  /** Bounding box used by plug mode for the perimeter seed band. */
  designBounds?: { x0: number; y0: number; x1: number; y1: number };
  returnPolygon?: boolean;
  returnSeeds?: boolean;
  returnCoverage?: boolean;
}

const EMPTY_STATS: PolygonProblemStats = {
  percent: 0,
  fullDepthPercent: 0,
  hasAnyFullDepth: false,
  hasIsolatedComponent: false,
  passed: true,
};

export function polygonProblemStats(
  carvedMP: MultiPolygon,
  fullDepthRadius: number,
  options?: PolygonProblemStatsOptions,
): PolygonProblemStats {
  if (multiPolygonIsEmpty(carvedMP) || fullDepthRadius <= 0) {
    return {
      ...EMPTY_STATS,
      ...(options?.returnPolygon ? { problemPolygon: [] } : {}),
      ...(options?.returnSeeds   ? { seedsPolygon:   [] } : {}),
      ...(options?.returnCoverage? { coveragePolygon: [] } : {}),
    };
  }

  const carvedArea = multiPolygonArea(carvedMP);
  if (carvedArea <= 0) return EMPTY_STATS;

  let seeds = multiPolygonOffset(carvedMP, -fullDepthRadius, { joinType: 'round' });

  if (options?.plugMode && options.designBounds) {
    const b = options.designBounds;
    const outerBox: MultiPolygon = [[
      { x: b.x0, y: b.y0 },
      { x: b.x1, y: b.y0 },
      { x: b.x1, y: b.y1 },
      { x: b.x0, y: b.y1 },
    ]];
    const innerBox = multiPolygonOffset(outerBox, -fullDepthRadius);
    const frame = multiPolygonIsEmpty(innerBox)
      ? outerBox
      : multiPolygonDifference(outerBox, innerBox);
    const carvedFrame = multiPolygonIntersection(carvedMP, frame);
    if (!multiPolygonIsEmpty(carvedFrame)) {
      seeds = multiPolygonIsEmpty(seeds)
        ? carvedFrame
        : multiPolygonUnion(seeds, carvedFrame);
    }
  }

  const seedsArea = multiPolygonArea(seeds);
  const hasAnyFullDepth = !multiPolygonIsEmpty(seeds);
  const fullDepthPercent = (seedsArea / carvedArea) * 100;

  let coverage: MultiPolygon = [];
  let problem: MultiPolygon = carvedMP;
  if (hasAnyFullDepth) {
    const dilated = multiPolygonOffset(seeds, fullDepthRadius, { joinType: 'round' });
    coverage = multiPolygonIntersection(dilated, carvedMP);
    problem = multiPolygonDifference(carvedMP, coverage);
  }
  const problemArea = multiPolygonArea(problem);
  const percent = (problemArea / carvedArea) * 100;

  // Isolated-component check: walk carved's connected components,
  // flag any that doesn't intersect the seed area.
  let hasIsolatedComponent = false;
  if (!hasAnyFullDepth) {
    hasIsolatedComponent = true;
  } else {
    const components = multiPolygonComponents(carvedMP);
    for (const c of components) {
      const ringMP: MultiPolygon = [c.outer, ...c.holes.map(h => h.ring)];
      const intersect = multiPolygonIntersection(ringMP, seeds);
      if (multiPolygonIsEmpty(intersect)) {
        hasIsolatedComponent = true;
        break;
      }
    }
  }

  return {
    percent,
    fullDepthPercent,
    hasAnyFullDepth,
    hasIsolatedComponent,
    passed: percent < POLYGON_POCKET_PASS_THRESHOLD_PERCENT && !hasIsolatedComponent,
    ...(options?.returnPolygon ? { problemPolygon: problem } : {}),
    ...(options?.returnSeeds   ? { seedsPolygon:   seeds } : {}),
    ...(options?.returnCoverage? { coveragePolygon: coverage } : {}),
  };
}
