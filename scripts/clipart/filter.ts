/**
 * Offline filter rules — these are the cheap pre-Playwright passes
 * that drop bad candidates before paying the headless-browser cost
 * of DFM screening. Pure-string + DOM-free; runs in plain Node.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type RejectReason =
  | 'parse-error'
  | 'too-many-colors'
  | 'has-gradient'
  | 'has-pattern'
  | 'has-image'
  | 'nsfw-keyword'
  | 'empty';

export interface OfflineFilterResult {
  ok: boolean;
  reason?: RejectReason;
  /** Distinct fill colors detected, lowercased. Empty when ok=false. */
  colors?: string[];
  /** Snippet from the rejection cause for the audit log. */
  detail?: string;
}

const NSFW_KEYWORDS: readonly string[] = (() => {
  const path = resolve(__dirname, 'nsfw-keywords.txt');
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(l => l.toLowerCase());
})();

/**
 * Test the title + tags against the NSFW keyword blocklist.
 * Whole-word match — substrings inside other words don't trip the
 * filter (e.g. "rifle" matches but "scarifies" doesn't).
 */
export function nsfwKeywordHit(title: string, tags: readonly string[]): string | null {
  const haystack = (title + ' ' + tags.join(' ')).toLowerCase();
  // Tokenize by non-letter boundaries so we match whole words only.
  const tokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
  for (const kw of NSFW_KEYWORDS) {
    if (tokens.has(kw)) return kw;
  }
  return null;
}

/** Maximum distinct fill colors permitted in a clipart entry. */
export const MAX_COLOR_COUNT = 5;

/**
 * Cheap structural inspection of the SVG source. Counts distinct fill
 * colors and detects gradient / pattern / raster references that we
 * don't want in the inlay catalog. Doesn't require a DOM — pure regex
 * extraction so it runs in plain Node without jsdom.
 *
 * Color collection is lenient: matches `fill="#abc"`, `fill="#aabbcc"`,
 * inline `style="fill:#abc"`, and named CSS colors are mapped through
 * a small built-in table for the common ones (`black`, `white`, `red`,
 * etc.). Anything else (rgb(), hsl(), color names we don't recognize,
 * gradients) becomes a separate "unknown" color so a design with
 * mixed fill schemes counts as multi-color even if we can't normalize
 * the values.
 */
export function inspectSvg(svgText: string): OfflineFilterResult {
  if (svgText.length === 0 || !svgText.includes('<svg')) {
    return { ok: false, reason: 'parse-error', detail: 'not-an-svg' };
  }

  // Reject anything that uses raster image refs — we want pure vector geometry.
  if (/<image\b[^>]*href=/i.test(svgText) || /<image\b[^>]*xlink:href=/i.test(svgText)) {
    return { ok: false, reason: 'has-image' };
  }

  // Gradient / pattern detection — by tag presence and by `fill="url(...)"` ref.
  if (/<linearGradient\b/i.test(svgText) || /<radialGradient\b/i.test(svgText)) {
    return { ok: false, reason: 'has-gradient' };
  }
  if (/<pattern\b/i.test(svgText)) {
    return { ok: false, reason: 'has-pattern' };
  }
  if (/fill\s*=\s*["']url\(/i.test(svgText) || /fill\s*:\s*url\(/i.test(svgText)) {
    return { ok: false, reason: 'has-gradient', detail: 'fill-url-ref' };
  }

  // Collect distinct fill colors. Default fill = black when unspecified —
  // we don't model that here; an SVG with no `fill` attributes is rare,
  // and if it exists we still count its rendered colors via the
  // Playwright pass.
  const colors = new Set<string>();

  // Attribute form: fill="#xxx" or fill="#xxxxxx" or fill="name"
  for (const m of svgText.matchAll(/\bfill\s*=\s*["']([^"']+)["']/gi)) {
    const c = normalizeColor(m[1]);
    if (c === 'transparent') continue;
    if (c) colors.add(c);
  }
  // Inline-style form: style="...fill:#xxx..."
  for (const m of svgText.matchAll(/style\s*=\s*["']([^"']+)["']/gi)) {
    const styleAttr = m[1];
    const fillMatch = styleAttr.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
    if (fillMatch) {
      const c = normalizeColor(fillMatch[1].trim());
      if (c === 'transparent') continue;
      if (c) colors.add(c);
    }
  }

  if (colors.size === 0) {
    return { ok: false, reason: 'empty', detail: 'no fill attributes' };
  }
  if (colors.size > MAX_COLOR_COUNT) {
    return {
      ok: false,
      reason: 'too-many-colors',
      detail: `${colors.size} distinct fills`,
      colors: [...colors],
    };
  }

  return { ok: true, colors: [...colors].sort() };
}

const NAMED_COLORS: Record<string, string> = {
  black:   '#000000',
  white:   '#ffffff',
  red:     '#ff0000',
  green:   '#008000',
  blue:    '#0000ff',
  yellow:  '#ffff00',
  cyan:    '#00ffff',
  magenta: '#ff00ff',
  gray:    '#808080',
  grey:    '#808080',
  silver:  '#c0c0c0',
  brown:   '#a52a2a',
  orange:  '#ffa500',
  purple:  '#800080',
  pink:    '#ffc0cb',
  none:    '',          // fill="none" → no color
};

function normalizeColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return 'transparent';
  if (v in NAMED_COLORS) {
    const named = NAMED_COLORS[v];
    return named === '' ? null : named;
  }
  // #abc → #aabbcc
  let m = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return `#${m[1]}`;
  // Unrecognized syntax (rgb(), hsl(), url()) — caller handles
  // gradient/pattern URL refs separately. For everything else, return
  // the raw string so it still counts as a distinct "color".
  return v;
}
