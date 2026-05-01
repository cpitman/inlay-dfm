import type { DFMSettings, GrainDirection, VectorData, AnalysisResult, SingleAnalysis, WoodAnalysis, AlignmentIssue } from '@/types';
import { distanceTransform } from './distanceTransform';
import { layerToStandaloneSvg } from './svgLayers';
import { detectAlignmentRisk } from './alignmentRisk';
import { CLEARANCE_BIT_MRR, CLEARANCE_BIT_OPTIONS, getVbitRates, VBIT_PRESET_ANGLES, VBIT_RATES } from './machiningRates';
import { buildMachiningTimeMatrix, machiningTimeForMask } from './machiningTime';
import { computePlugCarvedMask, computePlugStockMask } from './plugStock';
import { computeBoundary, findEnclosedHoles } from './morphology';
import { maskToSvgPath } from './maskToPath';
import { parseViewBox } from './svgLayers';

const DEFAULT_CANVAS_WIDTH = 1200;
const THIN_WALL_THRESHOLD_INCHES = 0.05;
const MIN_THIN_WALL_AREA_SQ_IN = 0.25;
const MIN_VBIT_ANGLE_SIDE_GRAIN = 60;
const ALIGNMENT_THRESHOLD_INCHES = 0.01;
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
function problemStatsForAngle(
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
  canvasW: number,
  canvasH: number,
): { percent: number; hasIsolatedComponent: boolean } {
  const n = canvasW * canvasH;
  const isFullDepth = new Uint8Array(n);
  let carvedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!carvedMask[i]) continue;
    carvedCount++;
    if (dist1[i] >= fullDepthRadiusPx) isFullDepth[i] = 1;
  }
  if (carvedCount === 0) return { percent: 0, hasIsolatedComponent: false };

  const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, canvasW, canvasH);
  let problemCount = 0;
  for (let i = 0; i < n; i++) {
    if (carvedMask[i] && !isFullDepth[i] && !reachable[i]) problemCount++;
  }

  const hasIsolatedComponent = carvedHasComponentWithoutFullDepth(
    carvedMask, dist1, fullDepthRadiusPx, canvasW, canvasH,
  );

  return { percent: (problemCount / carvedCount) * 100, hasIsolatedComponent };
}

/** Problem-area cutoff above which a V-bit angle is considered infeasible for the design. */
const FEASIBILITY_PROBLEM_PCT = 10;

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
      if (!hasFullDepth && dist1[k] >= fullDepthRadiusPx) hasFullDepth = true;
      const x = k % canvasW;
      const y = (k - x) / canvasW;
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
    carvedMask, dist1, fullDepthRadiusPx, canvasW, canvasH,
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

async function buildOverlay(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  isProblem: Uint8Array,
  isThinWall: Uint8Array,
  isAlignment?: Uint8Array,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, canvasW, canvasH);
  const d = img.data;
  for (let i = 0, n = canvasW * canvasH; i < n; i++) {
    if (isProblem[i]) {
      d[i*4]=220; d[i*4+1]=50;  d[i*4+2]=50;  d[i*4+3]=210;
    } else if (isThinWall[i]) {
      d[i*4]=220; d[i*4+1]=150; d[i*4+2]=30;  d[i*4+3]=210;
    } else if (isAlignment?.[i]) {
      d[i*4]=210; d[i*4+1]=50;  d[i*4+2]=210; d[i*4+3]=210;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasToDataUrl(oc);
}

async function buildDepthMap(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, canvasW, canvasH);
  const d = img.data;
  for (let i = 0, n = canvasW * canvasH; i < n; i++) {
    if (!carvedMask[i]) continue;
    const ratio = Math.min(1, dist1[i] / fullDepthRadiusPx);
    // Red (shallow) → green (full depth)
    d[i*4]   = Math.round(220 - 180 * ratio);
    d[i*4+1] = Math.round(40  + 160 * ratio);
    d[i*4+2] = 30;
    d[i*4+3] = 220;
  }
  ctx.putImageData(img, 0, 0);
  return canvasToDataUrl(oc);
}

