import type { DFMSettings, GrainDirection, VectorData, AnalysisResult, SingleAnalysis, WoodAnalysis, AlignmentIssue, PerPresetAngleResult, PerPresetSingleSide, MachiningTimeMatrix } from '@/types';
import { distanceTransform } from './distanceTransform';
import { layerToStandaloneSvg, rasterizeLayerToBinaryMask, renderSvgToCanvas } from './svgLayers';
import { detectAlignmentRisk } from './alignmentRisk';
import { CLEARANCE_BIT_MRR, CLEARANCE_BIT_OPTIONS, getVbitRates, VBIT_PRESET_ANGLES, VBIT_RATES } from './machiningRates';
import { polygonMachiningTime, buildMachiningTimeMatrixPolygon } from './polygonMachiningTime';
import { computePlugStockPolygon } from './polygonPlugStock';
import { findEnclosedHoles } from './morphology';
import { parseViewBox } from './svgLayers';
import { computePlugStockUsageSqIn } from './plugStockPacking';
import { findMaskComponentCentroids } from './maskComponents';
import { svgFragmentToMultiPolygon, multiPolygonToSvgFragment } from './polygonParser';
import { multiPolygonDifference, multiPolygonIntersection, multiPolygonOffset, multiPolygonUnion, multiPolygonUnionAll, walkPolygonHoles } from './clipperOps';
import { multiPolygonArea, multiPolygonIsEmpty, multiPolygonPerimeter, type MultiPolygon } from './polygon';
import { polygonProblemStats, type PolygonProblemStats } from './polygonPocketStats';
import {
  polygonToPath2D,
  rasterizeMultiPolygonToMask,
  renderDepthMapToContext,
  type DesignToCanvasTransform,
} from './polygonRender';
import { detectAlignmentRiskPolygon } from './polygonAlignmentRisk';
import { polygonThinWalls } from './polygonThinWalls';

const DEFAULT_CANVAS_WIDTH = 1200;
const THIN_WALL_THRESHOLD_INCHES = 0.05;
const MIN_THIN_WALL_AREA_SQ_IN = 0.25;
const MIN_VBIT_ANGLE_SIDE_GRAIN = 60;
const ALIGNMENT_THRESHOLD_INCHES = 0.01;
// Mirror `fillEnclosedHoles`'s `HOLE_MARGIN_INCHES`. The eroded-empty
// predicate uses half this radius (= half-bit-clearance disc) so the
// stats display counts exactly the holes the optimizer would fill.
const HOLE_MARGIN_INCHES_FOR_FILLABLE = 0.13;
// A piece passes when less than this fraction of its carved area is flagged.
// Using a percentage threshold (not exact-zero) avoids false failures from
// a handful of anti-aliased or border pixels that round to "0.00%" in the UI.
const PASS_THRESHOLD_PERCENT = 0.1;

/**
 * Component-connectivity radius in pixels (Chebyshev / chess metric).
 *
 * We use 2 (5×5 neighborhood) instead of strict 8-connectivity so that
 * single-pixel gaps introduced by anti-aliased rasterization don't break
 * a continuous carved feature into many tiny pseudo-components. A thin
 * diagonal stroke at an awkward angle often rasterizes with intermediate
 * anti-aliased pixels that fall just above the in-mask brightness
 * threshold, leaving every other pixel "missing" — under 8-conn the
 * stroke looks like a chain of disconnected dots. Two carved pixels are
 * considered connected if at most one empty pixel separates them.
 *
 * Used by `monotonicAscentReachable` (level-set component for the red-
 * pixel problem overlay) and `carvedHasComponentWithoutFullDepth` (the
 * tool-feasibility check). Keeping these two consistent keeps the
 * analysis self-consistent: anything connected for one is connected for
 * the other.
 */
const CONNECTIVITY_RADIUS_PX = 2;

// ---------------------------------------------------------------------------
// Level-set reachability — connected component check at each pixel's depth.
//
// `reachable[k] === 1` iff pixel k's connected component (8-connectivity)
// of `{carved q : dist1(q) >= dist1(k)}` contains a full-depth pixel. In
// other words, there exists a path through the carved region from k to a
// full-depth pixel along which `dist1` never dips below `dist1(k)` — the
// topological version of "this pixel is on a slope toward full depth."
//
// We previously used a strict ≥-monotonic descent BFS, which is the right
// criterion in continuous space but fragile in practice: the 4-pass
// approximate EDT introduces small ~1px local-maximum bumps along the
// centerline of thin features that aren't axis-aligned. A single bump
// blocks the BFS and strands the entire downstream tip. Level-set
// reachability handles bumps gracefully — they just stick up inside the
// level cut without disconnecting it.
//
// Implementation: bucket carved pixels by floor(dist1), then sweep from
// the highest bucket downward. Within each bucket: union every pixel with
// 8-neighbors whose floor(dist1) >= the current bucket (so any neighbor
// already at the current level set joins the component), then read each
// pixel's reachable status in a second pass so bucket-mates' seed status
// propagates fully. O(n · α(n) + maxDist).
// ---------------------------------------------------------------------------
export function monotonicAscentReachable(
  carvedMask: Uint8Array,
  dist1: Float32Array,
  isFullDepth: Uint8Array,
  canvasW: number,
  canvasH: number,
): Uint8Array {
  const n = canvasW * canvasH;

  // Bucket index = floor(dist1). Find the highest bucket index in use.
  let maxBucket = 0;
  for (let k = 0; k < n; k++) {
    if (carvedMask[k]) {
      const b = Math.floor(dist1[k]);
      if (b > maxBucket) maxBucket = b;
    }
  }

  // Linked-list buckets so we can iterate carved pixels at each level
  // without allocating per-bucket arrays.
  const bucketHead = new Int32Array(maxBucket + 1).fill(-1);
  const bucketNext = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    if (!carvedMask[k]) continue;
    const b = Math.floor(dist1[k]);
    bucketNext[k] = bucketHead[b];
    bucketHead[b] = k;
  }

  // Union-find. Each pixel is its own root; hasSeed[root] is true iff that
  // component currently contains a full-depth pixel.
  const parent = new Int32Array(n);
  const hasSeed = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    parent[k] = k;
    if (isFullDepth[k]) hasSeed[k] = 1;
  }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // Two-pass path compression.
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const unionMerge = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    parent[ra] = rb;
    if (hasSeed[ra]) hasSeed[rb] = 1;
  };

  const reachable = new Uint8Array(n);

  for (let b = maxBucket; b >= 0; b--) {
    // Pass 1 — unions. Every neighbor whose floor(dist1) >= b is either
    // already processed (in higher bucket) or will be processed in this
    // bucket; either way it belongs in the level-set at this level. We use
    // a Chebyshev radius of CONNECTIVITY_RADIUS_PX so single-pixel
    // anti-aliasing gaps in narrow diagonal strokes don't fragment the
    // level-set component (see CONNECTIVITY_RADIUS_PX docs).
    let p = bucketHead[b];
    while (p !== -1) {
      const x = p % canvasW;
      const y = (p - x) / canvasW;
      for (let dy = -CONNECTIVITY_RADIUS_PX; dy <= CONNECTIVITY_RADIUS_PX; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= canvasH) continue;
        for (let dx = -CONNECTIVITY_RADIUS_PX; dx <= CONNECTIVITY_RADIUS_PX; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= canvasW) continue;
          const nk = ny * canvasW + nx;
          if (!carvedMask[nk]) continue;
          if (Math.floor(dist1[nk]) >= b) unionMerge(p, nk);
        }
      }
      p = bucketNext[p];
    }

    // Pass 2 — read each bucket member's component seed flag.
    p = bucketHead[b];
    while (p !== -1) {
      if (hasSeed[find(p)]) reachable[p] = 1;
      p = bucketNext[p];
    }
  }

  return reachable;
}

// ---------------------------------------------------------------------------
// Lightweight problem-area % for a given V-bit angle, reusing an existing
// dist1 (distance from each carved pixel to the nearest non-carved pixel).
// Used by the bit-comparison matrix to determine whether a V-bit angle is
// feasible (≤ FEASIBILITY_PROBLEM_PCT problem area on every layer's pocket
// and plug). Does the same depth/threshold reasoning as analyzeMask but
// skips thin-wall analysis and overlay generation.
// ---------------------------------------------------------------------------
interface ProblemStatsForAngle {
  /** Percent of carved pixels that are "problem" pixels (not full depth, no level-set path to a full-depth seed). */
  percent: number;
  /** True when an entire connected carved component cannot reach full depth — too narrow for this v-bit. */
  hasIsolatedComponent: boolean;
  /** Percent of carved pixels at full depth (dist1 ≥ fullDepthRadiusPx). */
  fullDepthPercent: number;
  /** True when at least one carved pixel reaches full depth. */
  hasAnyFullDepth: boolean;
  /** True when this side passes the strict 0.1% threshold AND has no isolated unreachable component. */
  passed: boolean;
  /** Per-pixel problem mask (only populated when returnMask=true). */
  problemMask?: Uint8Array;
  /** Polygon problem region (only populated by the polygon path). */
  problemMP?: MultiPolygon;
}

/**
 * For a carved mask, mark every pixel on the canvas perimeter as
 * full-depth. Used by **plug** analysis to model the physical
 * reality that the actual stock board extends beyond the (tightly-
 * sized) analysis canvas: a thin background strip at the canvas
 * edge has plenty of v-bit clearance "off-canvas," so we treat the
 * canvas perimeter as if it bordered an unconstrained full-depth
 * region. Pocket analysis is bounded by the design's outline (its
 * EDT seeds), not by the canvas, so this doesn't apply there.
 */
function applyOutsideFullDepthSeeds(
  isFullDepth: Uint8Array,
  carvedMask: Uint8Array,
  w: number,
  h: number,
): void {
  for (let x = 0; x < w; x++) {
    if (carvedMask[x])                             isFullDepth[x] = 1;
    const bot = (h - 1) * w + x;
    if (h > 1 && carvedMask[bot])                  isFullDepth[bot] = 1;
  }
  for (let y = 1; y < h - 1; y++) {
    const left  = y * w;
    const right = left + w - 1;
    if (carvedMask[left])               isFullDepth[left]  = 1;
    if (w > 1 && carvedMask[right])     isFullDepth[right] = 1;
  }
}

