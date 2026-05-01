'use client';

import type { AnalysisResult } from '@/types';
import { findFastestFeasibleCell, formatMinutes } from '@/lib/machiningTime';

interface RecommendedSetupCardProps {
  result: AnalysisResult;
  currentClearanceDiameter: number;
  currentVbitAngle: number;
  onApply: (clearanceDiameter: number, vbitAngle: number) => void;
}

const CLEARANCE_LABEL: Record<number, string> = {
  0.125: '1/8"',
  0.25:  '1/4"',
  0.5:   '1/2"',
};

function clearanceLabel(d: number): string {
  return CLEARANCE_LABEL[d] ?? `${d.toFixed(3)}"`;
}

/**
 * Top-of-Step-4 prominent display of the optimal bit combination — the
 * fastest feasible (clearance, v-bit) across every preset combination in
 * the matrix.
 *
 * If the user's current selection is already the recommended combo, shows
 * a "currently selected" confirmation. Otherwise shows an Apply button to
 * switch in one click. The matrix below remains the place to explore
 * trade-offs.
 *
 * Red error state when no combination is feasible — should be rare since
 * Step 2 / Step 3 already surface this, but covered for safety.
 */
export default function RecommendedSetupCard({
  result, currentClearanceDiameter, currentVbitAngle, onApply,
}: RecommendedSetupCardProps) {
  const best = findFastestFeasibleCell(result.machiningTimeTable);

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

  const isSelected = best.clearanceDiameterInches === currentClearanceDiameter
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
              {clearanceLabel(best.clearanceDiameterInches)} clearance
              <span className="text-emerald-400 mx-2">·</span>
              {best.vbitAngleDegrees}° v-bit
            </span>
            <span className="text-xl font-semibold text-emerald-200">
              {formatMinutes(best.totalTimeMinutes)}
            </span>
          </div>
          <p className="text-sm text-emerald-100">
            Fastest feasible across {result.machiningTimeTable.clearanceBits.length} clearance bits
            {' '}× {result.machiningTimeTable.vbits.length} v-bit angles. The matrix below shows
            how every combination compares.
          </p>
          {isSelected ? (
            <p className="text-xs text-emerald-300 font-semibold">✓ Currently selected</p>
          ) : (
            <button
              onClick={() => onApply(best.clearanceDiameterInches, best.vbitAngleDegrees)}
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
