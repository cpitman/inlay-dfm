import { findMaskComponents } from './maskComponents';
import { dilateMask } from './maskOps';

/**
 * Estimate the total plug-stock material area required to carve every
 * inlay region of a single layer, with a configurable buffer of stock
 * around each plug. Used by the guided quote pipeline to charge only
 * the *fraction of a sheet* a small inlay actually consumes, rather
 * than the full per-sheet price.
 *
 * Algorithm:
 *   1. Dilate `pocketMask` by `growthInches` (Minkowski sum with a
 *      disc — implemented via EDT thresholding). This bakes in the
 *      cutting margin between adjacent plug pieces.
 *   2. Find connected components of the dilated mask.
 *   3. For each component, compute the convex hull (Andrew's monotone
 *      chain over the component's boundary points), then the minimum-
 *      area enclosing rectangle (oriented bounding box) by testing
 *      each hull edge as a candidate rectangle side.
 *   4. Sum the OBB areas across components.
 *
 * The OBB sum approximates how the plug pieces would pack onto a
 * rectangular blank when nested optimally. Returns square inches.
 */
export function computePlugStockUsageSqIn(
  pocketMask: Uint8Array,
  canvasW: number,
  canvasH: number,
  pixelsPerInch: number,
  growthInches: number = 0.51,
): number {
  const growthPx = growthInches * pixelsPerInch;
  const ppiSq = pixelsPerInch * pixelsPerInch;

  // Step 1: dilate pocketMask by growthPx (Minkowski sum with a disc).
  const dilated = dilateMask(pocketMask, canvasW, canvasH, growthPx);
  let any = false;
  for (let k = 0; k < dilated.length; k++) if (dilated[k]) { any = true; break; }
  if (!any) return 0;

  // Step 2: connected components (4-connected).
  const components = findMaskComponents(dilated, canvasW, canvasH);

  // Steps 3 + 4: per-component OBB area, summed.
  let totalAreaPx = 0;
  for (const comp of components) {
    const boundary = extractBoundaryPoints(comp.pixels, dilated, canvasW, canvasH);
    if (boundary.length < 3) {
      // Single-pixel or line — fall back to pixel count as area.
      totalAreaPx += comp.pixels.length;
      continue;
    }
    const hull = convexHull(boundary);
    if (hull.length < 3) {
      totalAreaPx += comp.pixels.length;
      continue;
    }
    totalAreaPx += minAreaOBBAreaPx(hull);
  }

  return totalAreaPx / ppiSq;
}

interface Point { x: number; y: number }

/**
 * Boundary pixels of a component — pixels with at least one non-mask
 * 4-neighbor (or canvas-edge neighbor). Convex hull is determined by
 * extreme points, so we only need the boundary, not every interior
 * pixel.
 */
function extractBoundaryPoints(
  componentPixels: number[],
  mask: Uint8Array,
  w: number,
  h: number,
): Point[] {
  const out: Point[] = [];
  for (const k of componentPixels) {
    const x = k % w;
    const y = (k - x) / w;
    const left  = x === 0     || !mask[k - 1];
    const right = x === w - 1 || !mask[k + 1];
    const up    = y === 0     || !mask[k - w];
    const down  = y === h - 1 || !mask[k + w];
    if (left || right || up || down) out.push({ x, y });
  }
  return out;
}

/**
 * Andrew's monotone-chain convex hull. Input points may have
 * duplicates and arbitrary order. Returns hull vertices in CCW order.
 * For a degenerate (collinear) input, returns the unique extreme
 * points only — the caller treats that as a degenerate component.
 */
function convexHull(pts: Point[]): Point[] {
  if (pts.length < 3) return pts.slice();
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2
        && crossOAB(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2
        && crossOAB(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function crossOAB(O: Point, A: Point, B: Point): number {
  return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
}

/**
 * Minimum-area enclosing rectangle of a convex polygon (rotating-
 * calipers candidate test). The optimal rectangle has one side
 * collinear with one of the hull's edges, so we test each edge
 * direction and project all hull points onto its tangent + normal
 * to compute the rectangle dimensions.
 *
 * Returns area in pixel² (caller divides by ppi² to get sq inches).
 */
function minAreaOBBAreaPx(hull: Point[]): number {
  if (hull.length < 3) return 0;
  let minArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len === 0) continue;
    const ux = ex / len, uy = ey / len;
    const nx = -uy, ny = ux;
    let minU = Infinity, maxU = -Infinity;
    let minN = Infinity, maxN = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pn = p.x * nx + p.y * ny;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pn < minN) minN = pn;
      if (pn > maxN) maxN = pn;
    }
    const w = maxU - minU;
    const h = maxN - minN;
    const area = w * h;
    if (area < minArea) minArea = area;
  }
  return minArea === Infinity ? 0 : minArea;
}
