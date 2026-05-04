import * as opentype from 'opentype.js';
import type { VectorData, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from './woodSpecies';

export type TextFontFamily = 'Inter' | 'Lora' | 'PlayfairDisplay';
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

interface FontDescriptor {
  family: TextFontFamily;
  style: TextFontStyle;
  /** Public path (relative to the site root) of the .ttf file. */
  url: string;
  /** Human-readable label for UI pickers. */
  label: string;
}

/**
 * Bundled font catalog. Three families × four styles, all SIL OFL,
 * served from `public/fonts/`. Naming `family-weight-style.ttf` —
 * 400 = regular, 700 = bold, normal/italic = slope.
 */
export const TEXT_FONT_CATALOG: ReadonlyArray<FontDescriptor> = [
  { family: 'Inter',           style: 'regular',    url: '/fonts/inter-400-normal.ttf',            label: 'Inter Regular' },
  { family: 'Inter',           style: 'bold',       url: '/fonts/inter-700-normal.ttf',            label: 'Inter Bold' },
  { family: 'Inter',           style: 'italic',     url: '/fonts/inter-400-italic.ttf',            label: 'Inter Italic' },
  { family: 'Inter',           style: 'boldItalic', url: '/fonts/inter-700-italic.ttf',            label: 'Inter Bold Italic' },
  { family: 'Lora',            style: 'regular',    url: '/fonts/lora-400-normal.ttf',             label: 'Lora Regular' },
  { family: 'Lora',            style: 'bold',       url: '/fonts/lora-700-normal.ttf',             label: 'Lora Bold' },
  { family: 'Lora',            style: 'italic',     url: '/fonts/lora-400-italic.ttf',             label: 'Lora Italic' },
  { family: 'Lora',            style: 'boldItalic', url: '/fonts/lora-700-italic.ttf',             label: 'Lora Bold Italic' },
  { family: 'PlayfairDisplay', style: 'regular',    url: '/fonts/playfair-display-400-normal.ttf', label: 'Playfair Display Regular' },
  { family: 'PlayfairDisplay', style: 'bold',       url: '/fonts/playfair-display-700-normal.ttf', label: 'Playfair Display Bold' },
  { family: 'PlayfairDisplay', style: 'italic',     url: '/fonts/playfair-display-400-italic.ttf', label: 'Playfair Display Italic' },
  { family: 'PlayfairDisplay', style: 'boldItalic', url: '/fonts/playfair-display-700-italic.ttf', label: 'Playfair Display Bold Italic' },
];

const fontCache = new Map<string, Promise<opentype.Font>>();

function fontKey(family: TextFontFamily, style: TextFontStyle): string {
  return `${family}-${style}`;
}

/**
 * Fetch and parse a bundled font file. Promise-cached per (family,
 * style) so repeat calls return the same `Font` without refetching.
 */
export async function loadFont(
  family: TextFontFamily,
  style: TextFontStyle,
): Promise<opentype.Font> {
  const key = fontKey(family, style);
  const cached = fontCache.get(key);
  if (cached) return cached;
  const descriptor = TEXT_FONT_CATALOG.find(d => d.family === family && d.style === style);
  if (!descriptor) {
    throw new Error(`Unknown font: ${family} / ${style}`);
  }
  const promise = (async () => {
    const res = await fetch(descriptor.url);
    if (!res.ok) {
      throw new Error(`Failed to load font ${descriptor.url}: HTTP ${res.status}`);
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
  const path = new opentype.Path();
  path.commands = finalCommands;
  // Note: opentype.js's `Path.toSVG()` returns the full `<path d=…/>`
  // element (and its types lie about the signature). We want just
  // the `d` attribute, so call `toPathData(opts)` and wrap with our
  // own element below. `flipY: false` is critical: our commands are
  // already in SVG-down-Y coordinates (because `glyph.getPath`
  // negates each `cmd.y`), and `toPathData`'s default `flipY: true`
  // would flip them a second time and render the text upside down.
  const pathD = (path as unknown as {
    toPathData(opts?: { decimalPlaces?: number; flipY?: boolean }): string;
  }).toPathData({ decimalPlaces: 2, flipY: false });

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