function problemStatsForAngle(
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
  canvasW: number,
  canvasH: number,
  returnMask: boolean = false,
  outsideIsFullDepth: boolean = false,
): ProblemStatsForAngle {
  const n = canvasW * canvasH;
  const isFullDepth = new Uint8Array(n);
  let carvedCount = 0;
  let fullDepthCount = 0;
  for (let i = 0; i < n; i++) {
    if (!carvedMask[i]) continue;
    carvedCount++;
    if (dist1[i] >= fullDepthRadiusPx) { isFullDepth[i] = 1; fullDepthCount++; }
  }
  if (carvedCount === 0) {
    return {
      percent: 0,
      hasIsolatedComponent: false,
      fullDepthPercent: 0,
      hasAnyFullDepth: false,
      passed: true,
      ...(returnMask ? { problemMask: new Uint8Array(n) } : {}),
    };
  }

  if (outsideIsFullDepth) {
    applyOutsideFullDepthSeeds(isFullDepth, carvedMask, canvasW, canvasH);
  }

  const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, canvasW, canvasH);
  let problemCount = 0;
  const problemMask = returnMask ? new Uint8Array(n) : undefined;
  for (let i = 0; i < n; i++) {
    if (carvedMask[i] && !isFullDepth[i] && !reachable[i]) {
      problemCount++;
      if (problemMask) problemMask[i] = 1;
    }
  }

  const hasIsolatedComponent = carvedHasComponentWithoutFullDepth(
    carvedMask, dist1, fullDepthRadiusPx, canvasW, canvasH, outsideIsFullDepth,
  );
  const percent = (problemCount / carvedCount) * 100;

  return {
    percent,
    hasIsolatedComponent,
    fullDepthPercent: (fullDepthCount / carvedCount) * 100,
    hasAnyFullDepth: fullDepthCount > 0,
    passed: percent < PASS_THRESHOLD_PERCENT && !hasIsolatedComponent,
    ...(problemMask ? { problemMask } : {}),
  };
}

/** Problem-area cutoff above which a V-bit angle is considered infeasible for the design. */
const FEASIBILITY_PROBLEM_PCT = 10;

/**
 * Binary-search a monotonically-descending boolean predicate over
 * [0, length) for the largest index where it returns `true`.
 * Returns `-1` when the predicate is false everywhere.
 *
 * Used by Phase 5 to find the largest-feasible v-bit preset without
 * computing per-preset stats at every angle. Sound because v-bit
 * design-wide feasibility is monotonic: full-depth footprint is
 * `depth × tan(angle/2)`, so problem-area ascends with angle and
 * `feasible` flips at most once across the preset list.
 *
 * Probes at most `⌈log₂(length)⌉ + 1` indices.
 *
 * Exported for testing.
 */
export function binarySearchLargestFeasibleIdx(
  length: number,
  isFeasible: (idx: number) => boolean,
): number {
  let lo = 0, hi = length - 1, largest = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (isFeasible(mid)) { largest = mid; lo = mid + 1; }
    else                  { hi = mid - 1; }
  }
  return largest;
}

// ---------------------------------------------------------------------------
// Component feasibility check.
//
// Returns true iff the carved mask contains a connected component (8-conn)
// that has NO full-depth pixel anywhere inside it — i.e. an entire piece of
// the design is too small / narrow for this V-bit to ever reach full depth.
//
// This is a strictly stronger disqualification than a percent threshold: a
// 0.1%-area isolated region is still a region the bit literally can't carve
// faithfully, so the design isn't manufacturable with that bit regardless
// of how small the piece is relative to the whole.
//
// Note this is NOT equivalent to "any problem pixel exists". A connected
// carved component (e.g. a barbell) can have one full-depth lobe and one
// shallower lobe joined by a thin saddle — the shallower lobe contains
// problem pixels under the level-set criterion, but the *component* still
// has a full-depth pixel, so it's not flagged here. We only flag the case
// where an entire component is unreachable from any full-depth seed.
// ---------------------------------------------------------------------------
export function carvedHasComponentWithoutFullDepth(
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
  canvasW: number,
  canvasH: number,
  outsideIsFullDepth: boolean = false,
): boolean {
  const n = canvasW * canvasH;
  const visited = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (visited[start] || !carvedMask[start]) continue;
    let hasFullDepth = false;
    visited[start] = 1;
    const queue: number[] = [start];
    let head = 0;
    while (head < queue.length) {
      const k = queue[head++];
      const x = k % canvasW;
      const y = (k - x) / canvasW;
      if (!hasFullDepth) {
        if (dist1[k] >= fullDepthRadiusPx) {
          hasFullDepth = true;
        } else if (outsideIsFullDepth
            && (x === 0 || y === 0 || x === canvasW - 1 || y === canvasH - 1)) {
          // Plug analysis on a tightly-sized canvas: any carved
          // pixel touching the canvas perimeter has an implicit
          // off-canvas full-depth neighbor (the actual stock board
          // extends past the rasterized area).
          hasFullDepth = true;
        }
      }
      for (let dy = -CONNECTIVITY_RADIUS_PX; dy <= CONNECTIVITY_RADIUS_PX; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= canvasH) continue;
        for (let dx = -CONNECTIVITY_RADIUS_PX; dx <= CONNECTIVITY_RADIUS_PX; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= canvasW) continue;
          const nk = ny * canvasW + nx;
          if (carvedMask[nk] && !visited[nk]) {
            visited[nk] = 1;
            queue.push(nk);
          }
        }
      }
    }
    if (!hasFullDepth) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inner analysis — runs on any binary "carved mask" (1 = area being carved).
// For the pocket: carved = design (dark pixels).
// For the plug:   carved = background (light pixels, the waste around the plug).
// ---------------------------------------------------------------------------
function analyzeMask(
  carvedMask: Uint8Array,
  canvasW: number,
  canvasH: number,
  pixelsPerInch: number,
  fullDepthRadiusPx: number,
  thinWallThresholdPx: number,
  grainDirection: GrainDirection,
  vbitAngleDegrees: number,
  outsideIsFullDepth: boolean = false,
): {
  isProblem: Uint8Array;
  isThinWall: Uint8Array;
  dist1: Float32Array;
  fullDepthPercent: number;
  problemAreaPercent: number;
  hasAnyFullDepth: boolean;
  hasIsolatedUnreachableComponent: boolean;
  thinWallPixelCount: number;
  vbitAngleWarning: boolean;
  passed: boolean;
} {
  const n = canvasW * canvasH;

  // EDT 1: distance from each carved pixel to the nearest un-carved pixel
  const dist1 = distanceTransform(carvedMask, canvasW, canvasH);

  // Full-depth classification
  const isFullDepth = new Uint8Array(n);
  let carvedCount = 0, fullDepthCount = 0;
  for (let i = 0; i < n; i++) {
    if (!carvedMask[i]) continue;
    carvedCount++;
    if (dist1[i] >= fullDepthRadiusPx) { isFullDepth[i] = 1; fullDepthCount++; }
  }
  if (outsideIsFullDepth) {
    applyOutsideFullDepthSeeds(isFullDepth, carvedMask, canvasW, canvasH);
  }

  // Topological reachability through the carved region. A non-full-depth
  // pixel passes only if its level-set component contains a full-depth seed
  // — i.e., there's a path within this carved region (no shortcuts through
  // walls into a different pocket) along which dist1 never dips below the
  // pixel's own dist1.
  const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, canvasW, canvasH);

  // Problem pixels: carved, not full-depth, no level-set path to a
  // full-depth pixel within this same carved region.
  const isProblem = new Uint8Array(n);
  let problemCount = 0;
  for (let i = 0; i < n; i++) {
    if (carvedMask[i] && !isFullDepth[i] && !reachable[i]) {
      isProblem[i] = 1;
      problemCount++;
    }
  }

  // Thin wall check (side grain only).
  // Looks for thin runs of !carvedMask (the un-carved material) bounded on both sides
  // by carved pixels in the direction perpendicular to the grain.
  // - pocket: un-carved = background → detects thin un-carved walls between pocket features
  // - plug:   un-carved = design   → detects thin raised plug features
  const isThinWall = new Uint8Array(n);
  let thinWallPixelCount = 0;

  if (grainDirection !== 'end') {
    if (grainDirection === 'vertical') {
      for (let x = 0; x < canvasW; x++) {
        let y = 0;
        while (y < canvasH) {
          if (!carvedMask[y * canvasW + x]) {
            const runStart = y;
            while (y < canvasH && !carvedMask[y * canvasW + x]) y++;
            const bounded =
              runStart > 0 && !!carvedMask[(runStart - 1) * canvasW + x] &&
              y < canvasH   && !!carvedMask[y * canvasW + x];
            if (bounded && (y - runStart) < thinWallThresholdPx) {
              for (let yy = runStart; yy < y; yy++) {
                isThinWall[yy * canvasW + x] = 1;
                thinWallPixelCount++;
              }
            }
          } else {
            y++;
          }
        }
      }
    } else {
      for (let y = 0; y < canvasH; y++) {
        let x = 0;
        while (x < canvasW) {
          if (!carvedMask[y * canvasW + x]) {
            const runStart = x;
            while (x < canvasW && !carvedMask[y * canvasW + x]) x++;
            const bounded =
              runStart > 0 && !!carvedMask[y * canvasW + runStart - 1] &&
              x < canvasW   && !!carvedMask[y * canvasW + x];
            if (bounded && (x - runStart) < thinWallThresholdPx) {
              for (let xx = runStart; xx < x; xx++) {
                isThinWall[y * canvasW + xx] = 1;
                thinWallPixelCount++;
              }
            }
          } else {
            x++;
          }
        }
      }
    }

    // Filter connected components below the minimum area threshold
    if (thinWallPixelCount > 0) {
      const minPixels = MIN_THIN_WALL_AREA_SQ_IN * pixelsPerInch * pixelsPerInch;
      const visited = new Uint8Array(n);
      for (let start = 0; start < n; start++) {
        if (!isThinWall[start] || visited[start]) continue;
        const queue: number[] = [start];
        visited[start] = 1;
        let head = 0;
        while (head < queue.length) {
          const idx = queue[head++];
          const x = idx % canvasW;
          const y = (idx - x) / canvasW;
          const nb = [
            y > 0           ? idx - canvasW : -1,
            y < canvasH - 1 ? idx + canvasW : -1,
            x > 0           ? idx - 1       : -1,
            x < canvasW - 1 ? idx + 1       : -1,
          ];
          for (const n of nb) {
            if (n >= 0 && isThinWall[n] && !visited[n]) { visited[n] = 1; queue.push(n); }
          }
        }
        if (queue.length < minPixels) for (const idx of queue) isThinWall[idx] = 0;
      }
      thinWallPixelCount = 0;
      for (let i = 0; i < n; i++) if (isThinWall[i]) thinWallPixelCount++;
    }
  }

  // Component-level feasibility: a connected piece of the carved area that
  // contains no full-depth pixel at all means the V-bit literally cannot
  // carve that piece — disqualifies regardless of the percentage threshold.
  const hasIsolatedUnreachableComponent = carvedHasComponentWithoutFullDepth(
    carvedMask, dist1, fullDepthRadiusPx, canvasW, canvasH, outsideIsFullDepth,
  );
  const problemAreaPercent = carvedCount > 0 ? (problemCount / carvedCount) * 100 : 0;

  return {
    isProblem,
    isThinWall,
    dist1,
    fullDepthPercent:   carvedCount > 0 ? (fullDepthCount / carvedCount) * 100 : 0,
    problemAreaPercent,
    hasAnyFullDepth: fullDepthCount > 0,
    hasIsolatedUnreachableComponent,
    thinWallPixelCount,
    vbitAngleWarning: grainDirection !== 'end' && vbitAngleDegrees < MIN_VBIT_ANGLE_SIDE_GRAIN,
    passed: problemAreaPercent < PASS_THRESHOLD_PERCENT && !hasIsolatedUnreachableComponent,
  };
}

