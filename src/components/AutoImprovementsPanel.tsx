'use client';

import type { AnalysisResult, WoodConfig } from '@/types';

interface AutoImprovementsPanelProps {
  result: AnalysisResult;
  woodConfigs: WoodConfig[];
  busy: boolean;
  onExtendAll: (colorHexes: string[]) => void;
  onFillAll: (colorHexes: string[]) => void;
}

/**
 * Top-of-Step-2 summary card surfacing the two automatic improvements that
 * apply across the whole design at once. Clicking each button applies the
 * fix to *every* eligible layer in a single undoable action — equivalent to
 * walking the per-wood panels below and clicking each button individually,
 * but folded into a single snapshot.
 *
 * Hidden entirely when neither improvement applies; clicking each button is
 * disabled when no layer would benefit.
 */
export default function AutoImprovementsPanel({
  result, woodConfigs, busy, onExtendAll, onFillAll,
}: AutoImprovementsPanelProps) {
  const labelOf = (colorHex: string) =>
    woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;

  const extendCandidates = result.woods
    .filter(w => w.alignmentIssues.length > 0)
    .map(w => w.colorHex);

  const fillCandidates = result.woods
    .filter(w => w.fillableHoleCount > 0)
    .map(w => w.colorHex);

  const totalFillableHoles = result.woods.reduce((s, w) => s + w.fillableHoleCount, 0);
  const totalFillableArea  = result.woods.reduce((s, w) => s + w.fillableHoleAreaSqIn, 0);
  const totalSavedTime = result.woods.reduce((s, w) =>
    s + (isFinite(w.fillableSavedTimeMin) ? w.fillableSavedTimeMin : 0), 0);

  if (extendCandidates.length === 0 && fillCandidates.length === 0) return null;

  return (
    <section className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-200">Auto-improvements</span>
        <span className="text-xs text-slate-500">
          One-click DFM fixes that apply to every eligible layer.
        </span>
      </div>

      {extendCandidates.length > 0 && (
        <div className="border border-fuchsia-700/60 rounded-lg bg-fuchsia-900/20 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-fuchsia-300 flex items-center gap-1.5">
            <span>⚠</span>
            Staged alignment risk on {extendCandidates.length} layer{extendCandidates.length === 1 ? '' : 's'}
          </p>
          <p className="text-xs text-fuchsia-200">
            {extendCandidates.map(labelOf).join(', ')} — edges within{' '}
            <strong>{(result.alignmentThresholdInches * 1000).toFixed(0)} thou</strong>{' '}
            of a later layer's edge. Extending under later layers eliminates visible misregistration.
          </p>
          <div className="pt-1.5">
            <button
              onClick={() => onExtendAll(extendCandidates)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs font-medium bg-fuchsia-700 hover:bg-fuchsia-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Working…' : `Extend ${extendCandidates.length} layer${extendCandidates.length === 1 ? '' : 's'}`}
            </button>
            <span className="ml-2 text-xs text-fuchsia-500">
              Each layer extended 0.05" under later inlays.
            </span>
          </div>
        </div>
      )}

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
