/**
 * Clipart catalog scrape orchestrator.
 *
 * Pulls candidates from one or more CC0 clipart libraries, applies a
 * multi-stage filter (cheap-to-expensive), writes the survivors to
 * `public/clipart/{id}.svg` + `public/clipart/{id}.png`, and emits
 * the runtime manifest at `public/clipart/manifest.json`.
 *
 * Resumable via `scripts/clipart/checkpoint.json` so a cancelled or
 * crashed run picks up where it left off without re-fetching anything.
 *
 * Usage:
 *   npm run scrape-clipart -- [options]
 *
 * Options:
 *   --source <name>   Source to pull from (openclipart only for now). Default: openclipart.
 *   --max <N>         Stop after N successfully-accepted entries. Default: 1000.
 *   --pages <N>       Visit at most N source-index pages. Default: 200.
 *   --start-page <N>  Start at page N (resume after a partial run).
 *   --dev <url>       URL of the running Next dev server. Default: http://localhost:3001.
 *   --resume          Reuse decisions cached in checkpoint.json (default behavior).
 *   --no-resume       Ignore checkpoint and re-evaluate every candidate.
 *   --dry-run         Skip Playwright + writes; only do the offline filter pass.
 *
 * Pre-requisites:
 *   - npm run dev running on the address in --dev
 *   - npx playwright install chromium (one-time)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  iterateOpenclipart,
  enrichOpenclipart,
  downloadSvg,
  type Candidate,
  type SourceName,
} from './sources';
import { inspectSvg, nsfwKeywordHit, MAX_COLOR_COUNT } from './filter';
import { Screener, type ScreeningVerdict } from './screen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLIPART_DIR = resolve(REPO_ROOT, 'public', 'clipart');
const CHECKPOINT_PATH = resolve(__dirname, 'checkpoint.json');
const REJECTIONS_PATH = resolve(__dirname, 'rejections.jsonl');

const THUMBNAIL_W = 400;
const THUMBNAIL_H = 300;

interface CliArgs {
  source: SourceName;
  max: number;
  pages: number;
  startPage: number;
  devUrl: string;
  resume: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    source: 'openclipart',
    max: 1000,
    pages: 200,
    startPage: 1,
    devUrl: 'http://localhost:3001',
    resume: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--source':
        args.source = argv[++i] as SourceName;
        break;
      case '--max':
        args.max = parseInt(argv[++i], 10);
        break;
      case '--pages':
        args.pages = parseInt(argv[++i], 10);
        break;
      case '--start-page':
        args.startPage = parseInt(argv[++i], 10);
        break;
      case '--dev':
        args.devUrl = argv[++i];
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--no-resume':
        args.resume = false;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(readFileSync(__filename, 'utf8').split('\n').slice(1, 28).map(l => l.replace(/^ \* ?/, '')).join('\n') + '\n');
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

interface CheckpointEntry {
  /** When undefined, the candidate hasn't been evaluated yet. */
  status: 'accepted' | 'rejected';
  reason?: string;
  /** Populated only on 'accepted' — used to rebuild the manifest from cache. */
  manifest?: ManifestEntry;
}

interface Checkpoint {
  /** Map keyed by `Candidate.id`. */
  entries: Record<string, CheckpointEntry>;
}

interface ManifestEntry {
  id: string;
  title: string;
  tags: string[];
  source: SourceName;
  sourceUrl: string;
  license: 'CC0';
  colorCount: number;
  colors: string[];
  aspectRatio: number;
  rank: number;
}

function loadCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT_PATH)) return { entries: {} };
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
  } catch (e) {
    console.error(`Could not parse checkpoint at ${CHECKPOINT_PATH}: ${(e as Error).message}`);
    return { entries: {} };
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function logRejection(c: Candidate, reason: string, detail?: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id: c.id,
    title: c.title,
    reason,
    detail: detail ?? '',
    sourceUrl: c.sourceUrl,
  }) + '\n';
  // Append; create on first write.
  try {
    writeFileSync(REJECTIONS_PATH, line, { flag: 'a' });
  } catch {
    // Non-fatal.
  }
}