/**
 * Polygon-native overlay PNG builder. Replaces the per-pixel
 * `getImageData` / `putImageData` composite with `Path2D` fills.
 *
 * Channels render in priority-ascending order (= suggestion bottom,
 * problem top). Each channel first runs `destination-out` to erase
 * the canvas under its polygon (including any earlier overlay), then
 * `source-over` to paint at the channel's color and alpha. Net pixel
 * behavior matches the bitmap version's "topmost wins" + alpha-replace
 * semantics: an overlay-area pixel = (channel.rgb, channel.alpha)
 * over empty; a non-overlay pixel = base canvas at full alpha.
 */
async function buildOverlay(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  problemMP: MultiPolygon,
  thinWallMP: MultiPolygon,
  transform: DesignToCanvasTransform,
  alignmentMP?: MultiPolygon,
  smallerBitInfeasibleMP?: MultiPolygon,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);

  const drawChannel = (mp: MultiPolygon | undefined, fillStyle: string): void => {
    if (!mp || multiPolygonIsEmpty(mp)) return;
    const path = polygonToPath2D(mp, transform);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(path, 'evenodd');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = fillStyle;
    ctx.fill(path, 'evenodd');
  };

  // Priority ascending — later draws overwrite earlier in the polygon
  // overlap. (Same priority as the bitmap version: problem highest.)
  drawChannel(smallerBitInfeasibleMP, 'rgba(40, 200, 210, 0.71)'); // teal/cyan
  drawChannel(alignmentMP,            'rgba(210, 50, 210, 0.82)'); // magenta
  drawChannel(thinWallMP,             'rgba(220, 150, 30, 0.82)'); // orange
  drawChannel(problemMP,              'rgba(220, 50, 50, 0.82)');  // red

  ctx.globalCompositeOperation = 'source-over';
  return canvasToDataUrl(oc);
}

/**
 * Plug-fit clearances applied to the plug-side depth map. When provided,
 * each plug-side pixel's effective depth is:
 *   - tapered region (dist1 < fullDepthRadiusPx):
 *     `max(0, dist1/fullDepthRadiusPx · inlayDepth − glueGap)`
 *   - flat-bottom region (dist1 ≥ fullDepthRadiusPx):
 *     `inlayDepth − glueGap + surfaceGap` (uniform)
 * which produces a visible step-down at the boundary.
 */
interface DepthMapPlugFit {
  glueGapInches: number;
  surfaceGapInches: number;
  inlayDepthInches: number;
}

