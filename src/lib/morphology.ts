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
 * Find connected components of non-mask pixels that are fully enclosed by
 * the mask — i.e. *holes* in the mask's geometry. A non-mask region that
 * touches the canvas edge is "outside" rather than a hole and is excluded.
 *
 * Two flood-fill passes:
 *   1. Seed from every canvas-edge non-mask pixel and mark the reachable
 *      "outside" set (4-connected through non-mask pixels).
 *   2. The remaining non-mask pixels are inside; group them into
 *      connected components — one entry per component.
 *
 * Returns each hole as a list of pixel indices (`y * w + x`).
 */
export function findEnclosedHoles(mask: Uint8Array, w: number, h: number): { pixels: number[] }[] {
  const n = w * h;
  const outside = new Uint8Array(n);

  // Seed flood-fill from canvas edges.
  const queue: number[] = [];
  const seed = (k: number) => {
    if (mask[k] || outside[k]) return;
    outside[k] = 1;
    queue.push(k);
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + (w - 1)); }

  let head = 0;
  while (head < queue.length) {
    const k = queue[head++];
    const x = k % w;
    const y = (k - x) / w;
    if (x > 0)     { const nk = k - 1;  if (!mask[nk] && !outside[nk]) { outside[nk] = 1; queue.push(nk); } }
    if (x < w - 1) { const nk = k + 1;  if (!mask[nk] && !outside[nk]) { outside[nk] = 1; queue.push(nk); } }
    if (y > 0)     { const nk = k - w;  if (!mask[nk] && !outside[nk]) { outside[nk] = 1; queue.push(nk); } }
    if (y < h - 1) { const nk = k + w;  if (!mask[nk] && !outside[nk]) { outside[nk] = 1; queue.push(nk); } }
  }

  // Collect connected components of (non-mask AND not outside) = holes.
  const visited = new Uint8Array(n);
  const holes: { pixels: number[] }[] = [];
  for (let start = 0; start < n; start++) {
    if (mask[start] || outside[start] || visited[start]) continue;
    visited[start] = 1;
    const pixels: number[] = [start];
    let h0 = 0;
    while (h0 < pixels.length) {
      const k = pixels[h0++];
      const x = k % w;
      const y = (k - x) / w;
      if (x > 0)     { const nk = k - 1;  if (!mask[nk] && !outside[nk] && !visited[nk]) { visited[nk] = 1; pixels.push(nk); } }
      if (x < w - 1) { const nk = k + 1;  if (!mask[nk] && !outside[nk] && !visited[nk]) { visited[nk] = 1; pixels.push(nk); } }
      if (y > 0)     { const nk = k - w;  if (!mask[nk] && !outside[nk] && !visited[nk]) { visited[nk] = 1; pixels.push(nk); } }
      if (y < h - 1) { const nk = k + w;  if (!mask[nk] && !outside[nk] && !visited[nk]) { visited[nk] = 1; pixels.push(nk); } }
    }
    holes.push({ pixels });
  }
  return holes;
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
