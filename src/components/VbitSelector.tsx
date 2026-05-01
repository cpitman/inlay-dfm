'use client';

import type { MachiningTimeMatrix } from '@/types';

interface VbitSelectorProps {
  vbits: MachiningTimeMatrix['vbits'];
  selectedAngle: number;
  recommendedAngle: number | null;
  onSelect: (angle: number) => void;
}

/**
 * Step 3's preset v-bit picker. Each preset shows feasibility status with a
 * colored dot, and infeasible presets show how much of the design they can't
 * reach. The widest feasible preset is badged "Recommended" — that's the
 * fastest bit the design currently supports.
 *
 * Selection commits to settings.vbitAngleDegrees immediately. The cached
 * analysis stays valid because every preset's overlay is pre-built into
 * WoodAnalysis.perPresetAnalysis — switching is just a URL swap.
 */
export default function VbitSelector({
  vbits, selectedAngle, recommendedAngle, onSelect,
}: VbitSelectorProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {vbits.map(v => {
          const selected   = v.angleDegrees === selectedAngle;
          const recommended = v.angleDegrees === recommendedAngle;

          // Status: feasible (green), warn (under 10% but has isolated comp),
          // infeasible (red).
          const status: 'feasible' | 'infeasible' =
            v.feasible ? 'feasible' : 'infeasible';
          const statusColor = status === 'feasible' ? 'text-emerald-400' : 'text-red-400';
          const statusGlyph = status === 'feasible' ? '✓' : '✗';

          return (
            <button
              key={v.angleDegrees}
              onClick={() => onSelect(v.angleDegrees)}
              className={`relative px-3 py-3 rounded-md border text-center transition-colors
                ${selected
                  ? 'bg-blue-600 border-blue-400 text-white ring-2 ring-blue-400/40'
                  : 'bg-slate-800 border-slate-600 text-slate-200 hover:border-slate-400'}`}
            >
              {recommended && (
                <span
                  className="absolute -top-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-emerald-500 text-emerald-950 text-[10px] font-bold uppercase tracking-wide whitespace-nowrap"
                  title="Widest preset that's feasible for this design — typically the fastest bit you can use."
                >
                  Recommended
                </span>
              )}
              <div className="text-xl font-bold leading-tight">{v.angleDegrees}°</div>
              <div className={`text-[11px] mt-1 ${selected ? 'text-blue-100' : statusColor} flex items-center justify-center gap-1`}>
                <span>{statusGlyph}</span>
                {v.feasible
                  ? <span>feasible</span>
                  : v.hasIsolatedComponent
                    ? <span>can't reach all</span>
                    : <span>{v.maxProblemAreaPercent.toFixed(1)}% unreached</span>}
              </div>
              <div className={`text-[10px] mt-0.5 ${selected ? 'text-blue-200' : 'text-slate-500'}`}>
                {v.feed > 0 ? `${v.feed.toFixed(0)} in/min` : '—'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
