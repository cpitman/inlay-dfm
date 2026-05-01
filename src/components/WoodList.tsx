'use client';

import type { WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES, WOOD_SPECIES_ORDER } from '@/lib/woodSpecies';

interface WoodListProps {
  woodConfigs: WoodConfig[];
  onUpdate: (colorHex: string, patch: Partial<WoodConfig>) => void;
  onMove: (index: number, dir: -1 | 1) => void;
}

/**
 * Lightweight per-color editor for Step 1 (Design): label, species, z-order.
 * Order in the list is the inlay z-order (top of list = carved first / under
 * later layers; matches the existing convention everywhere else in the app).
 *
 * No overlays, no Extend / Fill / Reset — those are Step 2 (DFM) concerns
 * and live in the heavier WoodPanel component.
 */
export default function WoodList({ woodConfigs, onUpdate, onMove }: WoodListProps) {
  if (woodConfigs.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {woodConfigs.map((wc, i) => (
        <div
          key={wc.colorHex}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2"
        >
          <div className="flex flex-col gap-0.5 shrink-0">
            <button
              onClick={() => onMove(i, -1)}
              disabled={i === 0}
              className="w-5 h-4 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
              title="Move up (carved earlier)"
            >
              <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
                <path d="M6 2l5 7H1z" />
              </svg>
            </button>
            <button
              onClick={() => onMove(i, 1)}
              disabled={i === woodConfigs.length - 1}
              className="w-5 h-4 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
              title="Move down (carved later)"
            >
              <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor">
                <path d="M6 10L1 3h10z" />
              </svg>
            </button>
          </div>

          <span
            className="w-4 h-4 rounded shrink-0 border border-slate-600"
            style={{ background: wc.colorHex }}
            title={wc.colorHex}
          />

          <input
            type="text"
            value={wc.label}
            onChange={e => onUpdate(wc.colorHex, { label: e.target.value })}
            className="bg-transparent text-slate-200 font-semibold text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 min-w-0 flex-1"
          />

          <select
            value={wc.species}
            onChange={e => onUpdate(wc.colorHex, { species: e.target.value as WoodSpeciesKey })}
            className="bg-slate-700 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {WOOD_SPECIES_ORDER.map(key => (
              <option key={key} value={key}>{WOOD_SPECIES[key].name}</option>
            ))}
          </select>

          <span
            className="w-4 h-4 rounded shrink-0 border border-slate-600"
            style={{ background: WOOD_SPECIES[wc.species].baseHex }}
            title={WOOD_SPECIES[wc.species].name}
          />
        </div>
      ))}
    </div>
  );
}
