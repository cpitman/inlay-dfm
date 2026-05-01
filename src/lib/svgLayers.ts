import type { Layer } from '@/types';

/** Wrap a single layer's fragment as a standalone, renderable SVG document. */
export function layerToStandaloneSvg(layer: Layer, viewBox: string, w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">
${layer.svgFragment}
</svg>`;
}

/**
 * Combine per-layer SVG fragments into a single rendered SVG. Layers are emitted
 * in the order given — later layers stack on top of earlier ones (matches the
 * staged-inlay z-order: earlier inlay extensions are covered by later inlays).
 */
export function combineLayers(layers: Layer[], viewBox: string, w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">
${layers.map(l => l.svgFragment).join('\n')}
</svg>`;
}

/** Replace one layer's fragment by colorHex. Returns a new array; original is untouched. */
export function replaceLayerFragment(layers: Layer[], colorHex: string, svgFragment: string): Layer[] {
  return layers.map(l => (l.colorHex === colorHex ? { ...l, svgFragment } : l));
}

/** Reorder layers to match a given colorHex order. Unmatched layers keep their original index. */
export function reorderLayers(layers: Layer[], colorOrder: string[]): Layer[] {
  const map = new Map(layers.map(l => [l.colorHex, l]));
  const ordered: Layer[] = [];
  for (const c of colorOrder) {
    const l = map.get(c);
    if (l) { ordered.push(l); map.delete(c); }
  }
  // Append any layers not mentioned in colorOrder (defensive)
  for (const l of map.values()) ordered.push(l);
  return ordered;
}
