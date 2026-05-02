'use client';

import type { WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from '@/lib/woodSpecies';
import { INLAY_WOOD_OPTIONS, INLAY_WOOD_PRICE } from '@/lib/pricing';

interface InlayColorPickerProps {
  woodConfigs: WoodConfig[];
  onUpdate: (colorHex: string, patch: Partial<WoodConfig>) => void;
}

/**
 * Per-detected-color species selector for the guided quote experience.
 * Limited to the 5 priced inlay species (maple, cherry, walnut,
 * purpleheart, padauk). Each row shows the original SVG color, the
 * chosen wood swatch, and the per-inlay material cost so the user can
 * see what each pick contributes.
 *
 * No labels/move-up controls (unlike the expert WoodList) — the
 * optimization pipeline reorders layers automatically and consumer
 * users don't need to name them.
 */
export default function InlayColorPicker({ woodConfigs, onUpdate }: InlayColorPickerProps) {
  if (woodConfigs.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {woodConfigs.map(wc => {
        const sp = WOOD_SPECIES[wc.species];
        const price = INLAY_WOOD_PRICE[wc.species] ?? null;
        return (
          <div
            key={wc.colorHex}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2"
          >
            <span
              className="w-4 h-4 rounded shrink-0 border border-slate-600"
              style={{ background: wc.colorHex }}
              title={wc.colorHex}
            />
            <span className="text-slate-500 text-xs">→</span>
            <span
              className="w-4 h-4 rounded shrink-0 border border-slate-600"
              style={{ background: sp.baseHex }}
              title={sp.name}
            />
            <select
              value={wc.species}
              onChange={e => onUpdate(wc.colorHex, { species: e.target.value as WoodSpeciesKey })}
              className="flex-1 bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              aria-label={`Wood for ${wc.colorHex}`}
            >
              {INLAY_WOOD_OPTIONS.map(key => (
                <option key={key} value={key}>{WOOD_SPECIES[key as WoodSpeciesKey].name}</option>
              ))}
            </select>
            {price !== null && (
              <span className="text-xs text-slate-500 tabular-nums">${price}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
