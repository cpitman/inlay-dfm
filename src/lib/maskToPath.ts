/**
 * Convert a binary pixel mask to clean SVG contour paths.
 *
 * Pipeline:
 *   1. Marching squares — trace the boundary of all "in" regions as polygons
 *   2. Douglas–Peucker — collapse pixel-level zigzag on straight edges into
 *      single segments while preserving real corners and curves
 *   3. Emit as a single <path d="M...L...Z M...L...Z"/> with fill-rule=evenodd
 *      so interior holes render correctly in browsers and CAM tools
 *
 * Coordinates are emitted in the user-space units passed in as scaleX/scaleY,
 * so a mask traced at 1200×N can produce a path that fits the SVG viewBox.
 */

interface Point { x: number; y: number }

/**
 * Marching squares contour tracing on a binary mask.
 *
 * Treats each pixel as a corner sample. The 2×2 cell at integer corner (x, y)
 * has corners at (x, y), (x+1, y), (x+1, y+1), (x, y+1). 16 cases produce 0–2
 * line segments per cell; segments stitch together into closed polygons.
 *
 * Output coordinates are in pixel space (0..w, 0..h) at half-pixel offsets
 * (where the contour actually lies between filled and empty pixels).
 */
function marchingSquares(mask: Uint8Array, w: number, h: number): Point[][] {
  // Pad mask by 1 on each side with 0s so contours from boundary-touching
  // regions still close cleanly. Padded grid is (w+2) × (h+2).
  const pw = w + 2, ph = h + 2;
  const grid = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      grid[(y + 1) * pw + (x + 1)] = mask[y * w + x];
    }
  }
  const at = (x: number, y: number) => grid[y * pw + x];

  // segments[fromKey] -> { from, to, used }
  // Each cell contributes 0, 1, or 2 directed segments. Stitch by matching
  // to-points to from-points.
  type Seg = { from: Point; to: Point };
  const segs: Seg[] = [];

  // Edge midpoints (where contour crosses a cell edge) in padded grid coords.
  // For cell at top-left corner (cx, cy) — i.e., samples at cx, cx+1, cy, cy+1:
  const top   = (cx: number, cy: number): Point => ({ x: cx + 0.5, y: cy });
  const bot   = (cx: number, cy: number): Point => ({ x: cx + 0.5, y: cy + 1 });
  const left  = (cx: number, cy: number): Point => ({ x: cx,       y: cy + 0.5 });
  const right = (cx: number, cy: number): Point => ({ x: cx + 1,   y: cy + 0.5 });

  // Walk all cells; each is the 2×2 block whose top-left corner is (cx, cy).
  for (let cy = 0; cy < ph - 1; cy++) {
    for (let cx = 0; cx < pw - 1; cx++) {
      const tl = at(cx,     cy);
      const tr = at(cx + 1, cy);
      const br = at(cx + 1, cy + 1);
      const bl = at(cx,     cy + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);

      // Cases 0 and 15: no contour. Saddle cases 5 and 10 are split using the
      // "filled" interpretation (foreground connects); this is consistent for
      // typical inlay shapes and keeps stitching unambiguous.
      switch (code) {
        case 1:  segs.push({ from: left(cx, cy),  to: bot(cx, cy)   }); break;
        case 2:  segs.push({ from: bot(cx, cy),   to: right(cx, cy) }); break;
        case 3:  segs.push({ from: left(cx, cy),  to: right(cx, cy) }); break;
        case 4:  segs.push({ from: right(cx, cy), to: top(cx, cy)   }); break;
        case 5:  // saddle: foreground TL+BR
          segs.push({ from: left(cx, cy),  to: top(cx, cy)   });
          segs.push({ from: right(cx, cy), to: bot(cx, cy)   });
          break;
        case 6:  segs.push({ from: bot(cx, cy),   to: top(cx, cy)   }); break;
        case 7:  segs.push({ from: left(cx, cy),  to: top(cx, cy)   }); break;
        case 8:  segs.push({ from: top(cx, cy),   to: left(cx, cy)  }); break;
        case 9:  segs.push({ from: top(cx, cy),   to: bot(cx, cy)   }); break;
        case 10: // saddle: foreground TR+BL
          segs.push({ from: top(cx, cy),   to: right(cx, cy) });
          segs.push({ from: bot(cx, cy),   to: left(cx, cy)  });
          break;
        case 11: segs.push({ from: top(cx, cy),   to: right(cx, cy) }); break;
        case 12: segs.push({ from: right(cx, cy), to: left(cx, cy)  }); break;
        case 13: segs.push({ from: right(cx, cy), to: bot(cx, cy)   }); break;
        case 14: segs.push({ from: bot(cx, cy),   to: left(cx, cy)  }); break;
      }
    }
  }

  // Stitch segments into closed polygons. Build a hashmap by from-point.
  const key = (p: Point) => `${p.x},${p.y}`;
  const byFrom = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = key(s.from);
    const arr = byFrom.get(k);
    if (arr) arr.push(s); else byFrom.set(k, [s]);
  }

  const used = new Set<Seg>();
  const polygons: Point[][] = [];

  for (const startSeg of segs) {
    if (used.has(startSeg)) continue;
    const poly: Point[] = [startSeg.from];
    let cur = startSeg;
    while (true) {
      used.add(cur);
      poly.push(cur.to);
      const candidates = byFrom.get(key(cur.to));
      if (!candidates) break;
      const next = candidates.find(s => !used.has(s));
      if (!next) break;
      if (next === startSeg || used.has(next)) break;
      cur = next;
    }
    if (poly.length >= 3) {
      // Translate from padded → original grid (subtract 1 from each coord).
      polygons.push(poly.map(p => ({ x: p.x - 1, y: p.y - 1 })));
    }
  }

  return polygons;
}

