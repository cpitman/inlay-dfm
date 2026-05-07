/**
 * Polygon-native stroke layer extraction. Two entry points:
 *
 *   - `extractStrokesPolygonViaFlatten(svgText)` — runtime path.
 *     Pre-flattens the SVG via the browser DOM (`svgFlatten.ts`)
 *     to resolve `transform`, `<g>` inheritance, and CSS
 *     stylesheets, then runs the same processing as below.
 *
 *   - `extractStrokesPolygon(svgText)` — Node-friendly fallback.
 *     Regex-parses the SVG element-by-element. Does NOT resolve
 *     transforms / group inheritance / CSS — only safe on
 *     pre-flattened SVGs (= what the tests use).
 *
 * Both feed `processStrokeElements`, which:
 *   1. For each stroked element, offsets the polyline by `width/2`
 *      via Clipper to produce its stroke band.
 *   2. Walks top-down (= reverse z-order), accumulating a "covered
 *      from above" buffer. Each stroke's visible part = band minus
 *      the buffer; each element's fill + stroke contributes to the
 *      buffer for elements drawn before it.
 *
 * Output:
 *   - `allStrokesMP`: union of every stroke band, regardless of
 *     visibility. The "stroke layer" the inlay flow will inlay at
 *     z-index 0.
 *   - `visibleStrokesMP`: stroke pixels topmost in z-order. Used to
 *     punch through the fill layers when the user opts to inlay
 *     strokes (so the outline visibly pierces through fills).
 */

import svgpath from 'svgpath';
import {
  canonicalizeRings,
  multiPolygonOffsetClosedLine,
  multiPolygonOffsetOpenPolyline,
  multiPolygonDifference,
  multiPolygonUnion,
  multiPolygonUnionAll,
} from './clipperOps';
import {
  multiPolygonIsEmpty,
  type MultiPolygon,
  type Point,
  type Ring,
} from './polygon';

/** Bezier-flattening tolerance for polyline conversion. Same as polygonParser. */
const FLATNESS = 0.05;

type LineCap = 'butt' | 'square' | 'round';
type LineJoin = 'miter' | 'round' | 'bevel';
type FillRule = 'nonzero' | 'evenodd';

export interface ParsedSvgElement {
  /** Document-order index. */
  zIndex: number;
  /** Subpaths as polylines. Each has an open/closed flag. */
  subpaths: { points: Point[]; closed: boolean }[];
  hasStroke: boolean;
  strokeWidth: number;
  strokeLinecap: LineCap;
  strokeLinejoin: LineJoin;
  /** True iff the element has a non-`none` fill. */
  hasFill: boolean;
  /** Fill-rule for canonicalizing overlapping subpaths (default nonzero). */
  fillRule: FillRule;
}

/**
 * Parse `d` attribute into a list of subpaths with closed flag.
 * Mirrors `svgPathToRings` but does NOT drop trailing open subpaths
 * — the caller wants to know which subpaths are open vs closed.
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

  // Replicate the cubic flattener inline rather than importing the
  // one in polygonParser (it's not exported).
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
    const m = (a: Point, b: Point): Point => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
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
      case 'C': {
        if (!cur) cur = [{ x, y }];
        flatCubic(
          { x, y },
          { x: seg[1] as number, y: seg[2] as number },
          { x: seg[3] as number, y: seg[4] as number },
          { x: seg[5] as number, y: seg[6] as number },
          cur,
        );
        break;
      }
      case 'Q': {
        if (!cur) cur = [{ x, y }];
        flatQuad(
          { x, y },
          { x: seg[1] as number, y: seg[2] as number },
          { x: seg[3] as number, y: seg[4] as number },
          cur,
        );
        break;
      }
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

/** Parse a CSS-like inline `style` attribute. Returns key→value, all lower-case keys. */
function parseInlineStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Extract attribute or style-attribute value. Returns undefined when absent. */
function readStyledAttr(attrs: Record<string, string>, style: Record<string, string>, name: string): string | undefined {
  return attrs[name] ?? style[name];
}

const SHAPE_REGEX = /<(path|polyline|polygon|rect|circle|ellipse|line)\b([^>]*)\/?>/gi;
const ATTR_REGEX = /([a-zA-Z_:][a-zA-Z0-9_:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function extractAttributes(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tagBody.matchAll(ATTR_REGEX)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? '';
    out[name] = value;
  }
  return out;
}

function pointsAttrToPolyline(s: string): Point[] {
  const nums: number[] = [];
  for (const m of s.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    nums.push(parseFloat(m[0]));
  }
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push({ x: nums[i], y: nums[i + 1] });
  }
  return out;
}

function rectAsPolyline(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
}

