/**
 * Source adapters — each one yields candidates from one CC0 clipart
 * library in popularity-ish order, plus a per-candidate enrichment
 * step that fetches tags / safety flags / SVG content.
 *
 * The shape is async-generator + enrich so the orchestrator can pull
 * lazily, stop early once it has enough candidates, and parallelize
 * enrichment across many small HTTP requests.
 *
 * Network status as of writing:
 * - **openclipart.org**: live, public, no auth. Search index at
 *   `/search?p={page}` lists 32 tiles/page with a thumbnail link
 *   `/detail/{id}/{slug}`. SVG download at `/download/{id}`. Detail
 *   page exposes tags + favorites count + safe-for-work flag. No
 *   public popularity sort — we walk the index and rely on the
 *   detail page's `favorites` count as our popularity signal.
 * - **publicdomainvectors.org / svgrepo.com**: stubbed. Both return
 *   403 to ad-hoc fetchers (likely UA filtering); a real run needs
 *   a recognized browser UA. Stubs throw on use so the scrape script
 *   refuses to silently emit zero candidates from those sources.
 */

import { setTimeout as sleep } from 'node:timers/promises';

export type SourceName = 'openclipart' | 'publicdomainvectors' | 'svgrepo';

export interface Candidate {
  /** Globally unique id: `{source}-{nativeId}`. */
  id: string;
  /** Slug derived from the title, used for `public/clipart/{slug}.svg` filenames. */
  slug: string;
  source: SourceName;
  /** Detail-page URL on the source site (attribution). */
  sourceUrl: string;
  title: string;
  /** Lowercase, deduplicated tags. Empty until enrichment fills them. */
  tags: string[];
  /** Higher = more popular. 0 when the source doesn't expose popularity. */
  popularity: number;
  /** Direct SVG download URL. */
  downloadUrl: string;
  /** Source-asserted safety flag. False until enrichment confirms. */
  safeForWork: boolean;
}

export interface EnrichedCandidate extends Candidate {
  /** Full SVG source. Set after `downloadSvg`. */
  svgText: string;
}

const POLITE_DELAY_MS = 300;

/**
 * Default User-Agent used for outbound requests. Some sources reject
 * Node's default `node` UA; pretending to be a real browser is the
 * conventional workaround for unauthenticated public scraping.
 */
const USER_AGENT =
  'Mozilla/5.0 (clipart-scrape; +https://github.com/) inlay-dfm/0.1.0';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// openclipart.org
// ---------------------------------------------------------------------------

const OPENCLIPART_BASE = 'https://openclipart.org';

/**
 * Walk openclipart.org's search index page-by-page, yielding every
 * tile we find. Default order is newest-first (no popularity sort
 * exposed in the URL). Caller is responsible for stopping once it
 * has enough.
 */
export async function* iterateOpenclipart(opts: {
  startPage?: number;
  maxPages?: number;
} = {}): AsyncIterable<Candidate> {
  const startPage = opts.startPage ?? 1;
  const maxPages = opts.maxPages ?? 200;
  for (let p = startPage; p < startPage + maxPages; p++) {
    let html: string;
    try {
      html = await fetchText(`${OPENCLIPART_BASE}/search?p=${p}`);
    } catch (e) {
      console.error(`[openclipart] page ${p} failed: ${(e as Error).message}`);
      break;
    }
    const tiles = extractOpenclipartTiles(html);
    if (tiles.length === 0) {
      // Empty page — we've walked off the end of the index.
      return;
    }
    for (const t of tiles) yield t;
    await sleep(POLITE_DELAY_MS);
  }
}

