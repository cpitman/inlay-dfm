/**
 * Pre-flatten an SVG via the browser DOM so the polygon-native
 * stroke extractor sees fully-resolved leaf elements with absolute
 * coordinates and absolute stroke styling.
 *
 * The browser's own SVG renderer handles three things our regex-
 * based parser cannot:
 *   1. `transform="..."` attributes — composed across nested
 *      `<g>` ancestors via `getCTM()`.
 *   2. Group inheritance — child elements inherit `stroke`,
 *      `stroke-width`, `fill`, etc. from `<g>` ancestors. Resolved
 *      via `window.getComputedStyle()`.
 *   3. CSS stylesheets — `<style>` blocks with class / tag
 *      selectors. Also resolved by `getComputedStyle()`.
 *
 * Implementation: mount the SVG in a hidden DOM element, walk
 * each leaf graphical element (path / polyline / polygon / rect /
 * circle / ellipse / line), read its CTM and computed styles, and
 * apply the CTM to the local geometry to produce root-SVG
 * coordinates. Then unmount.
 *
 * Browser-only — `document` and `window` must be defined. The
 * polygon-native stroke pipeline runs on the browser side anyway
 * (it's called from the SVG-import flow on `/quote`), so this is
 * not a regression in capability.
 */

import svgpath from 'svgpath';
import type { Point } from './polygon';

/** Bezier-flattening tolerance for path conversion. Same as polygonParser. */
const FLATNESS = 0.05;

type LineCap = 'butt' | 'square' | 'round';
type LineJoin = 'miter' | 'round' | 'bevel';

export interface FlattenedSvgElement {
  /** Document-order index. */
  zIndex: number;
  /** Subpaths in root-SVG (= viewBox) coordinates. */
  subpaths: { points: Point[]; closed: boolean }[];
  hasStroke: boolean;
  /** Stroke width in root-SVG units (already scaled by CTM). */
  strokeWidth: number;
  strokeLinecap: LineCap;
  strokeLinejoin: LineJoin;
  hasFill: boolean;
}

/** Flatten an SVG to a list of leaf shapes with resolved styling and absolute coordinates. */
export async function flattenSvg(svgText: string): Promise<FlattenedSvgElement[]> {
  if (typeof document === 'undefined') {
    throw new Error('flattenSvg requires a browser DOM (use parseSvgStrokeElements for Node).');
  }

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden;';
  document.body.appendChild(host);
  host.innerHTML = svgText;

  try {
    const svg = host.querySelector('svg');
    if (!svg) return [];

    // Force a layout pass so getCTM is computed.
    void (svg as SVGSVGElement).getBoundingClientRect();

    const result: FlattenedSvgElement[] = [];
    let z = 0;
    walkShapeElements(svg, (el) => {
      const fl = elementToFlattened(el, z++);
      if (fl) result.push(fl);
    });
    return result;
  } finally {
    document.body.removeChild(host);
  }
}

const SHAPE_TAGS = new Set(['path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'line']);

function walkShapeElements(node: Element, visit: (el: SVGGraphicsElement) => void): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const tag = child.tagName.toLowerCase();
    if (SHAPE_TAGS.has(tag)) {
      visit(child as SVGGraphicsElement);
    } else if (child.children.length > 0) {
      // <g>, <defs>, <symbol>, etc. — walk into them.
      walkShapeElements(child, visit);
    }
  }
}

