import * as opentype from 'opentype.js';
import type { VectorData, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from './woodSpecies';
import { TEXT_FONT_FAMILIES } from './textFontCatalog';

/**
 * Catalog family display name (`Inter`, `Roboto`, `Playfair Display`,
 * etc.). Validated at runtime against `TEXT_FONT_FAMILIES`; storing
 * as an unrestricted `string` lets us expand the catalog without
 * type-system migrations.
 */
export type TextFontFamily = string;
export type TextFontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';

export interface TextSpec {
  /** The string to render. Single line; no newlines. */
  content: string;
  fontFamily: TextFontFamily;
  fontStyle: TextFontStyle;
  /** Inlay wood species. Drives both the rendered fill color (via
   *  `WOOD_SPECIES[species].baseHex`) and the design's single
   *  `woodConfigs` entry — one inlay wood per text design in v1. */
  species: WoodSpeciesKey;
}

/** The colorHex used for a text design's only layer — derived from the species. */
export function textColorHexFromSpec(spec: TextSpec): string {
  return WOOD_SPECIES[spec.species].baseHex.toLowerCase();
}

/** A single font family in the catalog. URLs are synthesized at use
 *  time from `slug` + style — see `fontUrl` below. */
export interface FontFamilyEntry {
  /** URL slug used to construct the font's CDN / local path. */
  slug: string;
  /** Display name; also the canonical `TextSpec.fontFamily` value. */
  family: string;
  /** Google Fonts category — drives a small grouping hint in the picker. */
  category: 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';
  /** When `true`, `fontUrl` returns the local `/fonts/...` path
   *  instead of the Fontsource CDN URL. Set on the 3 .ttf families
   *  shipped in `public/fonts/`. */
  bundled?: boolean;
}

export { TEXT_FONT_FAMILIES };

/**
 * Legacy family-name aliases. The prior 3-font catalog used
 * `'PlayfairDisplay'` (camelCase, no space) as the canonical name
 * because the type was a literal union. The expanded catalog uses
 * the Google Fonts display name (`'Playfair Display'`, with the
 * space). Saved sessions from the prior code path use the legacy
 * form; this map normalizes them on the way into the catalog.
 */
const FAMILY_ALIASES: Record<string, string> = {
  PlayfairDisplay: 'Playfair Display',
};

function familyEntry(family: TextFontFamily): FontFamilyEntry | undefined {
  const canonical = FAMILY_ALIASES[family] ?? family;
  return TEXT_FONT_FAMILIES.find(f => f.family === canonical);
}

/**
 * URL of the `.ttf` for `(entry, style)`. Bundled families load from
 * `public/fonts/{slug}-{weight}-{slope}.ttf`; everything else fetches
 * from the Fontsource jsDelivr CDN at the same naming convention.
 */
function fontUrl(entry: FontFamilyEntry, style: TextFontStyle): string {
  const weight = (style === 'bold' || style === 'boldItalic') ? 700 : 400;
  const slope  = (style === 'italic' || style === 'boldItalic') ? 'italic' : 'normal';
  if (entry.bundled) {
    return `/fonts/${entry.slug}-${weight}-${slope}.ttf`;
  }
  return `https://cdn.jsdelivr.net/fontsource/fonts/${entry.slug}@latest/latin-${weight}-${slope}.ttf`;
}

const fontCache = new Map<string, Promise<opentype.Font>>();

function fontKey(family: TextFontFamily, style: TextFontStyle): string {
  return `${family}-${style}`;
}

/**
 * Fetch and parse a font file. Promise-cached per (family, style) so
 * repeat calls return the same `Font` without refetching. Bundled
 * families resolve to a local path (always works offline); the rest
 * fetch from the Fontsource jsDelivr CDN on first use and rely on
 * the browser HTTP cache thereafter.
 */
export async function loadFont(
  family: TextFontFamily,
  style: TextFontStyle,
): Promise<opentype.Font> {
  const key = fontKey(family, style);
  const cached = fontCache.get(key);
  if (cached) return cached;
  const entry = familyEntry(family);
  if (!entry) {
    throw new Error(`Unknown font family: ${family}`);
  }
  const url = fontUrl(entry, style);
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load font ${url}: HTTP ${res.status}`);
    }
    const buffer = await res.arrayBuffer();
    return opentype.parse(buffer);
  })();
  fontCache.set(key, promise);
  // On failure, drop the cache entry so a retry can succeed.
  promise.catch(() => fontCache.delete(key));
  return promise;
}

/** Short slug derived from text content for default file naming. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'text';
}

/**
 * Serialize a list of opentype.js path commands to an SVG path-data
 * string at `decimalPlaces` precision. Replaces opentype.js's
 * `Path.toPathData`, which mishandles values whose decimal part
 * stringifies to scientific notation (e.g. `7e-15`) and emits NaN.
 *
 * Supports M/L/Q/C/Z — the only command types `glyph.getPath`
 * produces.
 */
function serializePath(commands: ReadonlyArray<opentype.PathCommand>, decimalPlaces: number): string {
  const factor = Math.pow(10, decimalPlaces);
  const fmt = (v: number): string => {
    const r = Math.round(v * factor) / factor;
    // Avoid leading "0." for integers (matches opentype.js's compact form).
    return Number.isInteger(r) ? String(r) : r.toFixed(decimalPlaces);
  };
  // Insert a separator before non-negative values that don't already
  // have a sign. The minus sign on negatives acts as a separator.
  const join = (...vs: number[]): string => {
    let s = '';
    for (let i = 0; i < vs.length; i++) {
      const part = fmt(vs[i]);
      if (i > 0 && part[0] !== '-') s += ' ';
      s += part;
    }
    return s;
  };
  const out: string[] = [];
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M': out.push('M' + join(cmd.x, cmd.y)); break;
      case 'L': out.push('L' + join(cmd.x, cmd.y)); break;
      case 'Q': out.push('Q' + join(cmd.x1, cmd.y1, cmd.x, cmd.y)); break;
      case 'C': out.push('C' + join(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y)); break;
      case 'Z': out.push('Z'); break;
    }
  }
  return out.join('');
}

/**
 * Render a text spec to a synthetic `VectorData` that the rest of
 * the analysis pipeline can consume without modification. Each call
 * fetches the font (cached after first use), gets the glyph path at
 * a normalized font size, and emits the glyphs as a single
 * `<path>` filled with `colorHex` in a viewBox sized to the text's
 * bounding box.
 *
 * The returned `VectorData` is byte-for-byte indistinguishable from
 * an SVG-uploaded design from the rest of the system's perspective —
 * `fileType` is `'svg'` and downstream consumers don't branch on it.
 *
 * Whitespace in the text is allowed; layout uses opentype.js's
 * default kerning. Empty content throws (callers should validate).
 */
export async function textToVectorData(spec: TextSpec): Promise<VectorData> {
  if (!spec.content) {
    throw new Error('Text content cannot be empty.');
  }
  const font = await loadFont(spec.fontFamily, spec.fontStyle);

  // Render at fontSize 100; viewBox absorbs the choice of unit.
  // First pass to measure, second pass with origin shifted so the
  // path fits cleanly inside (0, 0)–(w, h).
  //
  // We walk characters one at a time via `charToGlyph` — pure cmap
  // lookup, no GSUB features. opentype.js's higher-level
  // `getPath(text)` and `stringToGlyphs(text)` paths run through
  // bidi + feature application, which queries the GSUB table; the
  // bundled fonts include lookup types (specifically 6.2 chained
  // context substitution) that opentype.js doesn't fully support
  // and throws on. For CNC inlay text in Latin script we don't need
  // shaping; the per-character path with raw advanceWidth produces
  // visually identical output without ligatures and works for every
  // font in the catalog regardless of how exotic its GSUB tables are.
  const FONT_SIZE = 100;
  const chars = Array.from(spec.content);
  const glyphs = chars.map(c => font.charToGlyph(c));

  const measureCommands: opentype.PathCommand[] = [];
  let advance = 0;
  for (const glyph of glyphs) {
    const gp = glyph.getPath(advance, 0, FONT_SIZE);
    for (const cmd of gp.commands) measureCommands.push(cmd);
    advance += (glyph.advanceWidth ?? 0) * FONT_SIZE / font.unitsPerEm;
  }
  const measure = new opentype.Path();
  measure.commands = measureCommands;
  const bbox = measure.getBoundingBox();
  const w = Math.max(1, bbox.x2 - bbox.x1);
  const h = Math.max(1, bbox.y2 - bbox.y1);

  // Re-walk glyphs at a shifted origin so the result fits in (0, 0)–(w, h).
  const shiftX = -bbox.x1;
  const shiftY = -bbox.y1;
  const finalCommands: opentype.PathCommand[] = [];
  advance = 0;
  for (const glyph of glyphs) {
    const gp = glyph.getPath(advance + shiftX, shiftY, FONT_SIZE);
    for (const cmd of gp.commands) finalCommands.push(cmd);
    advance += (glyph.advanceWidth ?? 0) * FONT_SIZE / font.unitsPerEm;
  }
  // Serialize the path data ourselves rather than going through
  // opentype.js's `Path.toPathData` / `Path.toSVG`. Two reasons:
  //
  // 1. `toPathData`'s `roundDecimal` helper does
  //    `Number(decimalPart + "e+" + places)`, which produces NaN
  //    when `decimalPart` already serializes to scientific notation
  //    (e.g. `6.000000000000007 - 6` ≈ 7e-15 stringifies to
  //    `"7e-15"`, and `"7e-15" + "e+2"` is not a valid number).
  //    Many Google Fonts hit this — including Comic Neue and others
  //    — and the resulting `<path d="…NaN…">` renders as nothing.
  // 2. `toSVG` returns a full `<path d=…/>` element (the @types lie),
  //    and we need just the `d` attribute string to wrap in our own
  //    element with the inlay-color fill.
  //
  // Our inline serializer rounds with `Math.round(v * 10^p) / 10^p`,
  // which is robust to floating-point residuals.
  const pathD = serializePath(finalCommands, 2);

  const colorHex = textColorHexFromSpec(spec);
  const svgFragment = `<path d="${pathD}" fill="${colorHex}"/>`;
  const viewBox = `0 0 ${w} ${h}`;
  const svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">${svgFragment}</svg>`;

  return {
    svgString,
    layers: [{ colorHex, svgFragment }],
    naturalWidth: w,
    naturalHeight: h,
    viewBox,
    fileName: `text-${slug(spec.content)}.svg`,
    fileType: 'svg',
    detectedColors: [colorHex],
  };
}