/**
 * Perpendicular distance from point p to the line through a–b.
 * Used by Douglas–Peucker to decide which vertices to keep.
 */
function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p.x - a.x, ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const ex = p.x - px, ey = p.y - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Iterative Douglas-Peucker (no recursion → safe for very long polygons). */
function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice();
  const closed = points[0].x === points[points.length - 1].x &&
                 points[0].y === points[points.length - 1].y;
  const work = closed ? points.slice(0, -1) : points.slice();
  const n = work.length;
  if (n < 3) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = 0, idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDist(work[i], work[start], work[end]);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > epsilon && idx !== -1) {
      keep[idx] = 1;
      stack.push([start, idx]);
      stack.push([idx, end]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(work[i]);
  if (closed && out.length >= 3) out.push({ ...out[0] });
  return out;
}

/** Discard polygons whose absolute signed area is below a threshold. */
function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a) / 2;
}

interface MaskToPathOptions {
  /** SVG fill color for the emitted path. */
  fill: string;
  /** Multiply pixel x-coordinates by this when emitting (e.g., user-space-per-pixel). */
  scaleX: number;
  /** Multiply pixel y-coordinates by this when emitting. */
  scaleY: number;
  /** Vertex-collapse tolerance, in pixels. ~1 erases jaggies on straight edges. */
  simplifyEpsilonPx?: number;
  /** Drop polygons smaller than this (in pixels²) to skip stray single-pixel artifacts. */
  minAreaPx?: number;
  /** Optional extra attributes to add to the <path>, e.g., 'stroke="..."'. */
  extraAttrs?: string;
}

/**
 * Convert a binary mask to a single SVG <path> element string. Returns the
 * empty string when the mask has no foreground pixels or all contours are
 * filtered out by minAreaPx.
 */
export function maskToSvgPath(
  mask: Uint8Array,
  w: number,
  h: number,
  opts: MaskToPathOptions,
): string {
  const polys = marchingSquares(mask, w, h);
  const eps = opts.simplifyEpsilonPx ?? 1;
  const minArea = opts.minAreaPx ?? 1;
  const extra = opts.extraAttrs ?? '';

  const parts: string[] = [];
  for (const raw of polys) {
    if (polygonArea(raw) < minArea) continue;
    const simplified = simplify(raw, eps);
    if (simplified.length < 3) continue;
    let d = `M ${(simplified[0].x * opts.scaleX).toFixed(3)} ${(simplified[0].y * opts.scaleY).toFixed(3)}`;
    for (let i = 1; i < simplified.length; i++) {
      d += ` L ${(simplified[i].x * opts.scaleX).toFixed(3)} ${(simplified[i].y * opts.scaleY).toFixed(3)}`;
    }
    d += ' Z';
    parts.push(d);
  }
  if (parts.length === 0) return '';
  return `<path d="${parts.join(' ')}" fill="${opts.fill}" fill-rule="evenodd" stroke="none"${extra ? ' ' + extra : ''}/>`;
}