function extractOpenclipartTiles(html: string): Candidate[] {
  const out: Candidate[] = [];
  // <a href="/detail/{id}/{slug}"><img src="/image/800px/{id}" alt="{title}"></a>
  const tileRegex = /<a\s+[^>]*href="\/detail\/(\d+)\/([^"\/]+)"[^>]*>\s*<img\s+[^>]*alt="([^"]*)"/gi;
  for (const m of html.matchAll(tileRegex)) {
    const nativeId = m[1];
    const slugRaw = decodeURIComponent(m[2]);
    const title = decodeHtmlEntities(m[3]).trim() || slugRaw.replace(/-/g, ' ');
    out.push({
      id: `openclipart-${nativeId}`,
      slug: normalizeSlug(slugRaw),
      source: 'openclipart',
      sourceUrl: `${OPENCLIPART_BASE}/detail/${nativeId}/${slugRaw}`,
      title,
      tags: [],
      popularity: 0,
      downloadUrl: `${OPENCLIPART_BASE}/download/${nativeId}`,
      safeForWork: false,  // Confirmed during enrichment.
    });
  }
  return out;
}

/**
 * Visit a candidate's detail page and pull tags + favorites count +
 * safe-for-work flag. Politely delayed.
 */
export async function enrichOpenclipart(c: Candidate): Promise<Candidate> {
  await sleep(POLITE_DELAY_MS);
  let html: string;
  try {
    html = await fetchText(c.sourceUrl);
  } catch {
    return c;
  }
  // Tags are rendered as `<a href="/tag/{name}">{name}</a>` on the
  // detail page. Filter out remix-back-references like "remix+355609"
  // (which point at the parent clipart, not a real tag).
  const tags = new Set<string>();
  for (const m of html.matchAll(/href="\/tag\/([^"]+)"/gi)) {
    const tag = decodeURIComponent(m[1]).toLowerCase().trim();
    if (tag.length === 0 || tag.length > 40) continue;
    if (tag.startsWith('remix+')) continue;
    if (!/^[a-z0-9 \-]+$/.test(tag)) continue;
    tags.add(tag);
  }
  // Favorites count: shown as `<a href="/favs/{id}/{slug}">N</a>` on
  // the detail page. Cheap regex match against the favs link target.
  const favMatch = html.match(/href="\/favs\/[^"]+"\s*>\s*(\d+)/i);
  const favorites = favMatch ? parseInt(favMatch[1], 10) : 0;
  // Safe-for-work flag: the detail page explicitly states "Safe for Work: Yes/No".
  const sfwMatch = html.match(/Safe\s+for\s+Work:?\s*(\w+)/i);
  const safeForWork = sfwMatch ? /^y(?:es)?$/i.test(sfwMatch[1]) : true;
  return {
    ...c,
    tags: [...tags],
    popularity: favorites,
    safeForWork,
  };
}

/** Download the SVG for a candidate. */
export async function downloadSvg(c: Candidate): Promise<string> {
  await sleep(POLITE_DELAY_MS);
  return fetchText(c.downloadUrl);
}

// ---------------------------------------------------------------------------
// publicdomainvectors.org — stubbed (403s ad-hoc fetchers)
// ---------------------------------------------------------------------------

export async function* iteratePublicDomainVectors(): AsyncIterable<Candidate> {
  throw new Error(
    'publicdomainvectors.org adapter is not implemented. ' +
    'The site rejects programmatic fetches with HTTP 403 unless given a recognized ' +
    'browser User-Agent + cookie session; a real implementation needs to drive ' +
    'a Playwright session through the index pages. Skip via --source openclipart for now.',
  );
  // TypeScript flow: keep the function shape valid even with the throw.
  // eslint-disable-next-line no-unreachable
  yield {} as Candidate;
}

// ---------------------------------------------------------------------------
// svgrepo.com — stubbed (403s ad-hoc fetchers)
// ---------------------------------------------------------------------------

export async function* iterateSvgRepo(): AsyncIterable<Candidate> {
  throw new Error(
    'svgrepo.com adapter is not implemented. ' +
    'Same situation as publicdomainvectors: 403 on plain Node fetches. Will need ' +
    'a Playwright-driven crawl plus the CC0-only collection filter at ' +
    'https://www.svgrepo.com/svg/cc0/ when implemented.',
  );
  // eslint-disable-next-line no-unreachable
  yield {} as Candidate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSlug(raw: string): string {
  return raw.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;':  '&',
  '&lt;':   '<',
  '&gt;':   '>',
  '&quot;': '"',
  '&#39;':  "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, m => {
      if (m in HTML_ENTITY_MAP) return HTML_ENTITY_MAP[m];
      const dec = m.match(/^&#(\d+);$/);
      if (dec) return String.fromCharCode(parseInt(dec[1], 10));
      const hex = m.match(/^&#x([0-9a-f]+);$/i);
      if (hex) return String.fromCharCode(parseInt(hex[1], 16));
      return m;
    });
}
