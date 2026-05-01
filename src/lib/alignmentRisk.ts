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
  const seedsJB = new Uint8Array(n);
  for (let k = 0; k < n; k++) seedsJB[k] = boundaryJ[k] ? 0 : 1;
  const distToJBoundary = distanceTransform(seedsJB, canvasW, canvasH);

  const riskMask = new Uint8Array(n);
  let affected = 0, total = 0;
  for (let k = 0; k < n; k++) {
    if (!boundaryI[k]) continue;
    total++;
    if (distToJBoundary[k] < alignThresholdPx) {
      riskMask[k] = 1;
      affected++;
    }
  }

  return { riskMask, affectedCount: affected, totalBoundaryCount: total };
}