function elementToFlattened(el: SVGGraphicsElement, zIndex: number): FlattenedSvgElement | null {
  const styles = window.getComputedStyle(el);

  const stroke = (styles.stroke ?? '').toLowerCase();
  const fill   = (styles.fill   ?? '').toLowerCase();
  const hasStroke = !!stroke && stroke !== 'none' && stroke !== 'transparent' && stroke !== 'rgba(0, 0, 0, 0)';
  const hasFill   = !!fill   && fill   !== 'none' && fill   !== 'transparent' && fill   !== 'rgba(0, 0, 0, 0)';
  if (!hasStroke && !hasFill) return null;

  // CTM relative to the host SVG (= the element's local-to-root transform).
  const ctm = (typeof el.getCTM === 'function' ? el.getCTM() : null) ?? new DOMMatrixReadOnly();

  // Stroke width in element-local units; computed style returns px in
  // SVG user-space (= viewBox units when we're not nested inside CSS-
  // sized container). Multiply by sqrt(|det(CTM)|) for the linear scale
  // factor (= average scale; correct for uniform CTM, an approximation
  // for non-uniform).
  const swLocalRaw = parseFloat(styles.strokeWidth);
  const swLocal = Number.isFinite(swLocalRaw) && swLocalRaw > 0 ? swLocalRaw : 1;
  const det = Math.abs(ctm.a * ctm.d - ctm.b * ctm.c);
  const linearScale = det > 0 ? Math.sqrt(det) : 1;
  const strokeWidth = swLocal * linearScale;

  const linecap = normalizeLinecap(styles.strokeLinecap);
  const linejoin = normalizeLinejoin(styles.strokeLinejoin);

  const subpathsLocal = extractElementSubpathsLocal(el);
  if (subpathsLocal.length === 0) return null;

  const subpaths = subpathsLocal.map(sub => ({
    points: sub.points.map(p => transformPoint(ctm, p)),
    closed: sub.closed,
  }));

  return {
    zIndex,
    subpaths,
    hasStroke,
    strokeWidth,
    strokeLinecap: linecap,
    strokeLinejoin: linejoin,
    hasFill,
  };
}

function transformPoint(m: DOMMatrixReadOnly, p: Point): Point {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

function normalizeLinecap(s: string | null | undefined): LineCap {
  const v = (s ?? '').toLowerCase();
  return v === 'round' ? 'round' : v === 'square' ? 'square' : 'butt';
}
function normalizeLinejoin(s: string | null | undefined): LineJoin {
  const v = (s ?? '').toLowerCase();
  return v === 'round' ? 'round' : v === 'bevel' ? 'bevel' : 'miter';
}

function extractElementSubpathsLocal(el: SVGGraphicsElement): { points: Point[]; closed: boolean }[] {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d') ?? '';
      return d ? svgPathToPolylines(d) : [];
    }
    case 'polyline':
    case 'polygon': {
      const pts = pointsAttrToPolyline(el.getAttribute('points') ?? '');
      if (pts.length < 2) return [];
      return [{ points: pts, closed: tag === 'polygon' }];
    }
    case 'rect': {
      const x = parseFloat(el.getAttribute('x') ?? '0');
      const y = parseFloat(el.getAttribute('y') ?? '0');
      const w = parseFloat(el.getAttribute('width') ?? '0');
      const h = parseFloat(el.getAttribute('height') ?? '0');
      if (!(w > 0) || !(h > 0)) return [];
      return [{
        points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
        closed: true,
      }];
    }
    case 'circle': {
      const cx = parseFloat(el.getAttribute('cx') ?? '0');
      const cy = parseFloat(el.getAttribute('cy') ?? '0');
      const r  = parseFloat(el.getAttribute('r')  ?? '0');
      if (!(r > 0)) return [];
      return [{ points: ringSamples(cx, cy, r, r), closed: true }];
    }
    case 'ellipse': {
      const cx = parseFloat(el.getAttribute('cx') ?? '0');
      const cy = parseFloat(el.getAttribute('cy') ?? '0');
      const rx = parseFloat(el.getAttribute('rx') ?? '0');
      const ry = parseFloat(el.getAttribute('ry') ?? '0');
      if (!(rx > 0) || !(ry > 0)) return [];
      return [{ points: ringSamples(cx, cy, rx, ry), closed: true }];
    }
    case 'line': {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');
      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');
      return [{ points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false }];
    }
  }
  return [];
}

