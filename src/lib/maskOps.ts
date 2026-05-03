import { distanceTransform } from './distanceTransform';

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
