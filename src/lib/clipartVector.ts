import type { VectorData, WoodSpeciesKey } from '@/types';
import { parseSvg } from './vectorParser';
import type { ClipartManifestEntry } from './clipartCatalog';

/**
 * Saved selection for a clipart-based design. Round-trips through
 * `sessionExport` so the user can re-open the picker and switch wood
 * species per color, or swap to a different clipart entry, without
 * losing the original choice. The synthesized `VectorData` is also
 * preserved on the design itself; this spec is just the "user
 * intent" record.
 *
 * `selectedSpecies` is keyed by the catalog entry's detected color
 * hexes — the user picks one inlay species per color. v1 always
 * populates every detected color; missing keys fall through to the
 * `pickPricedSpecies` default at hydrate time.
 */
export interface ClipartSpec {
  /** Catalog entry id (`ClipartManifestEntry.id`). */
  id: string;
  /** colorHex → species mapping. Lowercased hex keys. */
  selectedSpecies: Record<string, WoodSpeciesKey>;
}

/**
 * Fetch a clipart SVG by id from `/clipart/{id}.svg`, wrap it in a
 * synthetic `File`, and run it through the existing `parseSvg`
 * pipeline. The result is byte-for-byte indistinguishable from an
 * uploaded SVG to the rest of the system — `fileType` is `'svg'`,
 * downstream consumers don't branch on source.
 *
 * Sets `fileName` to a sluggable derivative of the entry's title so
 * the design-list label reads as "Fox Running" rather than the raw
 * `fox-running.svg` filename.
 */
export async function clipartToVectorData(entry: ClipartManifestEntry): Promise<VectorData> {
  const url = `/clipart/${entry.id}.svg`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load clipart "${entry.id}": HTTP ${res.status}`);
  }
  const svgText = await res.text();
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const file = new File([blob], `${entry.id}.svg`, { type: 'image/svg+xml' });
  const vector = await parseSvg(file);
  return { ...vector, fileName: entry.title };
}
