/**
 * Parse SVG path data into a `MultiPolygon`. Used by the polygon-
 * native pipeline to ingest source SVGs without the
 * rasterization-then-trace round-trip.
 *
 * Bezier curves are adaptively flattened to polylines: a curve is
 * subdivided via de Casteljau until the chord-error (max distance
 * from any control point to the straight P0→Pn line) is below
 * `flatness`. Default flatness is 0.05 design units, which on a
 * typical 300-unit SVG viewBox = ~0.001× design size = sub-pixel
 * even at high zoom.
 *
 * Returns one `MultiPolygon` per input path. Multiple subpaths
 * (separated by `M` commands) become separate rings under the
 * even-odd fill rule.
 */

import svgpath from 'svgpath';
import { canonicalizeRings, multiPolygonUnionAll } from './clipperOps';
import type { Point, Ring, MultiPolygon } from './polygon';

const DEFAULT_FLATNESS = 0.05;

/**
 * Adaptive cubic-Bezier subdivision. Recursively splits the curve
 * until each segment's max control-point deviation from the
 * straight line P0→P3 is below `flatness`. Appends LINE-segment
 * endpoints (excluding P0; caller seeds it) to `out`.
 */
function flattenCubic(
  p0: Point, p1: Point, p2: Point, p3: Point,
  flatness: number,
  out: Point[],
): void {
  // Distance from a point to the line P0→P3.
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len2 = dx * dx + dy * dy;
  let d1 = 0, d2 = 0;
  if (len2 > 0) {
    const c1 = (p1.x - p0.x) * dy - (p1.y - p0.y) * dx;
    const c2 = (p2.x - p0.x) * dy - (p2.y - p0.y) * dx;
    d1 = (c1 * c1) / len2;
    d2 = (c2 * c2) / len2;
  } else {
    // Degenerate end-points: fall back to control-point spread.
    d1 = (p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2;
    d2 = (p2.x - p0.x) ** 2 + (p2.y - p0.y) ** 2;
  }
  const f2 = flatness * flatness;
  if (d1 <= f2 && d2 <= f2) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  // de Casteljau: split at t = 0.5.
  const m01 = midpoint(p0, p1);
  const m12 = midpoint(p1, p2);
  const m23 = midpoint(p2, p3);
  const m012 = midpoint(m01, m12);
  const m123 = midpoint(m12, m23);
  const m0123 = midpoint(m012, m123);
  flattenCubic(p0, m01, m012, m0123, flatness, out);
  flattenCubic(m0123, m123, m23, p3, flatness, out);
}

/** Quadratic Bezier flattening via promotion to a cubic. */
function flattenQuadratic(
  p0: Point, p1: Point, p2: Point,
  flatness: number,
  out: Point[],
): void {
  // Quadratic (P0, P1, P2) ≡ cubic (P0, P0 + 2/3 (P1−P0), P2 + 2/3 (P1−P2), P2).
  const c1: Point = { x: p0.x + (2 / 3) * (p1.x - p0.x), y: p0.y + (2 / 3) * (p1.y - p0.y) };
  const c2: Point = { x: p2.x + (2 / 3) * (p1.x - p2.x), y: p2.y + (2 / 3) * (p1.y - p2.y) };
  flattenCubic(p0, c1, c2, p2, flatness, out);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

/**
 * Parse one SVG `d` attribute into a list of rings. Each `M`
 * command starts a new ring; `Z` (or the start of the next ring)
 * closes it by snapping the final point back to the M-point if
 * not already coincident.
 *
 * Rings with fewer than 3 vertices after flattening are dropped
 * (degenerate).
 */
export function svgPathToRings(d: string, flatness: number = DEFAULT_FLATNESS): Ring[] {
  // Normalize: absolute coords + arcs to cubics + S/T expanded to C/Q.
  const sp = svgpath(d).abs().unarc().unshort();
  // `err` is set by the JS lib on parse failure but isn't in the
  // bundled types — read via a typed cast.
  const err = (sp as unknown as { err?: string | null }).err;
  if (err) throw new Error(`Invalid SVG path: ${err}`);

  const rings: Ring[] = [];
  let current: Ring | null = null;
  let startX = 0, startY = 0; // current subpath's M anchor

  sp.iterate((seg, _index, x, y) => {
    const cmd = seg[0] as string;
    switch (cmd) {
      case 'M': {
        // Starting a new subpath: finalize the previous ring.
        if (current && current.length >= 3) rings.push(current);
        current = [];
        const mx = seg[1] as number;
        const my = seg[2] as number;
        current.push({ x: mx, y: my });
        startX = mx; startY = my;
        break;
      }
      case 'L': {
        if (!current) current = [{ x, y }];
        current.push({ x: seg[1] as number, y: seg[2] as number });
        break;
      }
      case 'H': {
        if (!current) current = [{ x, y }];
        current.push({ x: seg[1] as number, y });
        break;
      }
      case 'V': {
        if (!current) current = [{ x, y }];
        current.push({ x, y: seg[1] as number });
        break;
      }
      case 'C': {
        if (!current) current = [{ x, y }];
        const p0 = { x, y };
        const p1 = { x: seg[1] as number, y: seg[2] as number };
        const p2 = { x: seg[3] as number, y: seg[4] as number };
        const p3 = { x: seg[5] as number, y: seg[6] as number };
        flattenCubic(p0, p1, p2, p3, flatness, current);
        break;
      }
      case 'Q': {
        if (!current) current = [{ x, y }];
        const p0 = { x, y };
        const p1 = { x: seg[1] as number, y: seg[2] as number };
        const p2 = { x: seg[3] as number, y: seg[4] as number };
        flattenQuadratic(p0, p1, p2, flatness, current);
        break;
      }
      case 'Z':
      case 'z': {
        // Close the subpath: ensure the last point coincides with
        // the M anchor (drop a redundant duplicate if present).
        if (current && current.length > 0) {
          const last = current[current.length - 1];
          if (last.x === startX && last.y === startY) {
            current.pop();
          }
          if (current.length >= 3) rings.push(current);
        }
        current = null;
        break;
      }
      // S, T, A should have been expanded by abs/unarc/unshort.
      // Anything else is unexpected — silently ignore so a malformed
      // path still produces partial output.
      default:
        break;
    }
  });

  // Trailing open subpath (no Z): include it if non-degenerate.
  if (current && (current as Ring).length >= 3) rings.push(current as Ring);

  return rings;
}

/**
 * Extract a `MultiPolygon` from a layer's `svgFragment`.
 *
 * Each `<path>` is canonicalized under its declared `fill-rule`
 * (default: nonzero). Two CCW overlapping subpaths inside one
 * `<path d="…">` UNION under nonzero (browser default) but XOR
 * under evenodd — getting this wrong is what made overlapping
 * fills appear with holes after the optimizer round-tripped them.
 *
 * `<rect>`, `<circle>`, `<ellipse>`, `<polygon>` produce a single
 * ring each so the rule doesn't matter; `<polyline>` is dropped
 * (it's not a fillable shape under nonzero or evenodd).
 *
 * Regex-based extraction so the parser works in both Node (vitest)
 * and browser. Layer fragments are always machine-emitted — by
 * `splitSvgIntoLayers` (post-flatten), `multiPolygonToSvgFragment`,
 * etc. — so simple regexes suffice; no general-purpose XML parser.
 */
export function svgFragmentToMultiPolygon(
  fragment: string,
  flatness: number = DEFAULT_FLATNESS,
): MultiPolygon {
  const parts: MultiPolygon[] = [];

  // <path d="…"> — canonicalize per-path under its fill-rule.
  for (const m of fragment.matchAll(/<path\b([^>]*)>/gi)) {
    const attrs = m[1];
    const d = getAttr(attrs, 'd');
    if (!d) continue;
    const ringsForPath = svgPathToRings(d, flatness);
    if (ringsForPath.length === 0) continue;
    const fillRule = readFillRule(attrs);
    parts.push(canonicalizeRings(ringsForPath, fillRule));
  }

  // <polygon points="…"> — single closed ring, fill-rule irrelevant.
  for (const m of fragment.matchAll(/<polygon\b([^>]*)>/gi)) {
    const points = getAttr(m[1], 'points');
    if (!points) continue;
    const ring = parsePointList(points);
    if (ring.length >= 3) parts.push([ring]);
  }

  // <rect x y width height> — single closed ring.
  for (const m of fragment.matchAll(/<rect\b([^>]*)\/?>/gi)) {
    const attrs = m[1];
    const x = parseFloat(getAttr(attrs, 'x') ?? '0');
    const y = parseFloat(getAttr(attrs, 'y') ?? '0');
    const w = parseFloat(getAttr(attrs, 'width') ?? '0');
    const h = parseFloat(getAttr(attrs, 'height') ?? '0');
    if (w > 0 && h > 0) {
      parts.push([[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]]);
    }
  }

  // <circle cx cy r>.
  for (const m of fragment.matchAll(/<circle\b([^>]*)\/?>/gi)) {
    const attrs = m[1];
    const cx = parseFloat(getAttr(attrs, 'cx') ?? '0');
    const cy = parseFloat(getAttr(attrs, 'cy') ?? '0');
    const r = parseFloat(getAttr(attrs, 'r') ?? '0');
    if (r > 0) parts.push([approximateCircle(cx, cy, r, r, flatness)]);
  }

  // <ellipse cx cy rx ry>.
  for (const m of fragment.matchAll(/<ellipse\b([^>]*)\/?>/gi)) {
    const attrs = m[1];
    const cx = parseFloat(getAttr(attrs, 'cx') ?? '0');
    const cy = parseFloat(getAttr(attrs, 'cy') ?? '0');
    const rx = parseFloat(getAttr(attrs, 'rx') ?? '0');
    const ry = parseFloat(getAttr(attrs, 'ry') ?? '0');
    if (rx > 0 && ry > 0) parts.push([approximateCircle(cx, cy, rx, ry, flatness)]);
  }

  if (parts.length === 0) return [];
  if (parts.length === 1) return parts[0];
  return multiPolygonUnionAll(parts);
}

/**
 * Read the SVG fill-rule from an element's attribute string. Checks
 * the explicit `fill-rule="…"` attribute first, then `style="…
 * fill-rule:…"`. Returns 'nonzero' for absent / unrecognized values
 * (matches SVG's spec default).
 */
function readFillRule(attrs: string): 'nonzero' | 'evenodd' {
  const explicit = getAttr(attrs, 'fill-rule');
  if (explicit) {
    return explicit.trim().toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
  }
  const style = getAttr(attrs, 'style');
  if (style) {
    const m = style.match(/(?:^|;)\s*fill-rule\s*:\s*([^;]+)/i);
    if (m) return m[1].trim().toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
  }
  return 'nonzero';
}

function getAttr(attrs: string, name: string): string | null {
  // Match attr="..." or attr='...' with whitespace-tolerant.
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = attrs.match(re);
  return m ? m[1] : null;
}

function parsePointList(s: string): Ring {
  const out: Ring = [];
  const tokens = s.trim().split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    out.push({ x: tokens[i], y: tokens[i + 1] });
  }
  return out;
}

/**
 * Emit a `MultiPolygon` as an SVG path `d` attribute under the
 * even-odd fill rule (each ring becomes one M…L…Z subpath).
 * Coordinates are emitted in the polygon's design-coordinate system
 * (= source SVG's viewBox), with `precision` decimal places.
 */
export function multiPolygonToSvgPathD(mp: MultiPolygon, precision: number = 3): string {
  const out: string[] = [];
  const fmt = (n: number) => {
    const s = n.toFixed(precision);
    // Strip trailing zeros after the decimal point for compactness.
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  for (const ring of mp) {
    if (ring.length < 3) continue;
    out.push(`M ${fmt(ring[0].x)} ${fmt(ring[0].y)}`);
    for (let i = 1; i < ring.length; i++) {
      out.push(`L ${fmt(ring[i].x)} ${fmt(ring[i].y)}`);
    }
    out.push('Z');
  }
  return out.join(' ');
}

/**
 * Emit a `MultiPolygon` as a complete `<path …/>` SVG fragment ready
 * to drop into a layer's `svgFragment` slot. `fill` should be the
 * design's color hex; `extraAttrs` lets callers pass through stroke
 * styling, classes, etc. unchanged.
 */
export function multiPolygonToSvgFragment(
  mp: MultiPolygon,
  fill: string,
  extraAttrs: string = '',
  precision: number = 3,
): string {
  const d = multiPolygonToSvgPathD(mp, precision);
  if (!d) return '';
  const fillAttr = fill ? ` fill="${fill}"` : '';
  const extra = extraAttrs ? ` ${extraAttrs}` : '';
  return `<path d="${d}" fill-rule="evenodd"${fillAttr}${extra} />`;
}

function approximateCircle(cx: number, cy: number, rx: number, ry: number, flatness: number): Ring {
  // Number of segments needed for chord-error ≤ flatness on an
  // ellipse with average radius `r` is ceil(π / acos(1 − f/r)).
  const r = Math.max(rx, ry);
  const ratio = Math.min(1, flatness / r);
  const minStep = Math.acos(Math.max(-1, 1 - ratio));
  const n = Math.max(8, Math.ceil((2 * Math.PI) / Math.max(minStep, 1e-3)));
  const ring: Ring = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    ring[i] = { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry };
  }
  return ring;
}
