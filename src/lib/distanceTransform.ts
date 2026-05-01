/**
 * 4-pass approximate Euclidean distance transform.
 * Returns per-pixel distance (in pixels) to the nearest background pixel.
 * Only filled (true) pixels get non-zero distances.
 */
export function distanceTransform(
  filled: Uint8Array,
  width: number,
  height: number
): Float32Array {
  const n = width * height;
  const dist = new Float32Array(n);
  const INF = 1e7;

  for (let i = 0; i < n; i++) {
    dist[i] = filled[i] ? INF : 0;
  }

  // Pass 1: top-left → bottom-right
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y > 0) dist[i] = Math.min(dist[i], dist[i - width] + 1);
      if (x > 0 && y > 0) dist[i] = Math.min(dist[i], dist[i - width - 1] + 1.414);
      if (x < width - 1 && y > 0) dist[i] = Math.min(dist[i], dist[i - width + 1] + 1.414);
    }
  }

  // Pass 2: bottom-right → top-left
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      if (x < width - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y < height - 1) dist[i] = Math.min(dist[i], dist[i + width] + 1);
      if (x < width - 1 && y < height - 1) dist[i] = Math.min(dist[i], dist[i + width + 1] + 1.414);
      if (x > 0 && y < height - 1) dist[i] = Math.min(dist[i], dist[i + width - 1] + 1.414);
    }
  }

  // Pass 3: top-right → bottom-left
  for (let y = 0; y < height; y++) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      if (x < width - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y > 0) dist[i] = Math.min(dist[i], dist[i - width] + 1);
    }
  }

  // Pass 4: bottom-left → top-right
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y < height - 1) dist[i] = Math.min(dist[i], dist[i + width] + 1);
    }
  }

  return dist;
}
