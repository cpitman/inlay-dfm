'use client';

import type { AnalysisResult, WoodConfig } from '@/types';

interface AutoImprovementsPanelProps {
  result: AnalysisResult;
  woodConfigs: WoodConfig[];
  busy: boolean;
  onFillAll: (colorHexes: string[]) => void;
}

/**
 * Top-of-Step-2 summary card surfacing one-click automatic improvements
 * that apply across the whole design at once. Clicking the button applies
 * the fix to *every* eligible layer in a single undoable action.
 *
 * Hidden entirely when no improvement applies.
 */
export default function AutoImprovementsPanel({
  result, woodConfigs, busy, onFillAll,
}: AutoImprovementsPanelProps) {
  const labelOf = (colorHex: string) =>
    woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;

  const fillCandidates = result.woods
    .filter(w => w.fillableHoleCount > 0)
    .map(w => w.colorHex);

  const totalFillableHoles = result.woods.reduce((s, w) => s + w.fillableHoleCount, 0);
  const totalFillableArea  = result.woods.reduce((s, w) => s + w.fillableHoleAreaSqIn, 0);
  const totalSavedTime = result.woods.reduce((s, w) =>
    s + (isFinite(w.fillableSavedTimeMin) ? w.fillableSavedTimeMin : 0), 0);

  if (fillCandidates.length === 0) return null;

  return (
    <section className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-200">Auto-improvements</span>
        <span className="text-xs text-slate-500">
          One-click DFM fixes that apply to every eligible layer.
        </span>
      </div>

      {fillCandidates.length > 0 && (
        <div className="border border-cyan-700/60 rounded-lg bg-cyan-900/20 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-cyan-300 flex items-center gap-1.5">
            <span>○</span>
            Fillable enclosed holes — {totalFillableHoles} hole{totalFillableHoles === 1 ? '' : 's'} ({totalFillableArea.toFixed(2)} in²)
          </p>
          <p className="text-xs text-cyan-200">
            Holes in {fillCandidates.map(labelOf).join(', ')} are completely covered by later inlay
            layers — invisible in the final design.
            {totalSavedTime > 0 && (
              <> Filling them saves approximately <strong>{totalSavedTime.toFixed(1)} min</strong> of v-bit perimeter time.</>
            )}
          </p>
          <div className="pt-1.5">
            <button
              onClick={() => onFillAll(fillCandidates)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs font-medium bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Working…' : `Fill ${totalFillableHoles} hole${totalFillableHoles === 1 ? '' : 's'}`}
            </button>
            <span className="ml-2 text-xs text-cyan-500">
              Removes v-bit perimeter passes the bit would otherwise trace.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
