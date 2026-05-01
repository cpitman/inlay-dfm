'use client';

import type { WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from '@/lib/woodSpecies';
import { speciesTextColor } from '@/lib/woodSpecies';

interface CompositeViewProps {
  dataUrl: string | null;
  generating: boolean;
  woodConfigs: WoodConfig[];
  backgroundSpecies: WoodSpeciesKey;
}

function Swatch({ hex, label }: { hex: string; label: string }) {
  const textColor = speciesTextColor(hex);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="w-5 h-5 rounded shrink-0 border border-slate-600"
        style={{ background: hex }}
      />
      <span className="text-slate-300">{label}</span>
    </div>
  );
}

export default function CompositeView({
  dataUrl, generating, woodConfigs, backgroundSpecies,
}: CompositeViewProps) {
  const bg = WOOD_SPECIES[backgroundSpecies];

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 bg-slate-800 rounded-lg px-4 py-3">
        <Swatch hex={bg.baseHex} label={`Background — ${bg.name}`} />
        {woodConfigs.map((wc, i) => {
          const sp = WOOD_SPECIES[wc.species];
          return (
            <Swatch
              key={wc.colorHex}
              hex={sp.baseHex}
              label={`${i + 1}. ${wc.label} — ${sp.name}`}
            />
          );
        })}
      </div>

      {/* Image */}
      <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-slate-900">
        {generating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/80 z-10">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-slate-400">Rendering composite…</p>
          </div>
        )}
        {dataUrl ? (
          <img src={dataUrl} alt="Composite design preview" className="w-full h-auto" />
        ) : !generating ? (
          <div className="flex items-center justify-center min-h-64 text-slate-500 text-sm">
            No composite available
          </div>
        ) : (
          <div className="min-h-64" />
        )}
      </div>
    </div>
  );
}
