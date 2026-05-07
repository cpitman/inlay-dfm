/**
 * Curated clipart library — the third design source in /quote alongside
 * Upload and Text. Catalog is a static manifest at
 * `/clipart/manifest.json` plus per-entry `.svg` and `.png` files in
 * the same directory. Built by the offline scrape pipeline (see
 * `scripts/clipart/`); the runtime just reads the manifest and serves
 * the static assets.
 */

export interface ClipartManifestEntry {
  /** URL-safe slug. Drives `/clipart/{id}.svg` and `/clipart/{id}.png`. */
  id: string;
  title: string;
  /** Search-keyword tags. Lowercase, deduplicated. */
  tags: string[];
  source: 'openclipart' | 'publicdomainvectors' | 'svgrepo';
  /** Attribution link back to the source page. */
  sourceUrl: string;
  license: 'CC0';
  /** Number of distinct fill colors (1..5). */
  colorCount: number;
  /** Lowercase `#rrggbb` hex strings, in detected order. */
  colors: string[];
  /** Width / height of the source SVG, used to pre-shape grid tiles. */
  aspectRatio: number;
  /** Popularity rank — lower is more popular. Used as a tie-breaker
   *  in search and as the default browse sort. */
  rank: number;
}

const MANIFEST_URL = '/clipart/manifest.json';

let manifestCache: ClipartManifestEntry[] | null = null;
let manifestPromise: Promise<ClipartManifestEntry[]> | null = null;

/**
 * Fetch and cache `/clipart/manifest.json`. Returns an empty array if
 * the manifest is missing — useful for early dev when the catalog
 * hasn't been built yet, and lets the picker render a graceful empty
 * state instead of throwing.
 */
export async function loadClipartCatalog(): Promise<ClipartManifestEntry[]> {
  if (manifestCache) return manifestCache;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) return [];
      const json = await res.json();
      if (!Array.isArray(json)) return [];
      manifestCache = json as ClipartManifestEntry[];
      return manifestCache;
    } catch {
      return [];
    }
  })();
  return manifestPromise;
}

/** Reset the in-memory cache. Test-only. */
export function _resetClipartCatalogCache(): void {
  manifestCache = null;
  manifestPromise = null;
}

/**
 * Filter and sort a catalog by a search query. Empty / whitespace-only
 * query returns the full catalog sorted by rank ascending. Otherwise
 * matches case-insensitively against title + tags; entries whose title
 * matches outrank entries that match only a tag.
 */
export function searchCatalog(
  catalog: readonly ClipartManifestEntry[],
  query: string,
): ClipartManifestEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...catalog].sort((a, b) => a.rank - b.rank);
  }
  const tokens = q.split(/\s+/).filter(t => t.length > 0);
  const scored: { entry: ClipartManifestEntry; score: number }[] = [];
  for (const entry of catalog) {
    const titleLower = entry.title.toLowerCase();
    let titleHits = 0;
    let tagHits = 0;
    for (const tok of tokens) {
      if (titleLower.includes(tok)) titleHits++;
      else if (entry.tags.some(t => t.toLowerCase().includes(tok))) tagHits++;
    }
    const matched = titleHits + tagHits;
    if (matched < tokens.length) continue;
    // Title hits worth more than tag hits; rank is the final tiebreak.
    const score = titleHits * 1000 + tagHits * 10 - entry.rank * 0.001;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.entry);
}