function circleAsPolyline(cx: number, cy: number, r: number, segments: number = 64): Point[] {
  const out: Point[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out[i] = { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  }
  return out;
}

function ellipseAsPolyline(cx: number, cy: number, rx: number, ry: number, segments: number = 64): Point[] {
  const out: Point[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out[i] = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  }
  return out;
}

/**
 * Walk the SVG in document order, returning the parsed elements
 * with their stroke + fill metadata. Element order is preserved
 * so callers can reason about z-stacking (later in the array =
 * drawn on top).
 *
 * Element-attribute resolution is element-local — inheritance from
 * `<g>` ancestors is NOT resolved. Real SVGs from typical clipart
 * sources put per-element styling at the element itself; if a
 * design needs group inheritance the caller can preprocess the SVG
 * (svgo, etc.) to inline group attributes.
 */
export function parseSvgStrokeElements(svgText: string): ParsedSvgElement[] {
  const out: ParsedSvgElement[] = [];
  let zIndex = 0;
  for (const m of svgText.matchAll(SHAPE_REGEX)) {
    const tag = m[1].toLowerCase();
    const attrs = extractAttributes(m[2]);
    const style = parseInlineStyle(attrs['style'] ?? '');

    const strokeRaw = readStyledAttr(attrs, style, 'stroke');
    const stroke = (strokeRaw ?? '').trim().toLowerCase();
    const hasStroke = !!stroke && stroke !== 'none' && stroke !== 'transparent';
    const strokeWidthRaw = readStyledAttr(attrs, style, 'stroke-width');
    const strokeWidth = strokeWidthRaw ? parseFloat(strokeWidthRaw) : 1;

    const fillRaw = readStyledAttr(attrs, style, 'fill');
    const fill = (fillRaw ?? '').trim().toLowerCase();
    // Default SVG fill is black; treat absence as filled unless explicitly 'none'.
    const hasFill = fill !== 'none' && fill !== 'transparent';

    const linecapRaw = (readStyledAttr(attrs, style, 'stroke-linecap') ?? 'butt').toLowerCase();
    const strokeLinecap: LineCap = linecapRaw === 'round' ? 'round'
                                 : linecapRaw === 'square' ? 'square'
                                 : 'butt';
    const linejoinRaw = (readStyledAttr(attrs, style, 'stroke-linejoin') ?? 'miter').toLowerCase();
    const strokeLinejoin: LineJoin = linejoinRaw === 'round' ? 'round'
                                   : linejoinRaw === 'bevel' ? 'bevel'
                                   : 'miter';
    const fillRuleRaw = (readStyledAttr(attrs, style, 'fill-rule') ?? 'nonzero').toLowerCase();
    const fillRule: FillRule = fillRuleRaw === 'evenodd' ? 'evenodd' : 'nonzero';

    let subpaths: { points: Point[]; closed: boolean }[] = [];
    switch (tag) {
      case 'path': {
        const d = attrs['d'] ?? '';
        if (d) subpaths = svgPathToPolylines(d);
        break;
      }
      case 'polyline': {
        const pts = pointsAttrToPolyline(attrs['points'] ?? '');
        if (pts.length >= 2) subpaths = [{ points: pts, closed: false }];
        break;
      }
      case 'polygon': {
        const pts = pointsAttrToPolyline(attrs['points'] ?? '');
        if (pts.length >= 3) subpaths = [{ points: pts, closed: true }];
        break;
      }
      case 'rect': {
        const x = parseFloat(attrs['x'] ?? '0');
        const y = parseFloat(attrs['y'] ?? '0');
        const w = parseFloat(attrs['width'] ?? '0');
        const h = parseFloat(attrs['height'] ?? '0');
        if (w > 0 && h > 0) subpaths = [{ points: rectAsPolyline(x, y, w, h), closed: true }];
        break;
      }
      case 'circle': {
        const cx = parseFloat(attrs['cx'] ?? '0');
        const cy = parseFloat(attrs['cy'] ?? '0');
        const r  = parseFloat(attrs['r']  ?? '0');
        if (r > 0) subpaths = [{ points: circleAsPolyline(cx, cy, r), closed: true }];
        break;
      }
      case 'ellipse': {
        const cx = parseFloat(attrs['cx'] ?? '0');
        const cy = parseFloat(attrs['cy'] ?? '0');
        const rx = parseFloat(attrs['rx'] ?? '0');
        const ry = parseFloat(attrs['ry'] ?? '0');
        if (rx > 0 && ry > 0) subpaths = [{ points: ellipseAsPolyline(cx, cy, rx, ry), closed: true }];
        break;
      }
      case 'line': {
        const x1 = parseFloat(attrs['x1'] ?? '0');
        const y1 = parseFloat(attrs['y1'] ?? '0');
        const x2 = parseFloat(attrs['x2'] ?? '0');
        const y2 = parseFloat(attrs['y2'] ?? '0');
        subpaths = [{ points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false }];
        break;
      }
    }

    if (subpaths.length === 0) continue;

    out.push({
      zIndex: zIndex++,
      subpaths,
      hasStroke,
      strokeWidth,
      strokeLinecap,
      strokeLinejoin,
      hasFill,
      fillRule,
    });
  }
  return out;
}

/** Compute the stroke band for one parsed element via Clipper offset. */
function elementStrokeBand(el: ParsedSvgElement): MultiPolygon {
  if (!el.hasStroke || el.strokeWidth <= 0) return [];
  const halfW = el.strokeWidth / 2;
  const bands: MultiPolygon[] = [];
  for (const sub of el.subpaths) {
    if (sub.points.length < 2) continue;
    if (sub.closed) {
      const band = multiPolygonOffsetClosedLine(sub.points as Ring, halfW, {
        joinType: el.strokeLinejoin === 'round' ? 'round'
                 : el.strokeLinejoin === 'bevel' ? 'square'
                 : 'miter',
      });
      if (!multiPolygonIsEmpty(band)) bands.push(band);
    } else {
      const band = multiPolygonOffsetOpenPolyline(sub.points as Ring, halfW, {
        endType: el.strokeLinecap,
        joinType: el.strokeLinejoin === 'round' ? 'round'
                 : el.strokeLinejoin === 'bevel' ? 'square'
                 : 'miter',
      });
      if (!multiPolygonIsEmpty(band)) bands.push(band);
    }
  }
  return bands.length === 0 ? [] : multiPolygonUnionAll(bands);
}

/**
 * Compute the fill polygon for one parsed element (closed subpaths
 * only). Canonicalizes via the element's fill-rule so two CCW
 * overlapping subpaths inside one nonzero `<path>` UNION (matching
 * the browser's render) instead of XOR-ing.
 */
function elementFillPolygon(el: ParsedSvgElement): MultiPolygon {
  if (!el.hasFill) return [];
  const rings: Ring[] = [];
  for (const sub of el.subpaths) {
    if (sub.closed && sub.points.length >= 3) rings.push(sub.points as Ring);
  }
  if (rings.length === 0) return [];
  return canonicalizeRings(rings, el.fillRule);
}

export interface PolygonStrokeExtractionResult {
  /** Union of every stroke band, regardless of visibility. */
  allStrokesMP: MultiPolygon;
  /** Stroke pixels topmost in z-order. */
  visibleStrokesMP: MultiPolygon;
}

/**
 * Pure: walk a list of parsed (= already flattened, attribute-
 * resolved, transform-applied) elements top-down, accumulating
 * all-strokes and visible-strokes. Both the regex parser and the
 * DOM flattener feed this.
 */
export function processStrokeElements(elements: readonly ParsedSvgElement[]): PolygonStrokeExtractionResult {
  const allStrokesParts: MultiPolygon[] = [];
  const visibleParts: MultiPolygon[] = [];
  let coveredFromAbove: MultiPolygon = [];

  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const band = elementStrokeBand(el);
    if (!multiPolygonIsEmpty(band)) {
      allStrokesParts.push(band);
      const visiblePart = multiPolygonIsEmpty(coveredFromAbove)
        ? band
        : multiPolygonDifference(band, coveredFromAbove);
      if (!multiPolygonIsEmpty(visiblePart)) visibleParts.push(visiblePart);
      coveredFromAbove = multiPolygonIsEmpty(coveredFromAbove)
        ? band
        : multiPolygonUnion(coveredFromAbove, band);
    }
    const fill = elementFillPolygon(el);
    if (!multiPolygonIsEmpty(fill)) {
      coveredFromAbove = multiPolygonIsEmpty(coveredFromAbove)
        ? fill
        : multiPolygonUnion(coveredFromAbove, fill);
    }
  }

  return {
    allStrokesMP: allStrokesParts.length === 0 ? [] : multiPolygonUnionAll(allStrokesParts),
    visibleStrokesMP: visibleParts.length === 0 ? [] : multiPolygonUnionAll(visibleParts),
  };
}

