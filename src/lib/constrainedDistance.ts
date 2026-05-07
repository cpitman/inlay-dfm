/**
 * Barrier-aware variant of `distanceTransform`. Returns the per-pixel
 * geodesic distance (in pixels, chamfer-3-4 approximation of
 * Euclidean) to the nearest seed, where propagation cannot pass
 * through barrier pixels.
 *
 *   seeds[k] === 1  →  this pixel is a seed (distance 0).
 *   barrier[k] === 1 →  this pixel is a barrier (distance Infinity,
 *                       and propagation neither *into* nor *out of*
 *                       this pixel is allowed).
 *
 * Used by the optimizer's fill passes to make per-component danger-
 * zone evaluation correct: with `barrier = target.mask`, every pixel
 * in a connected component of `NOT-target` only "sees" seeds in the
 * same component. A danger-source on the opposite side of a target
 * region from a candidate fill pixel can no longer wrongly pull the
 * candidate into the danger zone via straight-line Euclidean
 * distance — the bit at the candidate's position physically can't
 * reach across `target.mask` either.
 *
 * Same 4-pass chamfer structure as `distanceTransform` so the
 * accuracy / cost profile matches what the rest of the analysis
 * pipeline already expects.
 */
export function constrainedDistanceTransform(
  seeds: Uint8Array,
  barrier: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const n = width * height;
  const dist = new Float32Array(n);
  const INF = 1e7;

  for (let i = 0; i < n; i++) {
    if (barrier[i]) dist[i] = Infinity;
    else if (seeds[i]) dist[i] = 0;
    else dist[i] = INF;
  }

  // Pass 1: top-left → bottom-right (cardinals + diagonals)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (barrier[i] || dist[i] === 0) continue;
      if (x > 0 && !barrier[i - 1]) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y > 0 && !barrier[i - width]) dist[i] = Math.min(dist[i], dist[i - width] + 1);
      if (x > 0 && y > 0 && !barrier[i - width - 1]) dist[i] = Math.min(dist[i], dist[i - width - 1] + 1.414);
      if (x < width - 1 && y > 0 && !barrier[i - width + 1]) dist[i] = Math.min(dist[i], dist[i - width + 1] + 1.414);
    }
  }

  // Pass 2: bottom-right → top-left (cardinals + diagonals)
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (barrier[i] || dist[i] === 0) continue;
      if (x < width - 1 && !barrier[i + 1]) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y < height - 1 && !barrier[i + width]) dist[i] = Math.min(dist[i], dist[i + width] + 1);
      if (x < width - 1 && y < height - 1 && !barrier[i + width + 1]) dist[i] = Math.min(dist[i], dist[i + width + 1] + 1.414);
      if (x > 0 && y < height - 1 && !barrier[i + width - 1]) dist[i] = Math.min(dist[i], dist[i + width - 1] + 1.414);
    }
  }

  // Pass 3: top-right → bottom-left (cardinals)
  for (let y = 0; y < height; y++) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (barrier[i] || dist[i] === 0) continue;
      if (x < width - 1 && !barrier[i + 1]) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y > 0 && !barrier[i - width]) dist[i] = Math.min(dist[i], dist[i - width] + 1);
    }
  }

  // Pass 4: bottom-left → top-right (cardinals)
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (barrier[i] || dist[i] === 0) continue;
      if (x > 0 && !barrier[i - 1]) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y < height - 1 && !barrier[i + width]) dist[i] = Math.min(dist[i], dist[i + width] + 1);
    }
  }

  // Pixels that never got reached from a seed (no barrier-respecting
  // path) keep their INF sentinel. Promote it to a true Infinity so
  // callers can detect "unreachable" cleanly via `Number.isFinite` /
  // direct comparison.
  for (let i = 0; i < n; i++) {
    if (dist[i] >= INF) dist[i] = Infinity;
  }
  return dist;
}
