import { distanceTransform } from './distanceTransform';
import { computeBoundary } from './morphology';

export interface RiskDetectionResult {
  /** Boundary pixels of layer i where the layer-j boundary is within `alignThresholdPx`. */
  riskMask: Uint8Array;
  /** Number of i-boundary pixels flagged. */
  affectedCount: number;
  /** Total i-boundary pixels (denominator for the affected-perimeter percentage). */
  totalBoundaryCount: number;
}

/**
 * Cosine of the maximum allowed angle between layer-i and layer-j edge
 * tangents at a flagged pixel. Edges within 15° of parallel count as
 * "running together" — the registration-risk physics applies. Edges
 * 15° or more off parallel (cross-style intersections) get suppressed:
 * a registration shift along either axis can't expose a seam when the
 * boundaries aren't close to parallel.
 *
 * `Math.cos(15°)` ≈ 0.966. The check uses `|dot|` so sign of either
 * tangent is irrelevant (edges have no intrinsic direction).
 */
const PARALLEL_DOT_THRESHOLD = Math.cos((15 * Math.PI) / 180);

/**
 * PCA tangent direction at every boundary pixel of `mask`. Output is a
 * `Float32Array` of length `2 * w * h` storing `(dx, dy)` per pixel
 * — magnitude 1 at boundary pixels, both components 0 at non-boundary
 * pixels (which the caller should never read).
 *
 * Method: at each boundary pixel, collect the boundary pixels in a
 * 5×5 neighborhood (radius 2), compute the 2×2 covariance matrix of
 * their (x, y) positions relative to the local mean, and return the
 * eigenvector with the larger eigenvalue. Sign of the eigenvector is
 * arbitrary; the caller must use `|dot|` for parallel comparison.
 *
 * Edge cases (canvas-edge pixels with truncated neighborhoods,
 * single-pixel boundary fragments) fall through to a default tangent
 * of `(1, 0)` — those pixels rarely have nearby B-boundary matches
 * anyway, so the default doesn't change verdicts in practice.
 */
function computeBoundaryTangents(
  boundary: Uint8Array,
  w: number,
  h: number,
): Float32Array {
  const RADIUS = 2;
  const out = new Float32Array(2 * w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!boundary[k]) continue;

      const x0 = Math.max(0, x - RADIUS);
      const x1 = Math.min(w - 1, x + RADIUS);
      const y0 = Math.max(0, y - RADIUS);
      const y1 = Math.min(h - 1, y + RADIUS);

      let count = 0, sumX = 0, sumY = 0;
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          if (boundary[ny * w + nx]) {
            count++;
            sumX += nx;
            sumY += ny;
          }
        }
      }
      if (count < 2) {
        out[2 * k] = 1; out[2 * k + 1] = 0;
        continue;
      }
      const meanX = sumX / count;
      const meanY = sumY / count;

      let cxx = 0, cxy = 0, cyy = 0;
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          if (!boundary[ny * w + nx]) continue;
          const dx = nx - meanX;
          const dy = ny - meanY;
          cxx += dx * dx;
          cxy += dx * dy;
          cyy += dy * dy;
        }
      }

      // Larger eigenvalue of [[cxx, cxy], [cxy, cyy]].
      const trace = cxx + cyy;
      const det   = cxx * cyy - cxy * cxy;
      const disc  = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
      const lambda = trace / 2 + disc;

      // Eigenvector. With cxy ≠ 0, eigvec ∝ (lambda − cyy, cxy). When
      // the matrix is diagonal, the eigenvectors are (1, 0) and (0, 1)
      // and we pick the one matching the larger variance.
      let tx: number, ty: number;
      if (Math.abs(cxy) > 1e-9) {
        tx = lambda - cyy;
        ty = cxy;
      } else if (cxx >= cyy) {
        tx = 1; ty = 0;
      } else {
        tx = 0; ty = 1;
      }
      const norm = Math.hypot(tx, ty);
      if (norm > 0) {
        out[2 * k] = tx / norm;
        out[2 * k + 1] = ty / norm;
      } else {
        out[2 * k] = 1; out[2 * k + 1] = 0;
      }
    }
  }
  return out;
}

