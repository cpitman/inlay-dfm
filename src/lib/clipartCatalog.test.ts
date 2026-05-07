import { describe, it, expect } from 'vitest';
import { searchCatalog, type ClipartManifestEntry } from './clipartCatalog';

function entry(partial: Partial<ClipartManifestEntry> & { id: string; title: string; tags: string[]; rank: number }): ClipartManifestEntry {
  return {
    source: 'openclipart',
    sourceUrl: `https://openclipart.org/detail/${partial.id}`,
    license: 'CC0',
    colorCount: 1,
    colors: ['#000000'],
    aspectRatio: 1,
    ...partial,
  };
}

describe('searchCatalog', () => {
  const catalog: ClipartManifestEntry[] = [
    entry({ id: 'fox',       title: 'Fox',           tags: ['animal', 'wild'],     rank: 1 }),
    entry({ id: 'dog',       title: 'Dog',           tags: ['animal', 'pet'],      rank: 2 }),
    entry({ id: 'cat-paw',   title: 'Cat Paw',       tags: ['animal', 'pet'],      rank: 3 }),
    entry({ id: 'tree-1',    title: 'Oak Tree',      tags: ['plant', 'tree'],      rank: 4 }),
    entry({ id: 'tree-2',    title: 'Pine Tree',     tags: ['plant', 'tree'],      rank: 100 }),
  ];

  it('empty query returns the full catalog sorted by rank', () => {
    const out = searchCatalog(catalog, '');
    expect(out.map(e => e.id)).toEqual(['fox', 'dog', 'cat-paw', 'tree-1', 'tree-2']);
  });

  it('whitespace-only query is treated as empty', () => {
    const out = searchCatalog(catalog, '   ');
    expect(out.map(e => e.id)).toEqual(['fox', 'dog', 'cat-paw', 'tree-1', 'tree-2']);
  });

  it('matches by title substring case-insensitively', () => {
    const out = searchCatalog(catalog, 'tree');
    expect(out.map(e => e.id)).toEqual(['tree-1', 'tree-2']);
  });

  it('title hits outrank tag-only hits', () => {
    // "Fox" title starts with the query; tag-only matches ('animal') for the others.
    const out = searchCatalog(catalog, 'fox');
    expect(out[0].id).toBe('fox');
  });

  it('title-only hits beat tag-only hits even when tag entry has lower rank', () => {
    // "dog" matches "Dog" by title (rank 2) AND tag "dog" doesn't exist
    // anywhere — but if it did, title would win regardless of rank.
    const titleAndTag = [
      entry({ id: 'dog-house', title: 'Dog House', tags: ['shelter'],       rank: 50 }),
      entry({ id: 'kennel',    title: 'Kennel',    tags: ['dog', 'shelter'], rank: 1 }),
    ];
    const out = searchCatalog(titleAndTag, 'dog');
    expect(out.map(e => e.id)).toEqual(['dog-house', 'kennel']);
  });

  it('matches by tag when title does not contain the term', () => {
    const out = searchCatalog(catalog, 'pet');
    expect(out.map(e => e.id)).toEqual(['dog', 'cat-paw']);
  });

  it('multi-token query requires every token to match somewhere', () => {
    // "oak tree" — both tokens hit "Oak Tree" by title; only tree hits Pine Tree
    // by title (oak doesn't appear in Pine entry's title or tags), so Pine drops.
    const out = searchCatalog(catalog, 'oak tree');
    expect(out.map(e => e.id)).toEqual(['tree-1']);
  });

  it('returns empty array when no entries match', () => {
    const out = searchCatalog(catalog, 'submarine');
    expect(out).toEqual([]);
  });

  it('among equal-score matches, lower rank wins (lighter tiebreak)', () => {
    // 'plant' tag matches both tree entries equally (1 tag hit each, 0 title hits).
    // Lower rank should appear first.
    const out = searchCatalog(catalog, 'plant');
    expect(out.map(e => e.id)).toEqual(['tree-1', 'tree-2']);
  });
});