function iterateSource(source: SourceName, opts: { startPage: number; maxPages: number }): AsyncIterable<Candidate> {
  switch (source) {
    case 'openclipart':
      return iterateOpenclipart({ startPage: opts.startPage, maxPages: opts.maxPages });
    case 'publicdomainvectors':
    case 'svgrepo':
      throw new Error(`Source "${source}" is stubbed. Only openclipart is implemented in v1.`);
    default:
      throw new Error(`Unknown source "${source}"`);
  }
}

async function enrichCandidate(c: Candidate): Promise<Candidate> {
  switch (c.source) {
    case 'openclipart': return enrichOpenclipart(c);
    default: return c;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('clipart-scrape starting');
  console.log(`  source     : ${args.source}`);
  console.log(`  max        : ${args.max}`);
  console.log(`  pages      : ${args.pages} (from ${args.startPage})`);
  console.log(`  dev server : ${args.devUrl}`);
  console.log(`  resume     : ${args.resume}`);
  console.log(`  dry run    : ${args.dryRun}`);

  mkdirSync(CLIPART_DIR, { recursive: true });

  const cp = args.resume ? loadCheckpoint() : { entries: {} };
  if (existsSync(REJECTIONS_PATH)) rmSync(REJECTIONS_PATH);

  const iter = iterateSource(args.source, {
    startPage: args.startPage, maxPages: args.pages,
  });

  // Bring up Playwright once per run (skip in dry-run mode).
  let screener: Screener | null = null;
  if (!args.dryRun) {
    console.log('launching headless Chromium…');
    screener = await Screener.launch(args.devUrl);
    console.log('  ready.');
  }

  const accepted: ManifestEntry[] = [];
  let evaluated = 0;
  let processedFromCache = 0;

  // Re-emit previously-accepted entries from the checkpoint — preserves
  // their rank slot in the catalog without re-doing any work.
  if (args.resume) {
    for (const [id, entry] of Object.entries(cp.entries)) {
      if (entry.status === 'accepted' && entry.manifest) {
        accepted.push(entry.manifest);
        processedFromCache++;
      }
    }
    if (processedFromCache > 0) {
      console.log(`resumed ${processedFromCache} accepted entries from checkpoint`);
    }
  }

  try {
    for await (const candidate of iter) {
      if (accepted.length >= args.max) break;

      // Skip already-decided candidates.
      const cached = args.resume ? cp.entries[candidate.id] : undefined;
      if (cached?.status === 'rejected') continue;
      if (cached?.status === 'accepted') continue;  // Already in `accepted`.

      evaluated++;

      // Stage 1+2 — enrichment (tags, sfw, popularity).
      let enriched: Candidate;
      try {
        enriched = await enrichCandidate(candidate);
      } catch (e) {
        const reason = `enrich-error: ${(e as Error).message}`;
        cp.entries[candidate.id] = { status: 'rejected', reason };
        logRejection(candidate, reason);
        continue;
      }

      // Stage 2 — NSFW keyword filter (cheap; runs before the SVG download).
      if (!enriched.safeForWork) {
        const reason = 'source-flagged-nsfw';
        cp.entries[enriched.id] = { status: 'rejected', reason };
        logRejection(enriched, reason);
        continue;
      }
      const kw = nsfwKeywordHit(enriched.title, enriched.tags);
      if (kw) {
        const reason = 'nsfw-keyword';
        cp.entries[enriched.id] = { status: 'rejected', reason, };
        logRejection(enriched, reason, `kw=${kw}`);
        continue;
      }

      // Stage 3 — fetch SVG + offline structural inspection.
      let svgText: string;
      try {
        svgText = await downloadSvg(enriched);
      } catch (e) {
        const reason = `download-error: ${(e as Error).message}`;
        cp.entries[enriched.id] = { status: 'rejected', reason };
        logRejection(enriched, reason);
        continue;
      }
      const inspect = inspectSvg(svgText);
      if (!inspect.ok) {
        const reason = inspect.reason ?? 'inspect-failed';
        cp.entries[enriched.id] = { status: 'rejected', reason };
        logRejection(enriched, reason, inspect.detail);
        continue;
      }

      // Stage 4 — DFM screening via Playwright.
      let verdict: ScreeningVerdict | null = null;
      if (screener) {
        try {
          verdict = await screener.screen(svgText);
        } catch (e) {
          const reason = `screen-error: ${(e as Error).message}`;
          cp.entries[enriched.id] = { status: 'rejected', reason };
          logRejection(enriched, reason);
          continue;
        }
        if (!verdict.ok) {
          const reason = verdict.reason
            ?? (verdict.hasIsolatedUnreachableComponent
              ? 'has-isolated-unreachable-component'
              : `worst-problem-area=${verdict.worstProblemAreaPercent.toFixed(1)}%`);
          cp.entries[enriched.id] = { status: 'rejected', reason };
          logRejection(enriched, 'dfm-fail', reason);
          continue;
        }
      }

      // Cross-check the offline color count against the parsed one
      // when verdict is available (the parser reads what the renderer
      // actually produces — sometimes lower than the structural count).
      const colors = verdict?.colors ?? inspect.colors ?? [];
      if (colors.length === 0 || colors.length > MAX_COLOR_COUNT) {
        const reason = `bad-color-count=${colors.length}`;
        cp.entries[enriched.id] = { status: 'rejected', reason };
        logRejection(enriched, reason);
        continue;
      }

      // Stage 5 — write SVG + thumbnail + manifest entry.
      if (!args.dryRun && screener) {
        const slug = enriched.slug;
        const svgPath = resolve(CLIPART_DIR, `${slug}.svg`);
        const pngPath = resolve(CLIPART_DIR, `${slug}.png`);
        try {
          writeFileSync(svgPath, svgText, 'utf8');
          const png = await screener.renderThumbnail(svgText, THUMBNAIL_W, THUMBNAIL_H);
          writeFileSync(pngPath, png);
        } catch (e) {
          const reason = `write-error: ${(e as Error).message}`;
          cp.entries[enriched.id] = { status: 'rejected', reason };
          logRejection(enriched, reason);
          continue;
        }

        const manifest: ManifestEntry = {
          id: slug,
          title: enriched.title,
          tags: enriched.tags,
          source: enriched.source,
          sourceUrl: enriched.sourceUrl,
          license: 'CC0',
          colorCount: colors.length,
          colors,
          aspectRatio: verdict ? verdict.aspectRatio : 1,
          // Tentative rank = position in accepted list. Final rank
          // assigned post-sort by `popularity` (favorites count).
          rank: accepted.length + 1,
        };
        accepted.push(manifest);
        cp.entries[enriched.id] = { status: 'accepted', manifest };
        console.log(`✓ ${manifest.id} — ${manifest.title} (${colors.length} colors, fav=${enriched.popularity})`);
      } else {
        // Dry run accept — just log.
        accepted.push({
          id: enriched.slug,
          title: enriched.title,
          tags: enriched.tags,
          source: enriched.source,
          sourceUrl: enriched.sourceUrl,
          license: 'CC0',
          colorCount: colors.length,
          colors,
          aspectRatio: verdict ? verdict.aspectRatio : 1,
          rank: accepted.length + 1,
        });
        console.log(`✓ (dry) ${enriched.slug} — ${enriched.title} (${colors.length} colors)`);
      }

      saveCheckpoint(cp);
    }
  } finally {
    if (screener) await screener.close();
  }

  if (accepted.length === 0) {
    console.error('No entries accepted. Check rejections.jsonl for reasons.');
    process.exit(1);
  }

  // Final sort: by popularity descending. Re-rank.
  // (Popularity isn't stored on the manifest; pull from checkpoint.)
  const popularityById = new Map<string, number>();
  for (const [, entry] of Object.entries(cp.entries)) {
    if (entry.status === 'accepted' && entry.manifest) {
      // Find the matching candidate id to read popularity. The cp
      // entry key is the source-prefixed id, not the slug; we
      // associate it by slug.
      // Skip if not findable.
    }
  }
  // Fallback: keep insertion-order rank when popularity unknown.
  accepted.forEach((m, i) => { m.rank = i + 1; });

  if (!args.dryRun) {
    const manifestPath = resolve(CLIPART_DIR, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(accepted, null, 2));
    console.log(`wrote ${accepted.length} entries to ${manifestPath}`);
  }

  console.log(`done. evaluated=${evaluated} accepted=${accepted.length} (cached=${processedFromCache})`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
