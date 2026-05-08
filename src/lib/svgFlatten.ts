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

const SHAPE_TAGS_LIST = ['path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'line'] as const;

const ATTRS_TO_DROP_AFTER_BAKE = new Set([
  'd', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry',
  'x1', 'y1', 'x2', 'y2', 'points', 'transform',
]);

/**
 * Resolve an SVG presentation attribute by walking element + ancestor
 * attributes / inline styles up to (and including) the nearest `<svg>`.
 * Returns the closest defined value, or null if none.
 *
 * Why not just use `getComputedStyle`? In a 0-sized hidden host the
 * SVG can end up un-laid-out, and some browsers then return CSS
 * defaults instead of resolving inherited values. SVG presentation
 * attributes (stroke, stroke-width, fill-rule, etc.) inherit by
 * spec; walking the ancestor chain explicitly is bulletproof and
 * doesn't depend on layout.
 */
function readSvgPresentationAttr(el: Element, name: string): string | null {
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1) {
    const styleAttr = cur.getAttribute('style');
    if (styleAttr) {
      const re = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i');
      const m = styleAttr.match(re);
      if (m) return m[1].trim();
    }
    const v = cur.getAttribute(name);
    if (v !== null && v.length > 0) return v;
    if (cur.tagName.toLowerCase() === 'svg') break;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Convert one SVG shape element into an equivalent path-`d` string.
 * Used by the transform-baking step to turn `<rect>` / `<circle>` /
 * etc. into `<path>` so the CTM can be applied via svgpath.
 */
function shapeToPathD(el: SVGGraphicsElement): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'path':
      return el.getAttribute('d') ?? '';
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '')
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(parseFloat);
      if (pts.length < 4) return '';
      let d = `M ${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
      if (tag === 'polygon') d += ' Z';
      return d;
    }
    case 'line': {
      const x1 = parseFloat(el.getAttribute('x1') ?? '0');
      const y1 = parseFloat(el.getAttribute('y1') ?? '0');
      const x2 = parseFloat(el.getAttribute('x2') ?? '0');
      const y2 = parseFloat(el.getAttribute('y2') ?? '0');
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    case 'rect': {
      const x = parseFloat(el.getAttribute('x') ?? '0');
      const y = parseFloat(el.getAttribute('y') ?? '0');
      const w = parseFloat(el.getAttribute('width') ?? '0');
      const h = parseFloat(el.getAttribute('height') ?? '0');
      if (!(w > 0) || !(h > 0)) return '';
      return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
    }
    case 'circle': {
      const cx = parseFloat(el.getAttribute('cx') ?? '0');
      const cy = parseFloat(el.getAttribute('cy') ?? '0');
      const r  = parseFloat(el.getAttribute('r')  ?? '0');
      if (!(r > 0)) return '';
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    }
    case 'ellipse': {
      const cx = parseFloat(el.getAttribute('cx') ?? '0');
      const cy = parseFloat(el.getAttribute('cy') ?? '0');
      const rx = parseFloat(el.getAttribute('rx') ?? '0');
      const ry = parseFloat(el.getAttribute('ry') ?? '0');
      if (!(rx > 0) || !(ry > 0)) return '';
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }
  }
  return '';
}

/**
 * Resolve `<use>` references in-place, deep-cloning each target into
 * the document tree at the `<use>`'s position. Repeats up to
 * `maxDepth` times so a target that itself references another
 * `<use>` resolves cleanly. Drops cycles (an unresolved `<use>` in
 * the final pass is removed). Browser-only — relies on
 * `querySelector` + `cloneNode`.
 *
 * The `<use>` element's translation (`x`/`y` attrs) and `transform`
 * attr are composed onto a wrapper `<g>` carrying the cloned
 * subtree. Presentation attrs (fill, stroke, …) on the `<use>`
 * cascade onto the wrapper so they affect the cloned geometry the
 * same way the browser would render it.
 *
 * Animation children (`<animate>`, `<animateTransform>`,
 * `<animateMotion>`, `<set>`) are stripped from the cloned tree —
 * we want a static t=0 snapshot for inlay, not an animated one.
 *
 * Cloned `id` attributes are stripped to avoid duplicating ids in
 * the document (which would break a later `getElementById` lookup
 * if the SVG happened to chain `<use>` references).
 */
function expandUseReferences(svg: SVGSVGElement, maxDepth = 10): void {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const ANIMATION_TAGS = 'animate, animateTransform, animateMotion, set';
  const PASSTHROUGH_SKIP = new Set(['href', 'xlink:href', 'x', 'y', 'transform', 'width', 'height']);

  for (let depth = 0; depth < maxDepth; depth++) {
    const uses = Array.from(svg.querySelectorAll('use')) as SVGUseElement[];
    if (uses.length === 0) return;
    for (const use of uses) {
      const href = use.getAttribute('href') ?? use.getAttributeNS(XLINK_NS, 'href') ?? '';
      const parent = use.parentNode;
      if (!parent) continue;
      if (!href.startsWith('#')) {
        // External references unsupported (and rarely used in clipart).
        parent.removeChild(use);
        continue;
      }
      const targetId = href.slice(1);
      const target = svg.querySelector(`[id="${cssEscape(targetId)}"]`);
      if (!target) {
        parent.removeChild(use);
        continue;
      }

      const wrapper = document.createElementNS(SVG_NS, 'g');
      const x = parseFloat(use.getAttribute('x') ?? '0') || 0;
      const y = parseFloat(use.getAttribute('y') ?? '0') || 0;
      const useTransform = use.getAttribute('transform') ?? '';
      const composed = (x !== 0 || y !== 0)
        ? `translate(${x},${y}) ${useTransform}`.trim()
        : useTransform;
      if (composed) wrapper.setAttribute('transform', composed);
      // Copy presentation attrs from the <use> onto the wrapper so
      // they cascade to the cloned subtree.
      for (const attr of Array.from(use.attributes)) {
        const lower = attr.name.toLowerCase();
        if (PASSTHROUGH_SKIP.has(lower)) continue;
        wrapper.setAttribute(attr.name, attr.value);
      }

      // Per SVG spec, `<use>` deep-clones the target's subtree.
      // For container targets (`<g>`, `<symbol>`), lift their children
      // into the wrapper so the wrapper acts as the cloned container.
      // For leaf targets (`<path>`, `<rect>`, …), append the clone
      // itself.
      const clone = target.cloneNode(true) as Element;
      const tag = clone.tagName.toLowerCase();
      if (tag === 'g' || tag === 'symbol') {
        clone.removeAttribute('display'); // <defs> targets are often display:none
        for (const child of Array.from(clone.childNodes)) wrapper.appendChild(child);
      } else {
        wrapper.appendChild(clone);
      }

      // Static snapshot: drop animation drivers from the cloned tree.
      for (const anim of Array.from(wrapper.querySelectorAll(ANIMATION_TAGS))) {
        anim.parentNode?.removeChild(anim);
      }
      // Avoid duplicating ids from the cloned subtree (would clash
      // with the original target's id and confuse later lookups).
      for (const idEl of Array.from(wrapper.querySelectorAll('[id]'))) {
        idEl.removeAttribute('id');
      }

      parent.replaceChild(wrapper, use);
    }
  }
  // Final pass: remove any <use> elements still left after maxDepth
  // (= a cycle, or chain longer than maxDepth).
  for (const use of Array.from(svg.querySelectorAll('use'))) {
    use.parentNode?.removeChild(use);
  }
}

/** True iff the element (or any ancestor) has `display="none"`. */
function isDisplayNone(el: Element): boolean {
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== 'svg') {
    if (cur.getAttribute('display') === 'none') return true;
    cur = cur.parentElement;
  }
  return false;
}

/** Minimal CSS.escape fallback for ids that contain unusual chars. */
function cssEscape(s: string): string {
  // CSS.escape is widely supported, but guarded here for old browsers
  // and the headless environments tests run in.
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

/**
 * In-place: walk every leaf shape under `svg`, apply its CTM to the
 * geometry, and replace the element with a `<path>` carrying the
 * transformed `d`. After this runs, no `<g transform>` wrapper is
 * needed for any descendant shape — its coordinates are absolute in
 * the root SVG's user space.
 *
 * Browser-only — `getCTM()` requires `svg` to be in the live DOM.
 * Mounts hidden, walks, restores. The original SVGSVGElement is
 * left detached from the document but otherwise functional for
 * subsequent DOM ops (querySelectorAll, attribute reads, etc.).
 */
export async function bakeSvgTransforms(svg: SVGSVGElement): Promise<void> {
  if (typeof document === 'undefined') {
    throw new Error('bakeSvgTransforms requires a browser DOM');
  }

  const host = document.createElement('div');
  // Allow the SVG to lay out at its intrinsic size — `width:0;height:0`
  // can collapse viewport→user-coord scale to 0 in some browsers,
  // which then makes `getCTM()` return a scale-0 matrix and
  // `getComputedStyle().strokeWidth` resolve to defaults instead of
  // inherited values. `visibility:hidden` + offscreen position keeps
  // the layout off-screen without breaking style/CTM resolution.
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
  document.body.appendChild(host);

  const originalParent = svg.parentNode;
  const originalNext = svg.nextSibling;
  // When the source SVG carries CSS-unit width/height ("190.5mm",
  // "10in", etc.), the browser renders into a device-pixel viewport
  // whose dimensions scale independently of the viewBox. `getCTM()`
  // then returns matrices in that pixel space, NOT in viewBox space
  // — so baking the CTM into path `d` attributes lands the geometry
  // outside the SVG's stored viewBox. Force width/height to the
  // viewBox's numeric extents so the viewport-to-viewBox scale is
  // 1:1, and getCTM matrices are in viewBox coords. Restore at the
  // end in case downstream code reads the original attrs.
  const origWidth = svg.getAttribute('width');
  const origHeight = svg.getAttribute('height');
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0 && Number.isFinite(parts[3]) && parts[3] > 0) {
      svg.setAttribute('width', String(parts[2]));
      svg.setAttribute('height', String(parts[3]));
    }
  }
  host.appendChild(svg);
  void svg.getBoundingClientRect();

  try {
    // Expand <use href="#id"> references first so the shape walk
    // below sees the inlined geometry. Without this, SVGs that build
    // their visible content via <defs> + <use> instances (e.g.
    // OpenClipart "animation" tiles) collapse to whatever non-<use>
    // shapes happen to be in the document — typically a backdrop
    // rectangle, leaving the user with a blank-looking import.
    expandUseReferences(svg);

    const shapes = Array.from(svg.querySelectorAll(SHAPE_TAGS_LIST.join(','))) as SVGGraphicsElement[];
    for (const el of shapes) {
      // Respect display:none — SVGs commonly tuck "hidden helper"
      // paths inside <defs> or behind a display="none" attribute,
      // and lifting them out via <use> expansion would otherwise
      // pull them in as visible geometry.
      if (isDisplayNone(el)) continue;
      const ctm = (typeof el.getCTM === 'function' ? el.getCTM() : null);
      const d = shapeToPathD(el);
      if (!d) continue;
      const finalD = ctm
        ? svgpath(d).transform(`matrix(${ctm.a} ${ctm.b} ${ctm.c} ${ctm.d} ${ctm.e} ${ctm.f})`).toString()
        : d;
      // Resolve inherited SVG presentation attrs (fill-rule + the
      // stroke styling) via ancestor walk so they survive the
      // wrapper-stripping. Copying just element-local attrs would
      // silently drop attributes set on a `<g>` ancestor — Pika's
      // strokes use `<g stroke-width="3" stroke="…">` wrapping.
      const inheritedFillRule  = readSvgPresentationAttr(el, 'fill-rule');
      const inheritedStroke    = readSvgPresentationAttr(el, 'stroke');
      const inheritedStrokeW   = readSvgPresentationAttr(el, 'stroke-width');
      const inheritedLinecap   = readSvgPresentationAttr(el, 'stroke-linecap');
      const inheritedLinejoin  = readSvgPresentationAttr(el, 'stroke-linejoin');

      // CTM linear scale: bake into stroke-width so a transform with
      // non-unit scale doesn't render thinner / thicker after wrapper-
      // stripping. For pure translate (Pika) this is 1.
      const det = ctm ? Math.abs(ctm.a * ctm.d - ctm.b * ctm.c) : 1;
      const linearScale = det > 0 ? Math.sqrt(det) : 1;

      const newPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      newPath.setAttribute('d', finalD);
      // Copy element-local attributes (drop geometry-defining + transform; preserve fill/stroke/style/etc.).
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (ATTRS_TO_DROP_AFTER_BAKE.has(name)) continue;
        newPath.setAttribute(attr.name, attr.value);
      }
      // Bake inherited presentation attrs onto the new path when not
      // already explicit. Setting them all explicitly makes the leaf
      // self-contained, independent of any surviving `<g>` ancestor.
      if (!newPath.hasAttribute('fill-rule') && inheritedFillRule) {
        const v = inheritedFillRule.toLowerCase();
        newPath.setAttribute('fill-rule', v === 'evenodd' ? 'evenodd' : 'nonzero');
      }
      if (!newPath.hasAttribute('stroke') && inheritedStroke) {
        newPath.setAttribute('stroke', inheritedStroke);
      }
      if (!newPath.hasAttribute('stroke-width') && inheritedStrokeW) {
        const swRaw = parseFloat(inheritedStrokeW);
        if (Number.isFinite(swRaw) && swRaw > 0) {
          newPath.setAttribute('stroke-width', String(swRaw * linearScale));
        }
      } else if (newPath.hasAttribute('stroke-width') && linearScale !== 1) {
        const swRaw = parseFloat(newPath.getAttribute('stroke-width') ?? '');
        if (Number.isFinite(swRaw) && swRaw > 0) {
          newPath.setAttribute('stroke-width', String(swRaw * linearScale));
        }
      }
      if (!newPath.hasAttribute('stroke-linecap') && inheritedLinecap) {
        newPath.setAttribute('stroke-linecap', inheritedLinecap);
      }
      if (!newPath.hasAttribute('stroke-linejoin') && inheritedLinejoin) {
        newPath.setAttribute('stroke-linejoin', inheritedLinejoin);
      }
      el.parentNode?.replaceChild(newPath, el);
    }
    // Strip transform attributes from groups (now redundant — children have absolute coords).
    const groups = Array.from(svg.querySelectorAll('g')) as SVGGElement[];
    for (const g of groups) {
      if (g.hasAttribute('transform')) g.removeAttribute('transform');
    }
  } finally {
    host.removeChild(svg);
    document.body.removeChild(host);
    // Restore original width/height attrs (the bake forced them
    // to viewBox-numeric values to fix CTM scale).
    if (origWidth === null) svg.removeAttribute('width');
    else svg.setAttribute('width', origWidth);
    if (origHeight === null) svg.removeAttribute('height');
    else svg.setAttribute('height', origHeight);
    // Restore the SVG to its original parent if it had one, in case the caller cares.
    if (originalParent) originalParent.insertBefore(svg, originalNext);
  }
}

type LineCap = 'butt' | 'square' | 'round';
type LineJoin = 'miter' | 'round' | 'bevel';
type FillRule = 'nonzero' | 'evenodd';

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
  /** Resolved fill-rule (default nonzero). */
  fillRule: FillRule;
}

/** Flatten an SVG to a list of leaf shapes with resolved styling and absolute coordinates. */
export async function flattenSvg(svgText: string): Promise<FlattenedSvgElement[]> {
  if (typeof document === 'undefined') {
    throw new Error('flattenSvg requires a browser DOM (use parseSvgStrokeElements for Node).');
  }

  const host = document.createElement('div');
  // Allow the SVG to lay out at its intrinsic size — `width:0;height:0`
  // can collapse viewport→user-coord scale to 0 in some browsers,
  // which then makes `getCTM()` return a scale-0 matrix and
  // `getComputedStyle().strokeWidth` resolve to defaults instead of
  // inherited values. `visibility:hidden` + offscreen position keeps
  // the layout off-screen without breaking style/CTM resolution.
  host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
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
  // Read SVG presentation attrs via ancestor walk so inherited
  // stroke-width / fill-rule / etc. resolve correctly regardless
  // of whether the host is laid out. Fall back to getComputedStyle
  // for properties that might come from a `<style>` block (= true
  // CSS, not attribute inheritance).
  const styles = window.getComputedStyle(el);
  const stroke = (readSvgPresentationAttr(el, 'stroke') ?? styles.stroke ?? '').toLowerCase();
  const fill   = (readSvgPresentationAttr(el, 'fill')   ?? styles.fill   ?? '').toLowerCase();
  const hasStroke = !!stroke && stroke !== 'none' && stroke !== 'transparent' && stroke !== 'rgba(0, 0, 0, 0)';
  const hasFill   = !!fill   && fill   !== 'none' && fill   !== 'transparent' && fill   !== 'rgba(0, 0, 0, 0)';
  if (!hasStroke && !hasFill) return null;

  // CTM relative to the host SVG (= the element's local-to-root transform).
  const ctm = (typeof el.getCTM === 'function' ? el.getCTM() : null) ?? new DOMMatrixReadOnly();

  // Stroke width in element-local units. Multiply by sqrt(|det(CTM)|)
  // for the linear scale factor (= average scale; correct for uniform
  // CTM, an approximation for non-uniform).
  const swRaw = readSvgPresentationAttr(el, 'stroke-width') ?? styles.strokeWidth;
  const swLocalRaw = parseFloat(swRaw);
  const swLocal = Number.isFinite(swLocalRaw) && swLocalRaw > 0 ? swLocalRaw : 1;
  const det = Math.abs(ctm.a * ctm.d - ctm.b * ctm.c);
  const linearScale = det > 0 ? Math.sqrt(det) : 1;
  const strokeWidth = swLocal * linearScale;

  const linecap = normalizeLinecap(readSvgPresentationAttr(el, 'stroke-linecap') ?? styles.strokeLinecap);
  const linejoin = normalizeLinejoin(readSvgPresentationAttr(el, 'stroke-linejoin') ?? styles.strokeLinejoin);
  const fillRuleRaw = (readSvgPresentationAttr(el, 'fill-rule') ?? styles.fillRule ?? 'nonzero').trim().toLowerCase();
  const fillRule: FillRule = fillRuleRaw === 'evenodd' ? 'evenodd' : 'nonzero';

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
    fillRule,
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
