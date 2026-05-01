'use client';

import type { AnalysisResult } from '@/types';
import { findFastestFeasibleCell, formatMinutes } from '@/lib/machiningTime';

interface RecommendedSetupCardProps {
  result: AnalysisResult;
  /** Current strategy diameters (descending). Empty = v-bit only. */
  currentStrategyDiameters: number[];
  currentVbitAngle: number;
  toolChangeMinutes: number;
  onApply: (strategyDiameters: number[], vbitAngle: number) => void;
}

function strategiesMatch(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Top-of-Step-4 prominent display of the optimal bit combination — the
 * fastest feasible (clearance strategy × v-bit) across every preset
 * combination in the matrix, including tool-change overhead.
 *
 * If the user's current selection is already the recommended combo, shows
 * a "currently selected" confirmation. Otherwise shows an Apply button to
 * switch in one click. The matrix below remains the place to explore
 * trade-offs.
 */
export default function RecommendedSetupCard({
  result, currentStrategyDiameters, currentVbitAngle, toolChangeMinutes, onApply,
}: RecommendedSetupCardProps) {
  const best = findFastestFeasibleCell(result.machiningTimeTable, toolChangeMinutes);

  if (!best) {
    return (
      <section className="bg-red-900/40 border-2 border-red-700 rounded-lg p-5">
        <div className="flex items-start gap-4">
          <span className="text-3xl shrink-0 leading-none text-red-300">✗</span>
          <div className="space-y-1">
            <p className="text-lg font-bold text-red-200">No feasible bit combination</p>
            <p className="text-sm text-red-100">
              No (clearance × v-bit) combination produces a feasible carve. Revisit Step 2 to
              identify regions that block every v-bit angle, then retry.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const bestStrategy = result.machiningTimeTable.strategies[best.strategyIdx];
  const isSelected = strategiesMatch(best.strategyDiameters, currentStrategyDiameters)
    && best.vbitAngleDegrees === currentVbitAngle;

  return (
    <section className="bg-emerald-900/40 border-2 border-emerald-700 rounded-lg p-5">
      <div className="flex items-start gap-4">
        <span className="text-3xl shrink-0 leading-none text-emerald-300">★</span>
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-emerald-300 uppercase tracking-wider">
            Recommended setup
          </p>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-2xl font-bold text-white">
              {bestStrategy.label}
              <span className="text-emerald-400 mx-2">·</span>
              {best.vbitAngleDegrees}° v-bit
            </span>
            <span className="text-xl font-semibold text-emerald-200">
              {formatMinutes(best.totalTimeMinutes)}
            </span>
          </div>
          <p className="text-sm text-emerald-100">
            Fastest feasible across {result.machiningTimeTable.strategies.length} clearance strategies
            {' '}× {result.machiningTimeTable.vbits.length} v-bit angles, including
            {' '}{(bestStrategy.bitCount * toolChangeMinutes).toFixed(1)} min of tool changes
            {' '}({bestStrategy.bitCount} bit{bestStrategy.bitCount === 1 ? '' : 's'}).
          </p>
          {isSelected ? (
            <p className="text-xs text-emerald-300 font-semibold">✓ Currently selected</p>
          ) : (
            <button
              onClick={() => onApply(best.strategyDiameters, best.vbitAngleDegrees)}
              className="px-4 py-2 rounded-md text-sm font-semibold bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              Use this setup
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