function ringSamples(cx: number, cy: number, rx: number, ry: number, segments: number = 64): Point[] {
  const out: Point[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out[i] = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  }
  return out;
}

function pointsAttrToPolyline(s: string): Point[] {
  const nums: number[] = [];
  for (const m of s.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) nums.push(parseFloat(m[0]));
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
  return out;
}

/**
 * Parse `d` attribute into a list of subpaths with closed flag.
 * Same algorithm as `polygonStrokeExtraction.ts` — duplicated here
 * to keep this module DOM-only with minimal cross-imports.
 */
function svgPathToPolylines(d: string, flatness: number = FLATNESS): { points: Point[]; closed: boolean }[] {
  const sp = svgpath(d).abs().unarc().unshort();
  const err = (sp as unknown as { err?: string | null }).err;
  if (err) return [];

  const out: { points: Point[]; closed: boolean }[] = [];
  let cur: Point[] | null = null;
  let startX = 0, startY = 0;

  const flushAsOpen = () => {
    if (cur && cur.length >= 2) out.push({ points: cur, closed: false });
    cur = null;
  };

  const m = (a: Point, b: Point): Point => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
  const flatCubic = (p0: Point, p1: Point, p2: Point, p3: Point, target: Point[]): void => {
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
      d1 = (p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2;
      d2 = (p2.x - p0.x) ** 2 + (p2.y - p0.y) ** 2;
    }
    const f2 = flatness * flatness;
    if (d1 <= f2 && d2 <= f2) {
      target.push({ x: p3.x, y: p3.y });
      return;
    }
    const m01 = m(p0, p1), m12 = m(p1, p2), m23 = m(p2, p3);
    const m012 = m(m01, m12), m123 = m(m12, m23);
    const m0123 = m(m012, m123);
    flatCubic(p0, m01, m012, m0123, target);
    flatCubic(m0123, m123, m23, p3, target);
  };
  const flatQuad = (p0: Point, p1: Point, p2: Point, target: Point[]): void => {
    const c1: Point = { x: p0.x + (2 / 3) * (p1.x - p0.x), y: p0.y + (2 / 3) * (p1.y - p0.y) };
    const c2: Point = { x: p2.x + (2 / 3) * (p1.x - p2.x), y: p2.y + (2 / 3) * (p1.y - p2.y) };
    flatCubic(p0, c1, c2, p2, target);
  };

  sp.iterate((seg, _i, x, y) => {
    const cmd = seg[0] as string;
    switch (cmd) {
      case 'M': {
        flushAsOpen();
        cur = [];
        const mx = seg[1] as number, my = seg[2] as number;
        cur.push({ x: mx, y: my });
        startX = mx; startY = my;
        break;
      }
      case 'L':
        if (!cur) cur = [{ x, y }];
        cur.push({ x: seg[1] as number, y: seg[2] as number });
        break;
      case 'H':
        if (!cur) cur = [{ x, y }];
        cur.push({ x: seg[1] as number, y });
        break;
      case 'V':
        if (!cur) cur = [{ x, y }];
        cur.push({ x, y: seg[1] as number });
        break;
      case 'C':
        if (!cur) cur = [{ x, y }];
        flatCubic(
          { x, y },
          { x: seg[1] as number, y: seg[2] as number },
          { x: seg[3] as number, y: seg[4] as number },
          { x: seg[5] as number, y: seg[6] as number },
          cur,
        );
        break;
      case 'Q':
        if (!cur) cur = [{ x, y }];
        flatQuad(
          { x, y },
          { x: seg[1] as number, y: seg[2] as number },
          { x: seg[3] as number, y: seg[4] as number },
          cur,
        );
        break;
      case 'Z':
      case 'z': {
        if (cur && cur.length > 0) {
          const last = cur[cur.length - 1];
          if (last.x === startX && last.y === startY) cur.pop();
          if (cur.length >= 2) out.push({ points: cur, closed: true });
        }
        cur = null;
        break;
      }
    }
  });
  flushAsOpen();
  return out;
}