/**
 * Detect staged-alignment risk on layer i with respect to layer j.
 *
 * Risk criterion: a layer-i boundary pixel is at risk if some pixel of
 * layer j's boundary lies within `alignThresholdPx`. This captures the
 * cases where small registration errors during sequential CNC inlay
 * placement would produce a visible gap or misalignment at the seam:
 *
 *   - Direct adjacency (boundaries identical): registration error opens a
 *     visible base-board gap at the seam, regardless of which side it shifts
 *   - Thin background gap between i and j (< threshold): same registration
 *     error exposes the gap or pushes one inlay across it
 *   - Boundaries in close proximity for any reason
 *
 * And correctly DOES NOT flag:
 *   - Wide overlap (j extends well past i, or i past j): boundaries are far
 *     apart, registration error is absorbed within the overlap margin
 *   - Wide background gap (> threshold): no seam to misalign
 *
 * The masks must be PHYSICAL extents (per-layer rasterization), not
 * color-matched extents from a z-ordered combined render — color matching
 * loses the part of the lower layer that sits under the upper layer, which
 * is exactly the situation produced by the extend-for-registration algorithm.
 */
export function detectAlignmentRisk(
  layerIMask: Uint8Array,
  layerJMask: Uint8Array,
  canvasW: number,
  canvasH: number,
  alignThresholdPx: number,
): RiskDetectionResult {
  const n = canvasW * canvasH;

  const boundaryI = computeBoundary(layerIMask, canvasW, canvasH);
  const boundaryJ = computeBoundary(layerJMask, canvasW, canvasH);

  // distToJBoundary[k] = distance from k to the nearest layer-j boundary pixel.
  // Used as a cheap O(n) gate: A-boundary pixels with no B-boundary anywhere
  // nearby skip the more expensive parallel-tangent check below.
  const seedsJB = new Uint8Array(n);
  for (let k = 0; k < n; k++) seedsJB[k] = boundaryJ[k] ? 0 : 1;
  const distToJBoundary = distanceTransform(seedsJB, canvasW, canvasH);

  // Per-boundary-pixel tangent directions for the parallel-edge check.
  const tangentI = computeBoundaryTangents(boundaryI, canvasW, canvasH);
  const tangentJ = computeBoundaryTangents(boundaryJ, canvasW, canvasH);

  const radiusInt   = Math.ceil(alignThresholdPx);
  const thresholdSq = alignThresholdPx * alignThresholdPx;

  const riskMask = new Uint8Array(n);
  let affected = 0, total = 0;
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const k = y * canvasW + x;
      if (!boundaryI[k]) continue;
      total++;
      if (distToJBoundary[k] >= alignThresholdPx) continue;

      // Find any nearby B-boundary pixel whose tangent is roughly parallel
      // to A's tangent at k. Suppresses cross-style intersections (edges
      // crossing at large angles) while preserving same-direction seams.
      const tIx = tangentI[2 * k];
      const tIy = tangentI[2 * k + 1];
      const x0 = Math.max(0, x - radiusInt);
      const x1 = Math.min(canvasW - 1, x + radiusInt);
      const y0 = Math.max(0, y - radiusInt);
      const y1 = Math.min(canvasH - 1, y + radiusInt);

      let parallel = false;
      for (let ny = y0; ny <= y1 && !parallel; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          const m = ny * canvasW + nx;
          if (!boundaryJ[m]) continue;
          const dx = nx - x;
          const dy = ny - y;
          if (dx * dx + dy * dy >= thresholdSq) continue;
          const dot = Math.abs(tIx * tangentJ[2 * m] + tIy * tangentJ[2 * m + 1]);
          if (dot >= PARALLEL_DOT_THRESHOLD) {
            parallel = true;
            break;
          }
        }
      }
      if (parallel) {
        riskMask[k] = 1;
        affected++;
      }
    }
  }

  return { riskMask, affectedCount: affected, totalBoundaryCount: total };
}