async function buildDepthMap(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
  plugFit?: DepthMapPlugFit,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, canvasW, canvasH);
  const d = img.data;

  // Without plugFit: ratio in [0,1], red → green.
  // With plugFit on plug side: ratio can exceed 1 in the flat-bottom region
  // (effective depth > inlayDepth). Render that range with a cyan tint so
  // the step-down at the foot of the slope is visually distinguishable.
  const inlay = plugFit?.inlayDepthInches ?? 0;
  const glueGap = plugFit?.glueGapInches ?? 0;
  const surfaceGap = plugFit?.surfaceGapInches ?? 0;
  // ratio_max for color saturation; floor at 1 so color stays in normal
  // gradient when surfaceGap is 0.
  const overshootRatio = inlay > 0 ? Math.max(0, surfaceGap / inlay) : 0;

  for (let i = 0, n = canvasW * canvasH; i < n; i++) {
    if (!carvedMask[i]) continue;
    const baseRatio = dist1[i] / fullDepthRadiusPx; // 0 at wall, 1 at full-depth boundary

    let r: number, g: number, b: number, a: number;

    if (!plugFit) {
      const ratio = Math.min(1, baseRatio);
      r = Math.round(220 - 180 * ratio);
      g = Math.round(40  + 160 * ratio);
      b = 30;
      a = 220;
    } else {
      // Effective depth in inches; capped/floored.
      const baseDepth = Math.min(1, baseRatio) * inlay;
      let effDepth: number;
      if (baseRatio >= 1) {
        // Flat-bottom region: drop by glueGap then add surfaceGap (uniform).
        effDepth = Math.max(0, inlay - glueGap + surfaceGap);
      } else {
        // Tapered region: just drop by glueGap (clamp at no-carve).
        effDepth = Math.max(0, baseDepth - glueGap);
      }
      const ratio = inlay > 0 ? effDepth / inlay : 0;

      if (ratio <= 1) {
        // Standard red → green for [0, 1].
        const r0 = Math.min(1, ratio);
        r = Math.round(220 - 180 * r0);
        g = Math.round(40  + 160 * r0);
        b = 30;
      } else {
        // Above nominal full depth — surface-gap region. Lerp from full
        // green toward a green-cyan tint scaled by how far past 1 we are.
        const over = Math.min(1, (ratio - 1) / Math.max(overshootRatio, 1e-6));
        r = Math.round(40   - 30  * over);  // 40 → 10
        g = Math.round(200);
        b = Math.round(30   + 180 * over);  // 30 → 210 (cyan-ward)
      }
      a = 220;
    }

    d[i*4]   = r;
    d[i*4+1] = g;
    d[i*4+2] = b;
    d[i*4+3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return canvasToDataUrl(oc);
}

/**
 * Polygon-native per-preset depth map. Renders successive inward
 * offsets of `carvedMP` in increasingly green tones over `base` so
 * the visible color at each pixel encodes the bit's reachable depth
 * there. Replaces `buildDepthMap` for the per-preset path; the
 * per-side path still uses the bitmap version.
 */
async function buildPolygonDepthMap(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  carvedMP: MultiPolygon,
  fullDepthRadiusUnits: number,
  transform: DesignToCanvasTransform,
  plugFit?: DepthMapPlugFit,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  renderDepthMapToContext(ctx, carvedMP, fullDepthRadiusUnits, transform, { plugFit });
  return canvasToDataUrl(oc);
}

/**
 * Polygon-native per-preset problem-stats wrapper. Internally calls
 * `polygonProblemStats` and rasterizes the resulting problem polygon
 * into a Uint8Array so the existing bitmap-based overlay PNG builder
 * and component-centroid finder can consume it without modification.
 *
 * The shape mirrors `problemStatsForAngle`'s return type so Phase 5
 * call sites stay almost identical; only the inputs change from
 * (mask, dist1) to (carvedMP).
 */
function polygonProblemStatsBitmap(
  carvedMP: MultiPolygon,
  fullDepthRadiusUnits: number,
  canvasW: number,
  canvasH: number,
  transform: DesignToCanvasTransform,
  options: {
    plugMode: boolean;
    designBounds: { x0: number; y0: number; x1: number; y1: number };
    returnMask: boolean;
  },
): ProblemStatsForAngle {
  const stats: PolygonProblemStats = polygonProblemStats(carvedMP, fullDepthRadiusUnits, {
    plugMode: options.plugMode,
    designBounds: options.designBounds,
    returnPolygon: options.returnMask,
  });
  const out: ProblemStatsForAngle = {
    percent: stats.percent,
    fullDepthPercent: stats.fullDepthPercent,
    hasAnyFullDepth: stats.hasAnyFullDepth,
    hasIsolatedComponent: stats.hasIsolatedComponent,
    passed: stats.passed,
  };
  if (options.returnMask) {
    out.problemMask = rasterizeMultiPolygonToMask(
      stats.problemPolygon ?? [], canvasW, canvasH, transform,
    );
    out.problemMP = stats.problemPolygon ?? [];
  }
  return out;
}

interface PolygonAnalyzeMaskResult {
  problemMP: MultiPolygon;
  thinWallMP: MultiPolygon;
  fullDepthPercent: number;
  problemAreaPercent: number;
  hasAnyFullDepth: boolean;
  hasIsolatedUnreachableComponent: boolean;
  thinWallAreaSqUnits: number;
  vbitAngleWarning: boolean;
  passed: boolean;
}

/**
 * Polygon-native analog of `analyzeMask`. Composes
 * `polygonProblemStats` (full-depth + bit-body coverage + problem
 * region) and `polygonThinWalls` (grain-perpendicular thin runs).
 * Replaces the bitmap-EDT + monotonic-ascent BFS + row/column scan
 * pipeline for the per-side analysis.
 */
function analyzeMaskPolygon(
  carvedMP: MultiPolygon,
  fullDepthRadiusUnits: number,
  thinWallThresholdUnits: number,
  thinWallMinAreaSqUnits: number,
  grainDirection: GrainDirection,
  vbitAngleDegrees: number,
  designBounds: { x0: number; y0: number; x1: number; y1: number },
  plugMode: boolean,
): PolygonAnalyzeMaskResult {
  const stats = polygonProblemStats(carvedMP, fullDepthRadiusUnits, {
    plugMode,
    designBounds,
    returnPolygon: true,
  });
  const thinWallMP = polygonThinWalls(carvedMP, {
    grainDirection,
    thresholdUnits: thinWallThresholdUnits,
    designBounds,
    minAreaSqUnits: thinWallMinAreaSqUnits,
  });
  const thinWallAreaSqUnits = multiPolygonArea(thinWallMP);
  return {
    problemMP: stats.problemPolygon ?? [],
    thinWallMP,
    fullDepthPercent: stats.fullDepthPercent,
    problemAreaPercent: stats.percent,
    hasAnyFullDepth: stats.hasAnyFullDepth,
    hasIsolatedUnreachableComponent: stats.hasIsolatedComponent,
    thinWallAreaSqUnits,
    vbitAngleWarning: grainDirection !== 'end' && vbitAngleDegrees < MIN_VBIT_ANGLE_SIDE_GRAIN,
    passed: stats.percent < PASS_THRESHOLD_PERCENT && !stats.hasIsolatedComponent,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// colorOrder controls which inlay is "earlier" for alignment detection.
// Defaults to vector.detectedColors order; pass woodConfigs order to reflect
// user reordering.
// ---------------------------------------------------------------------------
export interface RunDfmAnalysisOptions {
  /**
   * When `true` (default), the analysis encodes the user-angle pocket /
   * plug overlays + depth maps, the per-preset overlays + depth maps,
   * and the suggestion overlays — everything the expert flow's
   * `WoodPanel` / `Step3Vbit` / `DesignCanvas` displays.
   *
   * When `false`, all those PNG encodes are skipped (the corresponding
   * `*DataUrl` fields on the result are empty strings). The guided
   * flow doesn't read them — it renders its own overlays in the React
   * layer from the raw `widerBitInfeasibleMask` / `irreducibleProblemMask`
   * masks, which are still computed. Skipping the encodes saves
   * ~150 PNG encodes per design (≈80% of the full-pass wall-time).
   */
  produceOverlays?: boolean;
  /**
   * When `true`, Phase 5 binary-searches the v-bit preset list for the
   * largest-feasible preset instead of computing per-preset stats for
   * all 6 angles. Per-wood per-preset stats are populated only at
   * tested presets; untested presets are filled in with monotonic
   * extrapolation (sentinel `feasible` flags + stub
   * `PerPresetAngleResult` entries).
   *
   * Sound because design-wide feasibility is monotonic in v-bit angle:
   * the v-bit's full-depth footprint is `depth × tan(angle/2)`, which
   * ascends with angle, so problem-area ascends and `feasible` flips
   * at most once across the preset list.
   *
   * Only safe when downstream consumers don't read the synthesized
   * sentinel fields — currently true for the guided flow, which uses
   * the raw masks the analysis still computes. The expert flow leaves
   * this `false` (default) since its VbitSelector renders all 6
   * presets' real data.
   */
  useBinarySearchFeasibility?: boolean;
}

export async function runDfmAnalysis(
  vector: VectorData,
  settings: DFMSettings,
  colorOrder?: string[],
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
  options: RunDfmAnalysisOptions = {},
): Promise<AnalysisResult> {
  const { produceOverlays = true, useBinarySearchFeasibility = false } = options;
  const { designWidthInches, vbitAngleDegrees, inlayDepthInches, grainDirection } = settings;

  const halfAngleRad = (vbitAngleDegrees / 2) * (Math.PI / 180);
  const vbitCutWidthInches = 2 * inlayDepthInches * Math.tan(halfAngleRad);
  const fullDepthRadiusInches = inlayDepthInches * Math.tan(halfAngleRad);

  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = canvasWidth;
  const canvasH = Math.max(1, Math.round(canvasWidth * aspect));
  const pixelsPerInch = canvasW / designWidthInches;
  const fullDepthRadiusPx = fullDepthRadiusInches * pixelsPerInch;
  const thinWallThresholdPx = THIN_WALL_THRESHOLD_INCHES * pixelsPerInch;
  const alignThresholdPx = ALIGNMENT_THRESHOLD_INCHES * pixelsPerInch;

  // Same R, expressed in design units, for the polygon-native
  // per-side and per-preset paths.
  const fullDepthRadiusUnits = fullDepthRadiusInches * (vector.naturalWidth / designWidthInches);
  const thinWallThresholdUnits = THIN_WALL_THRESHOLD_INCHES * (vector.naturalWidth / designWidthInches);
  const thinWallMinAreaSqUnits = MIN_THIN_WALL_AREA_SQ_IN * (vector.naturalWidth / designWidthInches) ** 2;

  // Combined render — used only as a fallback visual backdrop if a layer's
  // per-layer canvas is missing. Per-layer canvases are now the source of
  // truth for both masks and the per-wood overlay/depth-map base image.
  const base = await renderSvgToCanvas(vector.svgString, canvasW, canvasH);
  const n = canvasW * canvasH;
  const orderedColors = colorOrder ?? vector.detectedColors;
  // ViewBox origin — non-zero after the parse-time whitespace trim. Any
  // SVG path emitted from canvas-pixel masks must add this offset so it
  // lands in the same coordinate system as the unchanged layer fragments.
  const vb = parseViewBox(vector.viewBox);

  // Design (= SVG viewBox) units per inch. Used by the polygon-
  // native per-preset path to convert R from inches into design
  // units (where Clipper offsets operate).
  const designUnitsPerInch = vb.w / designWidthInches;
  const polygonTransform: DesignToCanvasTransform = {
    scaleX: canvasW / vb.w,
    scaleY: canvasH / vb.h,
    offsetX: vb.x,
    offsetY: vb.y,
  };
  const designBounds = {
    x0: vb.x, y0: vb.y, x1: vb.x + vb.w, y1: vb.y + vb.h,
  };
  const canvasBoxMP: MultiPolygon = [[
    { x: designBounds.x0, y: designBounds.y0 },
    { x: designBounds.x1, y: designBounds.y0 },
    { x: designBounds.x1, y: designBounds.y1 },
    { x: designBounds.x0, y: designBounds.y1 },
  ]];

  // Per-layer base canvases — each shows only that layer's geometry. Used as the
  // visual backdrop for each wood's overlay/depth-map so the WoodSection canvas
  // displays only that single inlay rather than the full mixed design.
  const perLayerBases = new Map<string, OffscreenCanvas>();
  for (const layer of vector.layers) {
    const layerSvg = layerToStandaloneSvg(layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight);
    perLayerBases.set(layer.colorHex, await renderSvgToCanvas(layerSvg, canvasW, canvasH));
  }

  const args = [canvasW, canvasH, pixelsPerInch, fullDepthRadiusPx, thinWallThresholdPx, grainDirection, vbitAngleDegrees] as const;

  const plugDepthMapFit: DepthMapPlugFit | undefined =
    (settings.plugGlueGapInches > 0 || settings.plugSurfaceGapInches > 0)
      ? {
          glueGapInches: settings.plugGlueGapInches,
          surfaceGapInches: settings.plugSurfaceGapInches,
          inlayDepthInches: inlayDepthInches,
        }
      : undefined;

  const toSinglePolygon = async (
    carvedMP: MultiPolygon,
    maskData: PolygonAnalyzeMaskResult,
    problemMask: Uint8Array,
    thinWallMask: Uint8Array,
    fullDepthRadiusUnits: number,
    layerBase: OffscreenCanvas,
    alignmentMP: MultiPolygon | undefined,
    plugFit?: DepthMapPlugFit,
  ): Promise<SingleAnalysis> => {
    let thinWallPixelCount = 0;
    for (let i = 0; i < thinWallMask.length; i++) thinWallPixelCount += thinWallMask[i];
    return {
      fullDepthPercent:   maskData.fullDepthPercent,
      problemAreaPercent: maskData.problemAreaPercent,
      passed:             maskData.passed,
      hasAnyFullDepth:    maskData.hasAnyFullDepth,
      hasIsolatedUnreachableComponent: maskData.hasIsolatedUnreachableComponent,
      vbitAngleWarning:   maskData.vbitAngleWarning,
      thinWallPixelCount,
      overlayDataUrl: produceOverlays
        ? await buildOverlay(layerBase, canvasW, canvasH, maskData.problemMP, maskData.thinWallMP, polygonTransform, alignmentMP)
        : '',
      suggestionOverlayDataUrl: '',
      problemComponents: findMaskComponentCentroids(problemMask, canvasW, canvasH),
      depthMapDataUrl: produceOverlays
        ? await buildPolygonDepthMap(layerBase, canvasW, canvasH, carvedMP, fullDepthRadiusUnits, polygonTransform, plugFit)
        : '',
    };
  };

  // -----------------------------------------------------------------------
  // Phase 1: Build all pocket masks via per-layer rasterization.
  //
  // We deliberately do NOT use color-matching from the combined render here.
  // Color-matching gives the *visible* extent of each layer (what survives
  // SVG z-order), but for DFM and especially staged-alignment risk detection
  // we need each layer's *physical* extent — including any portion that the
  // extend-for-registration algorithm has placed under a later layer.
  //
  // Each layer rasterizes through `rasterizeLayerToBinaryMask` (transparent
  // canvas + alpha threshold) so antialiased edge pixels register in both
  // adjacent layers' masks consistently — independent of layer color, so
  // adjacent layers don't leave the boundary gaps that color-dependent
  // luma thresholding produces.
  // -----------------------------------------------------------------------
  const pocketMasks: Uint8Array[] = [];
  for (const colorHex of orderedColors) {
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    if (!layer) { pocketMasks.push(new Uint8Array(n)); continue; }
    pocketMasks.push(await rasterizeLayerToBinaryMask(
      layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight,
      canvasW, canvasH,
    ));
  }

  // Polygon counterpart of pocketMasks — used by the polygon-native
  // alignment-risk detector and the per-preset pocket analysis.
  // Parsed once up front so Phase 2 and Phase 4 share the result.
  const pocketPolygons: MultiPolygon[] = orderedColors.map(colorHex => {
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    return layer ? svgFragmentToMultiPolygon(layer.svgFragment) : [];
  });

  // -----------------------------------------------------------------------
  // Phase 2: Cross-pair alignment check.
  //
  // For each pair (i < j), flag layer-i boundary pixels that lie within
  // alignThresholdPx of any layer-j boundary pixel. This captures direct
  // adjacency, thin background gaps, and other close-boundary cases —
  // and correctly does NOT flag cases where one layer overlaps the other
  // by more than the threshold (boundaries are far apart in that case).
  //
  // Visual: the detected boundary strip is dilated (3× threshold radius)
  // within the inlay mask so it renders clearly. affectedPercent represents
  // the fraction of layer-i's perimeter at risk, using the un-dilated set.
  // -----------------------------------------------------------------------
  // Polygon-native alignment risk: walk each pair of polygon edges
  // and flag A's edges within `alignThresholdUnits` of any B-edge
  // that's within ~15° of parallel. Output is per-A union of bands
  // along at-risk edges, rasterized once at the end for the
  // existing buildOverlay pipeline.
  const alignThresholdUnits = ALIGNMENT_THRESHOLD_INCHES * designUnitsPerInch;
  const alignVisualHalfWidthUnits = Math.max(
    5 / polygonTransform.scaleX,                  // floor the band at ~5 px wide
    alignThresholdUnits * 1.5,                    // = 3× threshold full-width
  );

  const alignRiskPolygonsPerInlay: MultiPolygon[] = orderedColors.map(() => []);
  const alignIssues: AlignmentIssue[][] = orderedColors.map(() => []);

  for (let i = 0; i < orderedColors.length; i++) {
    const ringsForI: MultiPolygon[] = [];
    for (let j = i + 1; j < orderedColors.length; j++) {
      const r = detectAlignmentRiskPolygon(
        pocketPolygons[i], pocketPolygons[j],
        alignThresholdUnits, alignVisualHalfWidthUnits,
      );
      if (r.affectedPerimeter > 0) {
        ringsForI.push(r.riskPolygon);
        alignIssues[i].push({
          otherColorHex: orderedColors[j],
          affectedPercent: r.affectedFraction * 100,
        });
      }
    }
    if (ringsForI.length > 0) {
      alignRiskPolygonsPerInlay[i] = multiPolygonUnionAll(ringsForI);
    }
  }

  // Clip each inlay's risk polygon to the inlay's pocket polygon so
  // the band doesn't bleed into the base-board region on the
  // rendered overlay. Mirrors the bitmap path's mask AND-clip.
  const alignVisualPolygons: MultiPolygon[] = orderedColors.map((_, i) => {
    const mp = alignRiskPolygonsPerInlay[i];
    if (mp.length === 0) return [];
    return multiPolygonIntersection(mp, pocketPolygons[i]);
  });
  // Bitmap version of the same — still consumed by the legacy bitmap
  // overlay code path in Phase 5 / Phase 5.5 PNG encoders. Rasterized
  // once and reused.
  const alignVisualPerInlay: Uint8Array[] = alignVisualPolygons.map(mp =>
    mp.length === 0 ? new Uint8Array(n) : rasterizeMultiPolygonToMask(mp, canvasW, canvasH, polygonTransform),
  );

  // -----------------------------------------------------------------------
  // Phase 3: Machining-time rates (constant across layers for one analysis).
  // V-bit rates may be missing if the user is on a custom angle without
  // having supplied MRR/feed — in that case time fields are NaN and the UI
  // displays "—" instead of a number.
  // -----------------------------------------------------------------------
  const clearanceMRR = CLEARANCE_BIT_MRR[settings.clearanceBitDiameterInches];
  const vbitRates = getVbitRates(
    vbitAngleDegrees,
    settings.vbitMRRInches3PerMin,
    settings.vbitFeedInchesPerMin,
  );
  const haveMachiningRates = vbitRates !== null;

  // -----------------------------------------------------------------------
  // Phase 4: Run DFM analysis and assemble WoodAnalysis entries.
  // -----------------------------------------------------------------------
  // Plug-stock margin in pixels. Used to dilate each pocket's convex hull
  // into the modeled plug stock for the plug-side time computation.
  const plugMarginPx = settings.plugStockMarginInches * pixelsPerInch;

  // For each layer i, the union of pocket polygons for all layers j > i.
  // Used to detect "fillable" holes — holes in layer i fully covered by
  // some combination of later layers (so filling them in i changes
  // nothing visible in the final design but saves V-bit perimeter time).
  // Computed once by sweeping from highest index down.
  const laterPolygonUnions: MultiPolygon[] = orderedColors.map(() => []);
  for (let i = orderedColors.length - 2; i >= 0; i--) {
    laterPolygonUnions[i] = multiPolygonUnion(pocketPolygons[i + 1], laterPolygonUnions[i + 1]);
  }

  const woods: WoodAnalysis[] = [];
  // Per-layer data the (clearance × V-bit) matrix builder needs: pocket
  // mask + EDT, plug carved mask + EDT, plus the pocket's perimeter (used
  // as the V-bit perimeter pass length for both pocket and plug since the
  // V-bit only traces the plug *shape* boundary, not the outer stock edge).
  const matrixLayers: {
    pocketMP: MultiPolygon;
    plugCarvedMP: MultiPolygon;
    pocketPerimeterUnits: number;
    plugPerimeterUnits: number;
  }[] = [];
  // Inputs needed to rebuild each wood's overlay later (after the matrix
  // pass tells us the largest infeasible smaller-bit angle, whose mask is
  // a fourth color channel in the overlay PNG). Phase 5's per-preset path
  // reads `pocketMP` / `plugMP` for polygon-native problem stats; the
  // `pocketIsProblem` / `pocketIsThinWall` masks are passed through to the
  // existing bitmap `buildOverlay` composite.
  const overlayRebuildInputs: {
    pocketBase: OffscreenCanvas;
    plugBase: OffscreenCanvas;
    pocketIsProblem: Uint8Array;
    pocketIsThinWall: Uint8Array;
    pocketAlign?: Uint8Array;
    plugIsProblem: Uint8Array;
    plugIsThinWall: Uint8Array;
    pocketMask: Uint8Array;
    plugMask: Uint8Array;
    /** Pocket polygon (design units) for the polygon-native per-preset path. */
    pocketMP: MultiPolygon;
    /** Plug polygon (= canvas frame − pocket) for the polygon-native per-preset path. */
    plugMP: MultiPolygon;
    /** Per-side thin-wall polygon (= for `buildOverlay` polygon path). */
    pocketThinWallMP: MultiPolygon;
    plugThinWallMP: MultiPolygon;
    /** Per-side alignment polygon clipped to the layer's pocket. */
    pocketAlignMP: MultiPolygon;
  }[] = [];
  let totalMachineTime = 0;
  let anyMachineTimeMissing = false;

  for (let idx = 0; idx < orderedColors.length; idx++) {
    const colorHex = orderedColors[idx];
    const pocketMask = pocketMasks[idx];

    // Existing plug mask used for the DFM (depth/thin-wall) analysis: this
    // is the *base-board* side, the complement of the inlay color.
    const plugMaskForDfm = new Uint8Array(n);
    for (let i = 0; i < n; i++) plugMaskForDfm[i] = pocketMask[i] ? 0 : 1;

    // Polygon-native per-side analysis for stats + thin-wall + problem
    // region. For pocket: layer mass; for plug: canvas-frame minus pocket.
    // dist1 is computed separately below for machiningTimeForMask only.
    const pocketMP = pocketPolygons[idx];
    const plugMP = multiPolygonDifference(canvasBoxMP, pocketMP);
    const pocketAnalysis = analyzeMaskPolygon(
      pocketMP, fullDepthRadiusUnits, thinWallThresholdUnits, thinWallMinAreaSqUnits,
      grainDirection, vbitAngleDegrees, designBounds, /* plugMode */ false,
    );
    const plugAnalysis = analyzeMaskPolygon(
      plugMP, fullDepthRadiusUnits, thinWallThresholdUnits, thinWallMinAreaSqUnits,
      grainDirection, vbitAngleDegrees, designBounds, /* plugMode */ true,
    );

    // Rasterize the per-side problem + thin-wall polygons once and
    // share with both `toSinglePolygon` (= per-side overlay PNG) and
    // `overlayRebuildInputs` (= Phase 5's per-preset overlay rebuild).
    const pocketIsProblem  = rasterizeMultiPolygonToMask(pocketAnalysis.problemMP,  canvasW, canvasH, polygonTransform);
    const pocketIsThinWall = rasterizeMultiPolygonToMask(pocketAnalysis.thinWallMP, canvasW, canvasH, polygonTransform);
    const plugIsProblem    = rasterizeMultiPolygonToMask(plugAnalysis.problemMP,    canvasW, canvasH, polygonTransform);
    const plugIsThinWall   = rasterizeMultiPolygonToMask(plugAnalysis.thinWallMP,   canvasW, canvasH, polygonTransform);

    // Plug stock for *machining-time* purposes: convex hull of the plug
    // shape dilated by the user's margin. Carved area = stock − pocket.
    const plugStockMP = computePlugStockPolygon(pocketMP, settings.plugStockMarginInches, designUnitsPerInch);
    const plugCarvedMP = multiPolygonDifference(plugStockMP, pocketMP);

    // Stock outline path (for the plug-side display), emitted as a flat
    // <path> with fill=none + dashed orange stroke. Stroke + dash sizes
    // are fractions of viewBox width so the outline scales sensibly
    // across designs.
    const strokeW = Math.max(0.5, vector.naturalWidth * 0.003);
    const dashOn  = Math.max(2,   vector.naturalWidth * 0.012);
    const dashOff = Math.max(1.5, vector.naturalWidth * 0.008);
    const plugStockOutlineSvg = multiPolygonToSvgFragment(
      plugStockMP, '',
      `fill="none" stroke="rgb(255,140,0)" stroke-width="${strokeW.toFixed(3)}" stroke-dasharray="${dashOn.toFixed(3)},${dashOff.toFixed(3)}"`,
    );

    // Polygon-derived perimeter (in inches) for the v-bit perimeter pass.
    const pocketPerimeterUnits = multiPolygonPerimeter(pocketMP);
    const plugPerimeterUnits   = multiPolygonPerimeter(plugCarvedMP);
    const pocketPerimeterIn    = pocketPerimeterUnits / designUnitsPerInch;

    // Machining time — pocket and plug are computed independently on their
    // own carved masks. Both perimeter passes use the pocket's perimeter
    // (the plug's V-bit pass traces the plug's *shape* boundary, not the
    // outer stock edge).
    let pocketMachineTimeMinutes = NaN, plugMachineTimeMinutes = NaN, layerMachineTimeMinutes = NaN;
    let clearanceAreaSqIn = 0, vbitAreaSqIn = 0;
    let plugClearanceAreaSqIn = 0, plugVbitAreaSqIn = 0;

    if (haveMachiningRates && vbitRates) {
      const userVbitFullDepthRadiusUnits = inlayDepthInches * Math.tan(halfAngleRad) * designUnitsPerInch;
      const clearanceMrrByDiameter = new Map<number, number>([[settings.clearanceBitDiameterInches, clearanceMRR]]);
      const tPocket = polygonMachiningTime({
        carvedMP: pocketMP,
        perimeterUnits: pocketPerimeterUnits,
        designUnitsPerInch,
        clearanceBitDiametersIn: [settings.clearanceBitDiameterInches],
        clearanceMrrByDiameter,
        vbitFullDepthRadiusUnits: userVbitFullDepthRadiusUnits,
        vbitMrr: vbitRates.mrr,
        vbitFeedInchesPerMin: vbitRates.feed,
        effectiveDepthIn: inlayDepthInches,
      });
      // Plug side: the carve goes inlayDepth - glueGap + surfaceGap deep
      // (uniform). polygonMachiningTime just multiplies area × depth, so
      // pass the effective depth here.
      const effectivePlugDepthInches = Math.max(
        0,
        inlayDepthInches - settings.plugGlueGapInches + settings.plugSurfaceGapInches,
      );
      const tPlug = polygonMachiningTime({
        carvedMP: plugCarvedMP,
        perimeterUnits: plugPerimeterUnits,
        designUnitsPerInch,
        clearanceBitDiametersIn: [settings.clearanceBitDiameterInches],
        clearanceMrrByDiameter,
        vbitFullDepthRadiusUnits: userVbitFullDepthRadiusUnits,
        vbitMrr: vbitRates.mrr,
        vbitFeedInchesPerMin: vbitRates.feed,
        effectiveDepthIn: effectivePlugDepthInches,
      });
      pocketMachineTimeMinutes = tPocket.totalTimeMin;
      plugMachineTimeMinutes   = tPlug.totalTimeMin;
      layerMachineTimeMinutes  = pocketMachineTimeMinutes + plugMachineTimeMinutes;
      clearanceAreaSqIn     = tPocket.clearanceAreaSqIn;
      vbitAreaSqIn          = tPocket.vbitAreaSqIn;
      plugClearanceAreaSqIn = tPlug.clearanceAreaSqIn;
      plugVbitAreaSqIn      = tPlug.vbitAreaSqIn;
      totalMachineTime     += layerMachineTimeMinutes;
    } else {
      anyMachineTimeMissing = true;
    }

    matrixLayers.push({
      pocketMP,
      plugCarvedMP,
      pocketPerimeterUnits,
      plugPerimeterUnits,
    });

    // Fillable enclosed holes — holes in this layer's pocket that are fully
    // covered by the union of later inlay layers. Filling them saves V-bit
    // perimeter time on both pocket and plug; net-zero clearance change
    // (pocket gains the area, plug loses it equivalently).
    //
    // The "fully covered" predicate mirrors `fillEnclosedHoles` (the
    // optimizer that actually does the fill): empty `uncovered`, OR an
    // uncovered region too narrow to fit a half-bit-clearance disc. The
    // eroded-empty step rejects sub-bit-clearance numerical slivers
    // Clipper's int arithmetic leaves along the boundary, so the stats
    // count exactly the holes the optimizer would fill.
    let fillableHoleCount = 0;
    let fillableHoleAreaUnits = 0;
    let fillableHolePerimeterUnits = 0;
    if (idx < orderedColors.length - 1) {
      const allLayersUnion = multiPolygonUnion(pocketPolygons[idx], laterPolygonUnions[idx]);
      const holeMarginUnits = HOLE_MARGIN_INCHES_FOR_FILLABLE * designUnitsPerInch;
      walkPolygonHoles(pocketPolygons[idx], holeRing => {
        const holeMP: MultiPolygon = [holeRing];
        const uncovered = multiPolygonDifference(holeMP, allLayersUnion);
        let fullyCovered = multiPolygonIsEmpty(uncovered);
        if (!fullyCovered) {
          const eroded = multiPolygonOffset(uncovered, -holeMarginUnits / 2, { joinType: 'round' });
          fullyCovered = multiPolygonIsEmpty(eroded);
        }
        if (!fullyCovered) return false; // descend so nested holes still count
        fillableHoleCount++;
        fillableHoleAreaUnits += multiPolygonArea(holeMP);
        fillableHolePerimeterUnits += multiPolygonPerimeter(holeMP);
        return true; // skip descending — full-fill absorbs nested geometry
      });
    }
    const fillableHoleAreaSqIn = fillableHoleAreaUnits / (designUnitsPerInch * designUnitsPerInch);
    const fillableHolePerimeterIn = fillableHolePerimeterUnits / designUnitsPerInch;
    // Net-zero clearance model: savings is purely the V-bit perimeter time
    // on pocket + plug. NaN when V-bit feed rate is missing.
    const fillableSavedTimeMin = (vbitRates && vbitRates.feed > 0)
      ? (2 * fillableHolePerimeterIn) / vbitRates.feed
      : NaN;

    // Pocket-side base = layer SVG only (existing). Plug-side base layers
    // the plug-stock outline on top so threshold/depth-map overlay PNGs
    // also show the orange dashed stock boundary.
    const pocketBase = perLayerBases.get(colorHex) ?? base;
    let plugBase = pocketBase;
    const targetLayer = vector.layers.find(l => l.colorHex === colorHex);
    if (targetLayer && plugStockOutlineSvg) {
      const plugBaseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.viewBox}" width="${vector.naturalWidth}" height="${vector.naturalHeight}">
${targetLayer.svgFragment}
${plugStockOutlineSvg}
</svg>`;
      plugBase = await renderSvgToCanvas(plugBaseSvg, canvasW, canvasH);
    }
    // Plug-stock packing estimate: per-component OBB sum of the plug
    // shapes dilated by the user's plug margin. Disjoint plug regions
    // far apart enough to be cut from separate stock pieces (i.e.,
    // their dilated versions don't intersect) contribute their own
    // smaller OBB instead of being absorbed into one big design-wide
    // hull. Drives the fractional inlay cost in the guided quote
    // pipeline; harmless to compute for the expert flow.
    const plugStockUsageSqIn = computePlugStockUsageSqIn(
      pocketMask, canvasW, canvasH, pixelsPerInch,
      settings.plugStockMarginInches,
    );

    woods.push({
      colorHex,
      pocket: await toSinglePolygon(pocketMP, pocketAnalysis, pocketIsProblem, pocketIsThinWall, fullDepthRadiusUnits, pocketBase, alignRiskPolygonsPerInlay[idx]),
      plug:   await toSinglePolygon(plugMP,   plugAnalysis,   plugIsProblem,   plugIsThinWall,   fullDepthRadiusUnits, plugBase, undefined, plugDepthMapFit),
      perPresetAnalysis: [], // populated in Phase 5 below
      widerBitInfeasibleMask: null, // populated in Phase 5.5 below if applicable
      irreducibleProblemMask: null, // populated in Phase 5.5 only when no preset is feasible
      alignmentIssues: alignIssues[idx],
      clearanceAreaSqIn,
      vbitAreaSqIn,
      perimeterIn: pocketPerimeterIn,
      plugClearanceAreaSqIn,
      plugVbitAreaSqIn,
      plugStockOutlineSvg,
      fillableHoleCount,
      fillableHoleAreaSqIn,
      fillableSavedTimeMin,
      plugStockUsageSqIn,
      pocketMachineTimeMinutes,
      plugMachineTimeMinutes,
      layerMachineTimeMinutes,
    });

    overlayRebuildInputs.push({
      pocketBase,
      plugBase,
      pocketIsProblem,
      pocketIsThinWall,
      pocketAlign: alignVisualPerInlay[idx],
      plugIsProblem,
      plugIsThinWall,
      pocketMask,
      plugMask: plugMaskForDfm,
      pocketMP,
      plugMP,
      pocketThinWallMP: pocketAnalysis.thinWallMP,
      plugThinWallMP:   plugAnalysis.thinWallMP,
      pocketAlignMP:    alignVisualPolygons[idx],
    });
  }

  // -----------------------------------------------------------------------
  // Phase 5: Per-preset analysis — feasibility flags, overlays, depth maps.
  //
  // Two modes, switched by `useBinarySearchFeasibility`:
  //
  //   • Linear (expert flow / default): compute `problemStatsForAngle`
  //     for every preset × every wood × pocket/plug, and PNG-encode the
  //     overlay + depth-map at each angle. Step 3's VbitSelector reads
  //     all 6 entries to render thumbnails and instant-swap the picked
  //     angle's overlays — every preset must be populated.
  //
  //   • Binary search (guided flow): design-wide feasibility is
  //     monotonic in v-bit angle (full-depth footprint is
  //     `depth × tan(angle/2)`, ascending), so `feasible` flips at most
  //     once across the preset list. Binary search locates the largest
  //     feasible index in ⌈log₂(6)⌉ = 3 stats passes. Untested presets
  //     are filled in with synthetic feasibility flags + stub
  //     `PerPresetAngleResult` entries.
  //
  // Cache structure: `presetCache` keyed by aIdx, populated lazily by
  // `computeAtPreset`. Both modes feed it; Phase 5.5 reads from it
  // (avoiding redundant `problemStatsForAngle` calls in linear mode too).
  // -----------------------------------------------------------------------
  interface PresetData {
    angleDegrees: number;
    angleVbitWarning: boolean;
    angleFdrPx: number;
    /** Same R in design units (= the unit Clipper offsets work in). */
    angleFdrUnits: number;
    /** Worst per-side problem-area percent across all woods. */
    maxProblem: number;
    /** OR of `hasIsolatedComponent` across all woods × pocket/plug. */
    anyIsolatedComponent: boolean;
    perWood: Array<{
      pocketStats: ReturnType<typeof problemStatsForAngle>;
      plugStats:   ReturnType<typeof problemStatsForAngle>;
      pocketComponents: ReturnType<typeof findMaskComponentCentroids>;
      plugComponents:   ReturnType<typeof findMaskComponentCentroids>;
    }>;
  }
  const presetCache = new Map<number, PresetData>();

  const computeAtPreset = (aIdx: number): PresetData => {
    const cached = presetCache.get(aIdx);
    if (cached) return cached;
    const angleDeg = VBIT_PRESET_ANGLES[aIdx];
    const half = (angleDeg / 2) * (Math.PI / 180);
    const angleFdrPx = inlayDepthInches * Math.tan(half) * pixelsPerInch;
    // Same R, expressed in design units for the polygon path.
    const angleFdrUnits = inlayDepthInches * Math.tan(half) * designUnitsPerInch;
    const angleVbitWarning = grainDirection !== 'end' && angleDeg < MIN_VBIT_ANGLE_SIDE_GRAIN;

    let maxProblem = 0;
    let anyIsolatedComponent = false;
    const perWood: PresetData['perWood'] = [];

    for (let wIdx = 0; wIdx < woods.length; wIdx++) {
      const inp = overlayRebuildInputs[wIdx];
      const pocketStats = polygonProblemStatsBitmap(
        inp.pocketMP, angleFdrUnits, canvasW, canvasH, polygonTransform,
        { plugMode: false, designBounds, returnMask: true },
      );
      // Plug analysis: bit can come in from off-canvas, so the
      // canvas-perimeter band counts as a full-depth seed.
      const plugStats = polygonProblemStatsBitmap(
        inp.plugMP, angleFdrUnits, canvasW, canvasH, polygonTransform,
        { plugMode: true, designBounds, returnMask: true },
      );
      if (pocketStats.percent > maxProblem) maxProblem = pocketStats.percent;
      if (plugStats.percent   > maxProblem) maxProblem = plugStats.percent;
      if (pocketStats.hasIsolatedComponent || plugStats.hasIsolatedComponent) {
        anyIsolatedComponent = true;
      }
      perWood.push({
        pocketStats, plugStats,
        pocketComponents: findMaskComponentCentroids(pocketStats.problemMask!, canvasW, canvasH),
        plugComponents:   findMaskComponentCentroids(plugStats.problemMask!,   canvasW, canvasH),
      });
    }

    const data: PresetData = {
      angleDegrees: angleDeg,
      angleVbitWarning,
      angleFdrPx,
      angleFdrUnits,
      maxProblem,
      anyIsolatedComponent,
      perWood,
    };
    presetCache.set(aIdx, data);
    return data;
  };

  const isFeasibleAt = (aIdx: number): boolean => {
    const r = computeAtPreset(aIdx);
    return r.maxProblem <= FEASIBILITY_PROBLEM_PCT && !r.anyIsolatedComponent;
  };

  let largestFeasibleIdx = -1;

  if (useBinarySearchFeasibility) {
    // Binary search the preset list (ascending angle, descending
    // feasibility) for the largest index where `feasible` holds.
    largestFeasibleIdx = binarySearchLargestFeasibleIdx(
      VBIT_PRESET_ANGLES.length,
      isFeasibleAt,
    );
  } else {
    // Linear: compute every preset, then locate largest feasible.
    for (let aIdx = 0; aIdx < VBIT_PRESET_ANGLES.length; aIdx++) {
      computeAtPreset(aIdx);
    }
    for (let i = VBIT_PRESET_ANGLES.length - 1; i >= 0; i--) {
      if (isFeasibleAt(i)) { largestFeasibleIdx = i; break; }
    }
  }

  // PNG encode batch — independent across (aIdx, wIdx, kind), so fire
  // them in parallel and assemble URLs from the resolved values. Only
  // tested presets contribute; in binary-search mode `produceOverlays`
  // is also `false` so the batch is empty anyway.
  type EncodeKind = 'pocketOverlay' | 'plugOverlay' | 'pocketDepth' | 'plugDepth';
  interface EncodeJob {
    aIdx: number;
    wIdx: number;
    kind: EncodeKind;
    promise: Promise<string>;
  }
  const encodeJobs: EncodeJob[] = [];

  if (produceOverlays) {
    for (const [aIdx, data] of presetCache) {
      for (let wIdx = 0; wIdx < woods.length; wIdx++) {
        const inp = overlayRebuildInputs[wIdx];
        const w = data.perWood[wIdx];
        encodeJobs.push({
          aIdx, wIdx, kind: 'pocketOverlay',
          promise: buildOverlay(inp.pocketBase, canvasW, canvasH,
            w.pocketStats.problemMP ?? [], inp.pocketThinWallMP, polygonTransform, inp.pocketAlignMP),
        });
        encodeJobs.push({
          aIdx, wIdx, kind: 'plugOverlay',
          promise: buildOverlay(inp.plugBase, canvasW, canvasH,
            w.plugStats.problemMP ?? [], inp.plugThinWallMP, polygonTransform),
        });
        encodeJobs.push({
          aIdx, wIdx, kind: 'pocketDepth',
          promise: buildPolygonDepthMap(inp.pocketBase, canvasW, canvasH,
            inp.pocketMP, data.angleFdrUnits, polygonTransform),
        });
        encodeJobs.push({
          aIdx, wIdx, kind: 'plugDepth',
          promise: buildPolygonDepthMap(inp.plugBase, canvasW, canvasH,
            inp.plugMP, data.angleFdrUnits, polygonTransform, plugDepthMapFit),
        });
      }
    }
  }
  const encodeResults = await Promise.all(encodeJobs.map(j => j.promise));
  // Index resolved URLs by (aIdx → per-wood Record<EncodeKind, string>).
  const urlsByAW = new Map<number, Record<EncodeKind, string>[]>();
  for (let i = 0; i < encodeJobs.length; i++) {
    const j = encodeJobs[i];
    let perWoodArr = urlsByAW.get(j.aIdx);
    if (!perWoodArr) {
      perWoodArr = woods.map(() => ({
        pocketOverlay: '', plugOverlay: '', pocketDepth: '', plugDepth: '',
      }));
      urlsByAW.set(j.aIdx, perWoodArr);
    }
    perWoodArr[j.wIdx][j.kind] = encodeResults[i];
  }

  // Synthesize matrix.vbits + perPresetAnalysis for ALL 6 presets.
  // Tested presets: real values from cache. Untested presets (binary-
  // search mode only): monotonic extrapolation. Sentinel stub fields
  // line up with the synthesized `feasible` flag so any future picker
  // logic that descends through `isLayerFeasibleAtVbit` sees a
  // consistent picture.
  const matrixVbits: MachiningTimeMatrix['vbits'] = [];
  const perPresetByWood: PerPresetAngleResult[][] = woods.map(() => []);

  for (let aIdx = 0; aIdx < VBIT_PRESET_ANGLES.length; aIdx++) {
    const angleDeg = VBIT_PRESET_ANGLES[aIdx];
    const angleVbitWarning = grainDirection !== 'end' && angleDeg < MIN_VBIT_ANGLE_SIDE_GRAIN;
    const data = presetCache.get(aIdx);

    if (data) {
      const feasible = data.maxProblem <= FEASIBILITY_PROBLEM_PCT && !data.anyIsolatedComponent;
      matrixVbits.push({
        angleDegrees: angleDeg,
        ...VBIT_RATES[angleDeg],
        feasible,
        maxProblemAreaPercent: data.maxProblem,
        hasIsolatedComponent: data.anyIsolatedComponent,
      });
      const u = urlsByAW.get(aIdx);
      for (let wIdx = 0; wIdx < woods.length; wIdx++) {
        const w = data.perWood[wIdx];
        const woodUrls = u?.[wIdx];
        perPresetByWood[wIdx].push({
          angleDegrees: angleDeg,
          pocket: {
            fullDepthPercent: w.pocketStats.fullDepthPercent,
            problemAreaPercent: w.pocketStats.percent,
            passed: w.pocketStats.passed,
            hasAnyFullDepth: w.pocketStats.hasAnyFullDepth,
            hasIsolatedUnreachableComponent: w.pocketStats.hasIsolatedComponent,
            vbitAngleWarning: angleVbitWarning,
            overlayDataUrl: woodUrls?.pocketOverlay ?? '',
            problemComponents: w.pocketComponents,
            depthMapDataUrl: woodUrls?.pocketDepth ?? '',
          },
          plug: {
            fullDepthPercent: w.plugStats.fullDepthPercent,
            problemAreaPercent: w.plugStats.percent,
            passed: w.plugStats.passed,
            hasAnyFullDepth: w.plugStats.hasAnyFullDepth,
            hasIsolatedUnreachableComponent: w.plugStats.hasIsolatedComponent,
            vbitAngleWarning: angleVbitWarning,
            overlayDataUrl: woodUrls?.plugOverlay ?? '',
            problemComponents: w.plugComponents,
            depthMapDataUrl: woodUrls?.plugDepth ?? '',
          },
        });
      }
    } else {
      // Untested preset (binary-search mode only). Extrapolate from
      // monotonicity: `feasible` iff aIdx ≤ largestFeasibleIdx.
      const feasible = aIdx <= largestFeasibleIdx;
      matrixVbits.push({
        angleDegrees: angleDeg,
        ...VBIT_RATES[angleDeg],
        feasible,
        maxProblemAreaPercent: feasible ? 0 : 100,
        hasIsolatedComponent: !feasible,
      });
      const stubSide: PerPresetSingleSide = {
        fullDepthPercent: feasible ? 100 : 0,
        problemAreaPercent: feasible ? 0 : 100,
        passed: feasible,
        hasAnyFullDepth: feasible,
        hasIsolatedUnreachableComponent: !feasible,
        vbitAngleWarning: angleVbitWarning,
        overlayDataUrl: '',
        problemComponents: [],
        depthMapDataUrl: '',
      };
      for (let wIdx = 0; wIdx < woods.length; wIdx++) {
        perPresetByWood[wIdx].push({ angleDegrees: angleDeg, pocket: stubSide, plug: stubSide });
      }
    }
  }

  for (let wIdx = 0; wIdx < woods.length; wIdx++) {
    woods[wIdx].perPresetAnalysis = perPresetByWood[wIdx];
  }

  const machiningTimeTable = buildMachiningTimeMatrixPolygon({
    layers: matrixLayers,
    designUnitsPerInch,
    inlayDepthInches,
    inlayDepthForVbit: inlayDepthInches,
    plugFit: (settings.plugGlueGapInches > 0 || settings.plugSurfaceGapInches > 0)
      ? {
          glueGapInches: settings.plugGlueGapInches,
          surfaceGapInches: settings.plugSurfaceGapInches,
        }
      : undefined,
    clearanceBits: CLEARANCE_BIT_OPTIONS.map(d => ({ diameterInches: d, mrr: CLEARANCE_BIT_MRR[d] })),
    vbits: matrixVbits,
  });

  // -----------------------------------------------------------------------
  // Phase 5.5: Step 2 (DFM) display data.
  //
  // Step 2 shows the design as if carved with the *largest feasible*
  // preset v-bit angle — i.e., the best the design supports today, with no
  // red errors. Layered on top is a teal "suggestion" overlay marking
  // regions only the *next-wider* preset cannot reach. Widening any of
  // those unlocks a wider, faster bit, which is typically a significant
  // machining-time win.
  //
  // Reads display + suggestion stats from `presetCache` (always
  // populated for `largestFeasibleIdx` after Phase 5; binary-search
  // mode also caches the next-wider preset along the search path,
  // and the no-feasible fallback's preset 0 is on the search path too).
  // The single fallback `computeAtPreset(suggestionIdx)` covers the
  // rare case where the search didn't probe largest+1 directly.
  // -----------------------------------------------------------------------
  let step2DisplayAngleDegrees: number | null = null;
  let step2SuggestionAngleDegrees: number | null = null;

  if (largestFeasibleIdx >= 0) {
    // Feasible case: display at the largest feasible preset; suggestions
    // (teal) at the next wider preset if one exists.
    const displayData = computeAtPreset(largestFeasibleIdx);
    step2DisplayAngleDegrees = displayData.angleDegrees;

    const suggestionIdx = largestFeasibleIdx + 1;
    const hasSuggestion = suggestionIdx < VBIT_PRESET_ANGLES.length;
    let suggestionData: PresetData | undefined;
    if (hasSuggestion) {
      suggestionData = computeAtPreset(suggestionIdx);
      step2SuggestionAngleDegrees = suggestionData.angleDegrees;
    }

    for (let i = 0; i < woods.length; i++) {
      const inp = overlayRebuildInputs[i];
      const dw = displayData.perWood[i];
      const pocketDisplayProblemMP = dw.pocketStats.problemMP ?? [];
      const plugDisplayProblemMP   = dw.plugStats.problemMP ?? [];

      let pocketSuggestionMP: MultiPolygon = [];
      let plugSuggestionMP: MultiPolygon = [];
      if (suggestionData) {
        const sw = suggestionData.perWood[i];
        // Suggestion = (next-wider preset's problem) − (display preset's problem) =
        // regions that ONLY the next-wider preset can't reach. Polygon
        // difference replaces the bitmap per-pixel diff above.
        pocketSuggestionMP = multiPolygonDifference(sw.pocketStats.problemMP ?? [], pocketDisplayProblemMP);
        plugSuggestionMP   = multiPolygonDifference(sw.plugStats.problemMP   ?? [], plugDisplayProblemMP);

        // Rasterized version still needed for the guided UI (= React
        // overlay reads the Uint8Array directly).
        const pocketSuggestion = rasterizeMultiPolygonToMask(pocketSuggestionMP, canvasW, canvasH, polygonTransform);
        const plugSuggestion   = rasterizeMultiPolygonToMask(plugSuggestionMP,   canvasW, canvasH, polygonTransform);
        woods[i].widerBitInfeasibleMask = {
          angleDegrees: step2SuggestionAngleDegrees!,
          pocket: pocketSuggestion,
          plug:   plugSuggestion,
        };
      }

      // Skip the suggestion-overlay PNG encode in `produceOverlays:
      // false` mode (guided flow). The masks above are still
      // populated; the guided UI renders its own overlays from them.
      if (produceOverlays) {
        woods[i].pocket.suggestionOverlayDataUrl = await buildOverlay(
          inp.pocketBase, canvasW, canvasH,
          pocketDisplayProblemMP, inp.pocketThinWallMP, polygonTransform,
          inp.pocketAlignMP, pocketSuggestionMP,
        );
        woods[i].plug.suggestionOverlayDataUrl = await buildOverlay(
          inp.plugBase, canvasW, canvasH,
          plugDisplayProblemMP, inp.plugThinWallMP, polygonTransform,
          undefined, plugSuggestionMP,
        );
      }
    }
  } else {
    // No feasible preset — even the sharpest v-bit fails. Display at the
    // smallest preset (15°) with its problem mask in RED. These are
    // irreducible regions: no preset can carve them. The artist needs to
    // widen or remove these features for the design to be manufacturable.
    const fallbackData = computeAtPreset(0);

    for (let i = 0; i < woods.length; i++) {
      const inp = overlayRebuildInputs[i];
      const fw = fallbackData.perWood[i];
      const pocketProblem   = fw.pocketStats.problemMask!;
      const plugProblem     = fw.plugStats.problemMask!;
      const pocketProblemMP = fw.pocketStats.problemMP ?? [];
      const plugProblemMP   = fw.plugStats.problemMP ?? [];
      if (produceOverlays) {
        woods[i].pocket.suggestionOverlayDataUrl = await buildOverlay(
          inp.pocketBase, canvasW, canvasH,
          pocketProblemMP, inp.pocketThinWallMP, polygonTransform,
          inp.pocketAlignMP,
          undefined, // no teal suggestion — there's no upgrade path
        );
        woods[i].plug.suggestionOverlayDataUrl = await buildOverlay(
          inp.plugBase, canvasW, canvasH,
          plugProblemMP, inp.plugThinWallMP, polygonTransform,
          undefined,
          undefined,
        );
      }
      // Stash the smallest-preset problem masks so the guided flow can
      // render them in red (over the board composite) and place locator
      // badges on each connected component. Computed regardless of
      // `produceOverlays` since the guided flow consumes these masks
      // in the React layer to render its own overlays.
      woods[i].irreducibleProblemMask = {
        pocket: pocketProblem,
        plug:   plugProblem,
      };
    }
  }

  return {
    woods,
    vbitCutWidthInches,
    fullDepthRadiusInches,
    thinWallThresholdInches: THIN_WALL_THRESHOLD_INCHES,
    alignmentThresholdInches: ALIGNMENT_THRESHOLD_INCHES,
    pixelsPerInch,
    canvasW,
    canvasH,
    step2DisplayAngleDegrees,
    step2SuggestionAngleDegrees,
    totalMachineTimeMinutes: anyMachineTimeMissing || !haveMachiningRates ? NaN : totalMachineTime,
    clearanceBitDiameterInches: settings.clearanceBitDiameterInches,
    clearanceMRR,
    vbitMRR:  vbitRates?.mrr  ?? NaN,
    vbitFeed: vbitRates?.feed ?? NaN,
    machiningTimeTable,
  };
}

async function canvasToDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// LITE analysis path
//
// The guided optimizer needs only `fillableHoleCount` and
// `alignmentIssues` per layer to enumerate fill / extend targets.
// Running the full `runDfmAnalysis` (per-preset overlays + machining
// matrix + depth maps + suggestion overlays) just to read those two
// fields is wasteful — those alone account for ~36 PNG encodes per
// design.
//
// `runDfmAnalysisLite` mirrors Phase 0/1/2 of the full pipeline plus a
// minimal fillable-hole enumeration, and stops there. It returns the
// per-layer pocket masks too so the optimizer can re-rasterize ONLY
// the layers `applyFillAll` modified, then call `redetectAlignmentRisks`
// on the patched mask set without re-rasterizing the entire design.
// ---------------------------------------------------------------------------

export interface LiteWoodAnalysis {
  colorHex: string;
  alignmentIssues: AlignmentIssue[];
  fillableHoleCount: number;
}

export interface LiteAnalysisResult {
  woods: LiteWoodAnalysis[];
  /** Per-color rasterized pocket masks at the lite canvas resolution.
   *  Reused by the optimizer for the post-fill alignment redetect. */
  pocketMasks: Map<string, Uint8Array>;
  canvasW: number;
  canvasH: number;
  pixelsPerInch: number;
  alignThresholdPx: number;
}

/**
 * Rasterize one layer's standalone SVG to a pocket mask at the given
 * canvas dimensions. Returns an empty mask if the layer isn't found
 * in `vector.layers`. Thin wrapper over the shared
 * `rasterizeLayerToBinaryMask` helper (transparent canvas + alpha
 * threshold) so adjacent layers' masks overlap consistently at
 * shared boundaries.
 */
export async function rasterizeLayerMask(
  vector: VectorData,
  colorHex: string,
  canvasW: number,
  canvasH: number,
): Promise<Uint8Array> {
  const layer = vector.layers.find(l => l.colorHex === colorHex);
  if (!layer) return new Uint8Array(canvasW * canvasH);
  return rasterizeLayerToBinaryMask(
    layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight,
    canvasW, canvasH,
  );
}

/**
 * Re-run pairwise alignment-risk detection from a pre-rasterized mask
 * set. Pure function — no SVG rendering, no canvas allocation. Used
 * after fill modifies a layer to figure out which alignment issues
 * the modification eliminated, so extend doesn't fire on already-
 * resolved cases.
 *
 * Returns a map keyed by colorHex, whose value is the list of
 * alignment issues with later layers. Mirrors the orchestration in
 * Phase 2 of `runDfmAnalysis` but skips the dilation / clipping that
 * Phase 2 does for visual rendering (we don't render here).
 */
export function redetectAlignmentRisks(
  pocketMasksByColor: Map<string, Uint8Array>,
  colorOrder: readonly string[],
  canvasW: number,
  canvasH: number,
  alignThresholdPx: number,
): Map<string, AlignmentIssue[]> {
  const out = new Map<string, AlignmentIssue[]>();
  for (const c of colorOrder) out.set(c, []);
  for (let i = 0; i < colorOrder.length; i++) {
    const a = pocketMasksByColor.get(colorOrder[i]);
    if (!a) continue;
    for (let j = i + 1; j < colorOrder.length; j++) {
      const b = pocketMasksByColor.get(colorOrder[j]);
      if (!b) continue;
      const { affectedCount, totalBoundaryCount } = detectAlignmentRisk(
        a, b, canvasW, canvasH, alignThresholdPx,
      );
      if (affectedCount > 0) {
        out.get(colorOrder[i])!.push({
          otherColorHex: colorOrder[j],
          affectedPercent: totalBoundaryCount > 0 ? (affectedCount / totalBoundaryCount) * 100 : 0,
        });
      }
    }
  }
  return out;
}

/**
 * Lightweight first pass of the guided pipeline. Identifies fill
 * targets (enclosed holes covered by later layers) and alignment
 * targets (boundary-to-boundary proximity to other layers) at lower
 * resolution than the final analysis. Skips per-preset analysis,
 * overlay PNGs, depth maps, and the machining matrix — those run
 * once at full resolution after fill + extend have committed.
 */
export async function runDfmAnalysisLite(
  vector: VectorData,
  settings: DFMSettings,
  colorOrder: readonly string[],
  canvasWidth: number,
): Promise<LiteAnalysisResult> {
  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = canvasWidth;
  const canvasH = Math.max(1, Math.round(canvasWidth * aspect));
  const pixelsPerInch = canvasW / settings.designWidthInches;
  const alignThresholdPx = ALIGNMENT_THRESHOLD_INCHES * pixelsPerInch;
  const n = canvasW * canvasH;

  // Phase 1: per-layer rasterization, mirroring runDfmAnalysis Phase 1.
  // Each layer renders independently so we capture extended-for-
  // registration regions even when later layers cover them.
  const pocketMasks = new Map<string, Uint8Array>();
  for (const colorHex of colorOrder) {
    pocketMasks.set(colorHex, await rasterizeLayerMask(vector, colorHex, canvasW, canvasH));
  }

  // Phase 2: alignment-risk detection (no dilation — we don't render).
  const issuesByColor = redetectAlignmentRisks(
    pocketMasks, colorOrder, canvasW, canvasH, alignThresholdPx,
  );

  // Fillable-hole enumeration: same predicate as Phase 4 of the full
  // pipeline — a hole counts when every pixel of it is covered by the
  // union of later layers, since filling it then changes nothing
  // visible but saves V-bit perimeter time.
  const orderedMasks = colorOrder.map(c => pocketMasks.get(c) ?? new Uint8Array(n));
  const laterUnions: Uint8Array[] = colorOrder.map(() => new Uint8Array(n));
  for (let i = colorOrder.length - 2; i >= 0; i--) {
    const next = orderedMasks[i + 1];
    const acc = laterUnions[i];
    const accNext = laterUnions[i + 1];
    for (let k = 0; k < n; k++) if (next[k] || accNext[k]) acc[k] = 1;
  }

  const woods: LiteWoodAnalysis[] = colorOrder.map((colorHex, idx) => {
    const mask = orderedMasks[idx];
    let fillableHoleCount = 0;
    if (idx < colorOrder.length - 1) {
      const holes = findEnclosedHoles(mask, canvasW, canvasH);
      const laterUnion = laterUnions[idx];
      // Mirror `fillEnclosedHoles`'s 99.5% coverage threshold so the
      // optimizer's `holeFillTargets` includes layers whose holes
      // are mostly-covered (sub-pixel stragglers tolerated). A
      // strict all-or-nothing here would flag layer 0 as having
      // zero fillable holes and skip running `fillEnclosedHoles`
      // on it entirely, even when 99.9%+ of every hole is covered.
      for (const hole of holes) {
        let coveredPx = 0;
        for (const k of hole.pixels) {
          if (laterUnion[k]) coveredPx++;
        }
        if (coveredPx / hole.pixels.length >= 0.995) fillableHoleCount++;
      }
    }
    return {
      colorHex,
      alignmentIssues: issuesByColor.get(colorHex) ?? [],
      fillableHoleCount,
    };
  });

  return {
    woods,
    pocketMasks,
    canvasW,
    canvasH,
    pixelsPerInch,
    alignThresholdPx,
  };
}