/**
 * Sync regex-based extraction. Does NOT resolve transforms / group
 * inheritance / CSS — only safe on pre-flattened SVGs. Used by
 * tests; runtime should call `extractStrokesPolygonViaFlatten`.
 */
export function extractStrokesPolygon(svgText: string): PolygonStrokeExtractionResult {
  return processStrokeElements(parseSvgStrokeElements(svgText));
}

/**
 * Async DOM-based extraction. Pre-flattens the SVG via
 * `flattenSvg` (browser-only) so transforms, group inheritance,
 * and CSS stylesheets are all resolved before processing. Use this
 * at runtime.
 */
export async function extractStrokesPolygonViaFlatten(svgText: string): Promise<PolygonStrokeExtractionResult> {
  const { flattenSvg } = await import('./svgFlatten');
  const flattened = await flattenSvg(svgText);
  const elements: ParsedSvgElement[] = flattened.map(f => ({
    zIndex: f.zIndex,
    subpaths: f.subpaths,
    hasStroke: f.hasStroke,
    strokeWidth: f.strokeWidth,
    strokeLinecap: f.strokeLinecap,
    strokeLinejoin: f.strokeLinejoin,
    hasFill: f.hasFill,
    fillRule: f.fillRule,
  }));
  return processStrokeElements(elements);
}
