/**
 * Re-screening pass for the existing clipart catalog.
 *
 * Iterates `public/clipart/manifest.json`, runs each entry's SVG
 * through `runDfmAnalysis` via the same Playwright + dev-server
 * harness `scrape.ts` uses, and removes any clipart that no longer
 * passes the (post-polygon-migration) verification rules.
 *
 * "Removes" matches the moderate.ts removal mechanism:
 *   - Delete `public/clipart/{id}.svg` and `{id}.png`.
 *   - Drop the manifest entry; re-rank the survivors.
 *   - Append one line per removal to `rejections.jsonl` with reason
 *     `dfm-rescreen-2026-05-08.13` (the active CODE_VERSION).
 *
 * Run it after starting `npm run dev`:
 *
 *   tsx scripts/clipart/rescreen.ts [--dev http://localhost:3001]
 *                                   [--dry-run]
 *
 * `--dry-run` reports the verdict for every entry but writes nothing.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { Screener, type ScreeningVerdict } from './screen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLIPART_DIR = resolve(REPO_ROOT, 'public', 'clipart');
const MANIFEST_PATH = resolve(CLIPART_DIR, 'manifest.json');
const REJECTIONS_PATH = resolve(__dirname, 'rejections.jsonl');

interface ManifestEntry {
  id: string;
  title: string;
  tags: string[];
  source: string;
  sourceUrl: string;
  license: 'CC0';
  colorCount: number;
  colors: string[];
  aspectRatio: number;
  rank: number;
}

interface Args {
  devUrl: string;
  dryRun: boolean;
  rescreenReason: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    devUrl: 'http://localhost:3001',
    dryRun: false,
    // Stamp with the active CODE_VERSION so rejections.jsonl audits
    // can later attribute "this entry was dropped under the polygon
    // analysis at this rule revision."
    rescreenReason: 'dfm-rescreen-2026-05-08.13',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dev') args.devUrl = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--reason') args.rescreenReason = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(readFileSync(__filename, 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^ \* ?/, '')).join('\n') + '\n');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function logRejection(entry: ManifestEntry, reason: string, detail: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id: `${entry.source}-${entry.id}`,
    title: entry.title,
    reason,
    detail,
    sourceUrl: entry.sourceUrl,
  }) + '\n';
  writeFileSync(REJECTIONS_PATH, line, { flag: 'a' });
}

function fmtVerdict(v: ScreeningVerdict): string {
  const parts: string[] = [];
  if (v.reason) parts.push(`reason=${v.reason}`);
  // colorCount=0 with no explicit reason field means the screen-clipart
  // page hit its catch path with an Error whose message didn't survive
  // round-tripping (some browser-side errors are non-Error objects).
  if (v.colorCount === 0 && !v.reason) parts.push('parser-or-analysis-error');
  if (v.hasIsolatedUnreachableComponent) parts.push('isolated-component');
  if (v.worstProblemAreaPercent > 0) parts.push(`problem=${v.worstProblemAreaPercent.toFixed(2)}%`);
  if (v.totalAlignmentAffectedPercent > 0) parts.push(`align=${v.totalAlignmentAffectedPercent.toFixed(2)}%`);
  if (!v.allPassed && parts.length === 0) parts.push('side-passed-false-without-detail');
  return parts.join(', ') || 'pass';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(MANIFEST_PATH)) {
    console.error(`No manifest at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  console.log(`rescreen: loaded ${manifest.length} manifest entries`);
  if (args.dryRun) console.log('rescreen: --dry-run mode, no writes');

  const screener = await Screener.launch(args.devUrl);

  const kept: ManifestEntry[] = [];
  const removed: { entry: ManifestEntry; detail: string }[] = [];
  const missing: ManifestEntry[] = [];

  let i = 0;
  for (const entry of manifest) {
    i++;
    const svgPath = resolve(CLIPART_DIR, `${entry.id}.svg`);
    if (!existsSync(svgPath)) {
      console.log(`[${i}/${manifest.length}] ${entry.id}: SVG missing — dropping from manifest`);
      missing.push(entry);
      if (!args.dryRun) {
        logRejection(entry, args.rescreenReason, 'svg-file-missing');
      }
      continue;
    }
    const svgText = readFileSync(svgPath, 'utf8');
    let verdict: ScreeningVerdict;
    try {
      verdict = await screener.screen(svgText);
    } catch (e) {
      console.log(`[${i}/${manifest.length}] ${entry.id}: screening error — keeping (manual review)`);
      console.error(`  error: ${(e as Error).message}`);
      kept.push(entry);
      continue;
    }
    if (verdict.ok) {
      console.log(`[${i}/${manifest.length}] ${entry.id}: ✓ pass`);
      kept.push(entry);
    } else {
      const detail = fmtVerdict(verdict);
      console.log(`[${i}/${manifest.length}] ${entry.id}: ✗ FAIL (${detail})`);
      removed.push({ entry, detail });
    }
  }

  await screener.close();

  console.log('');
  console.log(`rescreen summary:`);
  console.log(`  kept:    ${kept.length}`);
  console.log(`  removed: ${removed.length}`);
  console.log(`  missing: ${missing.length} (manifest entries with no SVG on disk)`);

  if (args.dryRun) {
    console.log('');
    console.log('--dry-run: no files modified.');
    return;
  }

  // Apply removals: delete SVG + PNG, append rejections.jsonl line.
  for (const { entry, detail } of removed) {
    const svgPath = resolve(CLIPART_DIR, `${entry.id}.svg`);
    const pngPath = resolve(CLIPART_DIR, `${entry.id}.png`);
    if (existsSync(svgPath)) unlinkSync(svgPath);
    if (existsSync(pngPath)) unlinkSync(pngPath);
    logRejection(entry, args.rescreenReason, detail);
  }

  // Re-rank survivors by their existing rank order so picker sort
  // is stable; ties broken by id for determinism.
  kept.sort((a, b) => (a.rank - b.rank) || a.id.localeCompare(b.id));
  kept.forEach((e, idx) => { e.rank = idx + 1; });
  writeFileSync(MANIFEST_PATH, JSON.stringify(kept, null, 2) + '\n');
  console.log(`wrote manifest with ${kept.length} entries`);
  console.log(`appended ${removed.length + missing.length} rejection lines to rejections.jsonl`);
}

main().catch(err => {
  console.error('rescreen failed:', err);
  process.exit(1);
});