// ---------------------------------------------------------------------------
// Public entry point
// colorOrder controls which inlay is "earlier" for alignment detection.
// Defaults to vector.detectedColors order; pass woodConfigs order to reflect
// user reordering.
// ---------------------------------------------------------------------------
export async function runDfmAnalysis(
  vector: VectorData,
  settings: DFMSettings,
  colorOrder?: string[],
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
): Promise<AnalysisResult> {
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

  // Per-layer base canvases — each shows only that layer's geometry. Used as the
  // visual backdrop for each wood's overlay/depth-map so the WoodSection canvas
  // displays only that single inlay rather than the full mixed design.
  const perLayerBases = new Map<string, OffscreenCanvas>();
  for (const layer of vector.layers) {
    const layerSvg = layerToStandaloneSvg(layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight);
    perLayerBases.set(layer.colorHex, await renderSvgToCanvas(layerSvg, canvasW, canvasH));
  }

  const args = [canvasW, canvasH, pixelsPerInch, fullDepthRadiusPx, thinWallThresholdPx, grainDirection, vbitAngleDegrees] as const;

  const toSingle = async (
    mask: Uint8Array,
    maskData: ReturnType<typeof analyzeMask>,
    layerBase: OffscreenCanvas,
    alignPixels?: Uint8Array,
  ): Promise<SingleAnalysis> => ({
    fullDepthPercent:   maskData.fullDepthPercent,
    problemAreaPercent: maskData.problemAreaPercent,
    passed:             maskData.passed,
    hasAnyFullDepth:    maskData.hasAnyFullDepth,
    hasIsolatedUnreachableComponent: maskData.hasIsolatedUnreachableComponent,
    vbitAngleWarning:   maskData.vbitAngleWarning,
    thinWallPixelCount: maskData.thinWallPixelCount,
    overlayDataUrl:  await buildOverlay(layerBase, canvasW, canvasH, maskData.isProblem, maskData.isThinWall, alignPixels),
    depthMapDataUrl: await buildDepthMap(layerBase, canvasW, canvasH, mask, maskData.dist1, fullDepthRadiusPx),
  });

  // -----------------------------------------------------------------------
  // Phase 1: Build all pocket masks via per-layer rasterization.
  //
  // We deliberately do NOT use color-matching from the combined render here.
  // Color-matching gives the *visible* extent of each layer (what survives
  // SVG z-order), but for DFM and especially staged-alignment risk detection
  // we need each layer's *physical* extent — including any portion that the
  // extend-for-registration algorithm has placed under a later layer.
  //
  // Brightness threshold (< 220 luma) over the per-layer canvas captures the
  // colored region; antialiased edge pixels at adjacent boundaries can fall
  // into both layers' masks by ~1 px, which is harmless because the boundary
  // detector picks them up on both sides equally.
  // -----------------------------------------------------------------------
  const pocketMasks: Uint8Array[] = orderedColors.map(colorHex => {
    const layerCanvas = perLayerBases.get(colorHex);
    if (!layerCanvas) return new Uint8Array(n);
    const lctx = layerCanvas.getContext('2d')!;
    const layerData = lctx.getImageData(0, 0, canvasW, canvasH).data;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = layerData[i * 4], g = layerData[i * 4 + 1], b = layerData[i * 4 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < 220) mask[i] = 1;
    }
    return mask;
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
  const alignVisualPx = Math.max(5, alignThresholdPx * 3);

  const alignPixelsPerInlay: Uint8Array[] = orderedColors.map(() => new Uint8Array(n));
  const alignIssues: AlignmentIssue[][] = orderedColors.map(() => []);

  for (let i = 0; i < orderedColors.length; i++) {
    for (let j = i + 1; j < orderedColors.length; j++) {
      const { riskMask, affectedCount, totalBoundaryCount } = detectAlignmentRisk(
        pocketMasks[i], pocketMasks[j],
        canvasW, canvasH, alignThresholdPx,
      );

      if (affectedCount > 0) {
        for (let k = 0; k < n; k++) if (riskMask[k]) alignPixelsPerInlay[i][k] = 1;
        alignIssues[i].push({
          otherColorHex: orderedColors[j],
          affectedPercent: totalBoundaryCount > 0 ? (affectedCount / totalBoundaryCount) * 100 : 0,
        });
      }
    }
  }

  // Dilate alignment pixels within the inlay mask for visual clarity.
  const alignVisualPerInlay: Uint8Array[] = alignPixelsPerInlay.map((raw, i) => {
    if (!raw.some(v => v)) return raw; // no issues → skip
    const seeds = new Uint8Array(n);
    for (let k = 0; k < n; k++) seeds[k] = raw[k] ? 0 : 1;
    const distToRaw = distanceTransform(seeds, canvasW, canvasH);
    const dilated = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (pocketMasks[i][k] && distToRaw[k] < alignVisualPx) dilated[k] = 1;
    }
    return dilated;
  });

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

  // For each layer i, the union of pocket masks for all layers j > i. Used
  // to detect "fillable" holes — holes in layer i fully covered by some
  // combination of later layers (so filling them in i changes nothing
  // visible in the final design but saves V-bit perimeter time).
  // Computed once by sweeping from highest index down.
  const laterUnions: Uint8Array[] = orderedColors.map(() => new Uint8Array(n));
  for (let i = orderedColors.length - 2; i >= 0; i--) {
    const next = pocketMasks[i + 1];
    const acc = laterUnions[i];
    const accNext = laterUnions[i + 1];
    for (let k = 0; k < n; k++) {
      if (next[k] || accNext[k]) acc[k] = 1;
    }
  }

  const woods: WoodAnalysis[] = [];
  // Per-layer data the (clearance × V-bit) matrix builder needs: pocket
  // mask + EDT, plug carved mask + EDT, plus the pocket's perimeter (used
  // as the V-bit perimeter pass length for both pocket and plug since the
  // V-bit only traces the plug *shape* boundary, not the outer stock edge).
  const matrixLayers: {
    pocketMask: Uint8Array;
    pocketDist1: Float32Array;
    plugCarvedMask: Uint8Array;
    plugDist1: Float32Array;
    pocketPerimeterIn: number;
  }[] = [];
  // Pocket+plug masks and their dist1's, kept for the per-V-bit feasibility check.
  const layerSidesForFeasibility: { mask: Uint8Array; dist1: Float32Array }[] = [];
  let totalMachineTime = 0;
  let anyMachineTimeMissing = false;

  for (let idx = 0; idx < orderedColors.length; idx++) {
    const colorHex = orderedColors[idx];
    const pocketMask = pocketMasks[idx];

    // Existing plug mask used for the DFM (depth/thin-wall) analysis: this
    // is the *base-board* side, the complement of the inlay color.
    const plugMaskForDfm = new Uint8Array(n);
    for (let i = 0; i < n; i++) plugMaskForDfm[i] = pocketMask[i] ? 0 : 1;

    const pocketAnalysis = analyzeMask(pocketMask,        ...args);
    const plugAnalysis   = analyzeMask(plugMaskForDfm,    ...args);

    // Plug stock for *machining-time* purposes: convex hull of the plug
    // shape dilated by the user's margin. The carved area is stock − plug.
    const plugStockMask = computePlugStockMask(pocketMask, plugMarginPx, canvasW, canvasH);
    const plugCarvedMask = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (plugStockMask[k] && !pocketMask[k]) plugCarvedMask[k] = 1;
    }
    const plugCarvedDist1 = distanceTransform(plugCarvedMask, canvasW, canvasH);

    // Stock outline path (for the plug-side display), traced from the stock
    // mask via marching squares + Douglas-Peucker. Stored as a fully-formed
    // <path> SVG fragment ready to drop into the per-layer SVG. Stroke and
    // dash-array are sized as fractions of viewBox width so the outline is
    // visually similar across designs of different scales.
    const strokeW = Math.max(0.5, vector.naturalWidth * 0.003);
    const dashOn  = Math.max(2,   vector.naturalWidth * 0.012);
    const dashOff = Math.max(1.5, vector.naturalWidth * 0.008);
    const plugStockOutlineSvg = maskToSvgPath(plugStockMask, canvasW, canvasH, {
      fill: 'none',
      scaleX: vector.naturalWidth  / canvasW,
      scaleY: vector.naturalHeight / canvasH,
      offsetX: vb.x,
      offsetY: vb.y,
      simplifyEpsilonPx: 1,
      minAreaPx: 4,
      extraAttrs: `stroke="rgb(255,140,0)" stroke-width="${strokeW.toFixed(3)}" stroke-dasharray="${dashOn.toFixed(3)},${dashOff.toFixed(3)}"`,
    });

    // Compute pocket perimeter once (it doesn't depend on bit rates) so
    // the matrix builder can reuse it for cells using preset V-bit rates
    // even when the user's current settings have no V-bit rates set.
    const pocketBoundary = computeBoundary(pocketMask, canvasW, canvasH);
    let pocketBoundaryPx = 0;
    for (let k = 0; k < n; k++) if (pocketBoundary[k]) pocketBoundaryPx++;
    const pocketPerimeterIn = pocketBoundaryPx / pixelsPerInch;

    layerSidesForFeasibility.push({ mask: pocketMask,     dist1: pocketAnalysis.dist1 });
    layerSidesForFeasibility.push({ mask: plugMaskForDfm, dist1: plugAnalysis.dist1   });

    // Machining time — pocket and plug are computed independently on their
    // own carved masks. Both perimeter passes use the pocket's perimeter
    // (the plug's V-bit pass traces the plug's *shape* boundary, not the
    // outer stock edge).
    let pocketMachineTimeMinutes = NaN, plugMachineTimeMinutes = NaN, layerMachineTimeMinutes = NaN;
    let clearanceAreaSqIn = 0, vbitAreaSqIn = 0;
    let plugClearanceAreaSqIn = 0, plugVbitAreaSqIn = 0;

    if (haveMachiningRates && vbitRates) {
      const tPocket = machiningTimeForMask(
        pocketMask, pocketAnalysis.dist1,
        canvasW, canvasH, pixelsPerInch,
        inlayDepthInches,
        settings.clearanceBitDiameterInches,
        clearanceMRR,
        vbitRates.mrr,
        vbitRates.feed,
        pocketPerimeterIn,
      );
      const tPlug = machiningTimeForMask(
        plugCarvedMask, plugCarvedDist1,
        canvasW, canvasH, pixelsPerInch,
        inlayDepthInches,
        settings.clearanceBitDiameterInches,
        clearanceMRR,
        vbitRates.mrr,
        vbitRates.feed,
        pocketPerimeterIn,
      );
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
      pocketMask,
      pocketDist1: pocketAnalysis.dist1,
      plugCarvedMask,
      plugDist1: plugCarvedDist1,
      pocketPerimeterIn,
    });

    // Fillable enclosed holes — holes in this layer's pocket that are fully
    // covered by the union of later inlay layers. Filling them saves V-bit
    // perimeter time on both pocket and plug; net-zero clearance change
    // (pocket gains the area, plug loses it equivalently).
    let fillableHoleCount = 0;
    let fillableHolePixelCount = 0;
    let fillableHolePerimeterPx = 0;
    if (idx < orderedColors.length - 1) {
      const holes = findEnclosedHoles(pocketMask, canvasW, canvasH);
      const laterUnion = laterUnions[idx];
      for (const hole of holes) {
        let covered = true;
        for (const k of hole.pixels) {
          if (!laterUnion[k]) { covered = false; break; }
        }
        if (!covered) continue;
        // Build a mask for this hole and count its boundary pixels.
        const holeMask = new Uint8Array(n);
        for (const k of hole.pixels) holeMask[k] = 1;
        const holeBoundary = computeBoundary(holeMask, canvasW, canvasH);
        let perimPx = 0;
        for (let k = 0; k < n; k++) if (holeBoundary[k]) perimPx++;
        fillableHoleCount++;
        fillableHolePixelCount += hole.pixels.length;
        fillableHolePerimeterPx += perimPx;
      }
    }
    const fillableHoleAreaSqIn = fillableHolePixelCount / (pixelsPerInch * pixelsPerInch);
    const fillableHolePerimeterIn = fillableHolePerimeterPx / pixelsPerInch;
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
    woods.push({
      colorHex,
      pocket: await toSingle(pocketMask, pocketAnalysis, pocketBase, alignVisualPerInlay[idx]),
      plug:   await toSingle(plugMaskForDfm, plugAnalysis, plugBase),
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
      pocketMachineTimeMinutes,
      plugMachineTimeMinutes,
      layerMachineTimeMinutes,
    });
  }

  // -----------------------------------------------------------------------
  // Phase 5: Per-angle feasibility check, then comparison matrix.
  //
  // For every preset V-bit angle, compute the maximum problem-area % across
  // all (layer × side) pairs reusing each side's dist1 EDT (so the only
  // extra cost is one EDT2 + thresholding pass per angle per side). A V-bit
  // angle is "feasible" only when every pocket and plug stays under
  // FEASIBILITY_PROBLEM_PCT — otherwise the whole column in the matrix is
  // marked N/A.
  // -----------------------------------------------------------------------
  const matrixVbits = VBIT_PRESET_ANGLES.map(angleDeg => {
    const half = (angleDeg / 2) * (Math.PI / 180);
    const fdrInches = inlayDepthInches * Math.tan(half);
    const angleFdrPx = fdrInches * pixelsPerInch;

    let maxProblem = 0;
    let anyIsolatedComponent = false;
    for (const side of layerSidesForFeasibility) {
      const stats = problemStatsForAngle(
        side.mask, side.dist1, angleFdrPx, canvasW, canvasH,
      );
      if (stats.percent > maxProblem) maxProblem = stats.percent;
      if (stats.hasIsolatedComponent) anyIsolatedComponent = true;
      // Two disqualifying conditions; once either is breached we can stop
      // checking further sides.
      if (maxProblem > FEASIBILITY_PROBLEM_PCT && anyIsolatedComponent) break;
    }
    return {
      angleDegrees: angleDeg,
      ...VBIT_RATES[angleDeg],
      feasible: maxProblem <= FEASIBILITY_PROBLEM_PCT && !anyIsolatedComponent,
    };
  });

  const machiningTimeTable = buildMachiningTimeMatrix({
    layers: matrixLayers,
    canvasW, canvasH, pixelsPerInch,
    inlayDepthInches,
    clearanceBits: CLEARANCE_BIT_OPTIONS.map(d => ({ diameterInches: d, mrr: CLEARANCE_BIT_MRR[d] })),
    vbits: matrixVbits,
  });

  return {
    woods,
    vbitCutWidthInches,
    fullDepthRadiusInches,
    thinWallThresholdInches: THIN_WALL_THRESHOLD_INCHES,
    alignmentThresholdInches: ALIGNMENT_THRESHOLD_INCHES,
    pixelsPerInch,
    totalMachineTimeMinutes: anyMachineTimeMissing || !haveMachiningRates ? NaN : totalMachineTime,
    clearanceBitDiameterInches: settings.clearanceBitDiameterInches,
    clearanceMRR,
    vbitMRR:  vbitRates?.mrr  ?? NaN,
    vbitFeed: vbitRates?.feed ?? NaN,
    machiningTimeTable,
  };
}

async function renderSvgToCanvas(
  svgString: string,
  canvasW: number,
  canvasH: number,
): Promise<OffscreenCanvas> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasW, canvasH);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvasW, canvasH); resolve(); };
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return oc;
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
