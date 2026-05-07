/**
 * Local-server moderation tool for the clipart library. Iterates
 * non-moderated entries from `public/clipart/manifest.json`, lets
 * the operator approve or reject each one with a button click (or
 * the Y / N keys).
 *
 * On approve: the slug is recorded in `moderation.json`. On reject:
 * the manifest entry is removed, the SVG + PNG files are deleted,
 * the slug is appended to `manual-rejections.jsonl` (audit log),
 * and the originating source-id is marked rejected in the scraper's
 * `checkpoint.json` so re-runs skip it.
 *
 * Usage:
 *   npx tsx scripts/clipart/moderate.ts
 *   → open http://localhost:3050 in a browser.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT       = resolve(__dirname, '..', '..');
const CLIPART_DIR     = resolve(REPO_ROOT, 'public', 'clipart');
const MANIFEST_PATH   = resolve(CLIPART_DIR, 'manifest.json');
const MODERATION_PATH = resolve(__dirname, 'moderation.json');
const REJECTIONS_PATH = resolve(__dirname, 'manual-rejections.jsonl');
const CHECKPOINT_PATH = resolve(__dirname, 'checkpoint.json');
const HTML_PATH       = resolve(__dirname, 'moderate.html');

const PORT = 3050;

interface ManifestEntry {
  id: string;
  title: string;
  tags: string[];
  source: string;
  sourceUrl: string;
  license: string;
  colorCount: number;
  colors: string[];
  aspectRatio: number;
  rank: number;
}

interface Moderation {
  approved: string[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const moderation: Moderation = existsSync(MODERATION_PATH)
  ? JSON.parse(readFileSync(MODERATION_PATH, 'utf8'))
  : { approved: [] };

function saveManifest(): void {
  // Re-rank sequentially when entries change.
  manifest = manifest.map((e, i) => ({ ...e, rank: i + 1 }));
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function saveModeration(): void {
  writeFileSync(MODERATION_PATH, JSON.stringify(moderation, null, 2));
}

function nextEntry(): ManifestEntry | null {
  const approved = new Set(moderation.approved);
  for (const e of manifest) {
    if (!approved.has(e.id)) return e;
  }
  return null;
}

function progress() {
  return { done: moderation.approved.length, total: manifest.length };
}

function approve(slug: string): void {
  if (!moderation.approved.includes(slug)) {
    moderation.approved.push(slug);
    saveModeration();
  }
}

function reject(slug: string): void {
  const entry = manifest.find(e => e.id === slug);
  if (!entry) return;

  // Drop manifest entry + delete static files.
  manifest = manifest.filter(e => e.id !== slug);
  saveManifest();
  for (const ext of ['svg', 'png']) {
    const p = resolve(CLIPART_DIR, `${slug}.${ext}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* best-effort */ }
    }
  }

  // Audit log (append-only).
  appendFileSync(REJECTIONS_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    slug,
    title: entry.title,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    reason: 'manual-moderation',
  }) + '\n');

  // Mark in scraper's checkpoint so re-runs skip this candidate.
  // Source-id derived from openclipart URL pattern; other sources
  // use a slug-based fallback so the entry at least has a checkpoint
  // record (the scraper's `cached?.status === 'rejected'` skip works
  // by id, and the scrape adapters use the same id format).
  const sourceId = deriveSourceId(entry.source, entry.sourceUrl, slug);
  if (sourceId) {
    const cp = existsSync(CHECKPOINT_PATH)
      ? JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'))
      : { entries: {} };
    cp.entries ??= {};
    cp.entries[sourceId] = {
      status: 'rejected',
      reason: 'manual-moderation',
    };
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
  }

  // Drop any approved record (defensive — shouldn't be there, but
  // a rejected entry must not show up as approved on reload).
  const idx = moderation.approved.indexOf(slug);
  if (idx >= 0) {
    moderation.approved.splice(idx, 1);
    saveModeration();
  }
}

function deriveSourceId(source: string, sourceUrl: string, slug: string): string | null {
  const m = sourceUrl.match(/openclipart\.org\/detail\/(\d+)/);
  if (m) return `openclipart-${m[1]}`;
  if (source && slug) return `${source}-${slug}`;
  return null;
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => res(body));
    req.on('error', rej);
  });
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const MIME: Record<string, string> = {
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json',
  '.html': 'text/html',
};

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML_PATH));
    return;
  }

  if (url.startsWith('/clipart/')) {
    const filePath = resolve(CLIPART_DIR, url.slice('/clipart/'.length));
    if (!filePath.startsWith(CLIPART_DIR) || !existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(readFileSync(filePath));
    return;
  }

  if (url === '/api/next' && req.method === 'GET') {
    sendJson(res, 200, { entry: nextEntry(), ...progress() });
    return;
  }

  if (url === '/api/approve' && req.method === 'POST') {
    const { id } = JSON.parse(await readBody(req));
    approve(id);
    sendJson(res, 200, { entry: nextEntry(), ...progress() });
    return;
  }

  if (url === '/api/reject' && req.method === 'POST') {
    const { id } = JSON.parse(await readBody(req));
    reject(id);
    sendJson(res, 200, { entry: nextEntry(), ...progress() });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  const remaining = manifest.length - moderation.approved.length;
  console.log(`Moderation server: http://localhost:${PORT}/`);
  console.log(`  manifest: ${manifest.length} entries · approved: ${moderation.approved.length} · remaining: ${remaining}`);
});
