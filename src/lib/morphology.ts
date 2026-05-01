import { distanceTransform } from './distanceTransform';

/**
 * Mark pixels of `mask` that have at least one non-mask 4-neighbor (or that
 * sit on the canvas edge). These are the boundary pixels of the masked region.
 *
 * Used by alignment-risk detection to find layer perimeters and by machining-
 * time estimation to measure cut perimeter for the V-bit feed-rate pass.
 */
export function computeBoundary(mask: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const boundary = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!mask[k]) continue;
      const left  = x === 0     || !mask[k - 1];
      const right = x === w - 1 || !mask[k + 1];
      const up    = y === 0     || !mask[k - w];
      const down  = y === h - 1 || !mask[k + w];
      if (left || right || up || down) boundary[k] = 1;
    }
  }
  return boundary;
}

/**
 * Morphological opening of `mask` by a circular structuring element of
 * radius `radiusPx`. The result is the set of pixels of `mask` that a disc
 * of that radius can cover without crossing the mask boundary — i.e. the
 * area a CNC bit of that radius can actually clear inside the mask.
 *
 * Reuses a pre-computed `dist1` (distance from each mask pixel to the
 * nearest non-mask pixel) when available — the analyzer already produces
 * this for every layer's pocket mask, so this avoids a redundant EDT pass.
 *
 *   eroded[k] = 1   iff   dist1[k] >= radiusPx          (bit center can sit here)
 *   opening[p] = 1  iff   p ∈ mask AND dist(p, eroded) <= radiusPx
 *
 * @returns the opened mask (same shape; length = w * h).
 */
export function morphologicalOpening(
  mask: Uint8Array,
  dist1: Float32Array,
  radiusPx: number,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;

  // Eroded set: pixels with enough clearance for the bit's full radius.
  const eroded = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (dist1[k] >= radiusPx) eroded[k] = 1;
  }

  // Distance from every pixel to the eroded set (seeds = eroded pixels).
  const seeds = new Uint8Array(n);
  for (let k = 0; k < n; k++) seeds[k] = eroded[k] ? 0 : 1;
  const distToEroded = distanceTransform(seeds, w, h);

  // Opening: mask pixels within radiusPx of the eroded set.
  const opened = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (mask[k] && distToEroded[k] <= radiusPx) opened[k] = 1;
  }
  return opened;
}
