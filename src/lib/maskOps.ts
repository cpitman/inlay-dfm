import { distanceTransform } from './distanceTransform';

/**
 * Shrink a binary mask by `radiusPx` pixels in every direction
 * (Minkowski erosion with a disc — Euclidean, via a single EDT pass).
 *
 * The output is `1` for every pixel whose Euclidean distance to the
 * nearest *non*-mask pixel is ≥ `radiusPx`, `0` elsewhere. In other
 * words: only pixels strictly inside the mask by the given radius
 * survive — boundary pixels are eroded away.
 *
 * Used by the layer-order pre-pass to detect "real" pairwise overlap
 * between two layers without flagging shared-boundary anti-aliasing
 * as a false positive: erode each mask by 1 px, then check
 * intersection.
 *
 * Returns the input mask unchanged when `radiusPx <= 0`.
 */
export function erodeMask(
  mask: Uint8Array,
  w: number,
  h: number,
  radiusPx: number,
): Uint8Array {
  const n = w * h;
  if (radiusPx <= 0) return mask;
  // Distance from each pixel to the nearest non-mask pixel: seed the
  // *non-mask* pixels (so seeds[k] = 0 for non-mask, 1 for mask) and
  // run the EDT. Mask-interior pixels survive iff that distance is
  // ≥ the erosion radius.
  const seeds = new Uint8Array(n);
  for (let k = 0; k < n; k++) seeds[k] = mask[k] ? 1 : 0;
  const dist = distanceTransform(seeds, w, h);
  const out = new Uint8Array(n);
  // Strict `>` so erosion is the exact dual of `dilateMask`'s `<=`:
  // a pixel cardinally adjacent to non-mask has dist = 1, and erode
  // radius 1 should strip that 1-pixel boundary — keeping `>=` would
  // leave it in place (off by one).
  for (let k = 0; k < n; k++) {
    if (mask[k] && dist[k] > radiusPx) out[k] = 1;
  }
  return out;
}

/**
 * Grow a binary mask by `radiusPx` pixels in every direction
 * (Minkowski sum with a disc — Euclidean dilation, implemented via
 * a single EDT pass).
 *
 * The output is `1` for every pixel within `radiusPx` (inclusive)
 * Euclidean distance of any input mask pixel, `0` elsewhere.
 *
 * Used to make tiny problem regions visible in the analysis overlays
 * (a 1-pixel sliver at canvas resolution is invisible at thumbnail
 * display size — dilating by a few pixels gives it a small but
 * seeable footprint without changing the underlying centroid placement).
 *
 * Returns the input mask unchanged when `radiusPx <= 0`.
 */
export function dilateMask(
  mask: Uint8Array,
  w: number,
  h: number,
  radiusPx: number,
): Uint8Array {
  const n = w * h;
  if (radiusPx <= 0) return mask;
  // distanceTransform: seeds[k] = 0 means "this pixel is a seed";
  // it returns the Euclidean distance from each pixel to the nearest
  // seed. We mark mask pixels as seeds, then threshold the distance.
  const seeds = new Uint8Array(n);
  for (let k = 0; k < n; k++) seeds[k] = mask[k] ? 0 : 1;
  const dist = distanceTransform(seeds, w, h);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (dist[k] <= radiusPx) out[k] = 1;
  }
  return out;
}
