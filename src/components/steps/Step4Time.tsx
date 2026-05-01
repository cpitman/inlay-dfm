'use client';

import type { AnalysisResult, DFMSettings } from '@/types';
import {
  CLEARANCE_BIT_OPTIONS, CLEARANCE_BIT_MRR,
  type ClearanceBitDiameter,
} from '@/lib/machiningRates';
import { formatMinutes } from '@/lib/machiningTime';
import BitMatrixTable from '../BitMatrixTable';
import RecommendedSetupCard from '../RecommendedSetupCard';
import { StepNav } from '../StepperBar';

interface Step4TimeProps {
  result: AnalysisResult | null;
  settings: DFMSettings;
  onSettingsChange: (s: DFMSettings) => void;
  onBack: () => void;
}

const CLEARANCE_BIT_LABELS: Record<ClearanceBitDiameter, string> = {
  0.125: '1/8"',
  0.25:  '1/4"',
  0.5:   '1/2"',
};

/**
 * Step 4 — Machining time exploration.
 *
 * Tops with a prominent RecommendedSetupCard naming the fastest feasible
 * (clearance, v-bit) combination. Below: the existing clearance-bit picker
 * and the full BitMatrixTable for exploring trade-offs. Total time at the
 * top derives from the matrix at the current selection so it stays in sync
 * when Step 3 changes the v-bit angle.
 */
export default function Step4Time({
  result, settings, onSettingsChange, onBack,
}: Step4TimeProps) {
  const set = <K extends keyof DFMSettings>(k: K, v: DFMSettings[K]) =>
    onSettingsChange({ ...settings, [k]: v });

  const applyRecommendation = (clearanceDiameter: number, vbitAngle: number) => {
    onSettingsChange({
      ...settings,
      clearanceBitDiameterInches: clearanceDiameter as ClearanceBitDiameter,
      vbitAngleDegrees: vbitAngle,
      // Switching to a preset clears any custom rates so the analyzer uses
      // the canonical table values from machiningRates.ts.
      vbitMRRInches3PerMin: undefined,
      vbitFeedInchesPerMin: undefined,
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
        {/* Recommended setup — fastest feasible combo, with one-click apply */}
        {result && (
          <RecommendedSetupCard
            result={result}
            currentClearanceDiameter={settings.clearanceBitDiameterInches}
            currentVbitAngle={settings.vbitAngleDegrees}
            onApply={applyRecommendation}
          />
        )}

        {/* Total time header — derived from the matrix at the current
            (clearance, v-bit) selection so it stays in sync when Step 3
            changes the angle without re-running analysis. */}
        {result && (() => {
          const matrix = result.machiningTimeTable;
          const ci = matrix.clearanceBits.findIndex(b => b.diameterInches === settings.clearanceBitDiameterInches);
          const vi = matrix.vbits.findIndex(v => v.angleDegrees === settings.vbitAngleDegrees);
          const t = (ci >= 0 && vi >= 0) ? matrix.times[ci][vi] : NaN;
          return (
            <div className="bg-slate-800 rounded-lg px-4 py-3 text-sm flex flex-wrap gap-x-6 gap-y-2 items-center">
              <span>
                <span className="text-slate-400">Total machine time</span>
                <span className="ml-2 font-semibold text-white text-base">
                  {isFinite(t) ? formatMinutes(t) : '—'}
                </span>
                {!isFinite(t) && (
                  <span className="ml-2 text-amber-400 text-xs">
                    (combination is infeasible — pick another row/column below)
                  </span>
                )}
              </span>
              <span className="text-slate-500 text-xs">
                {settings.vbitAngleDegrees}° v-bit · {CLEARANCE_BIT_LABELS[settings.clearanceBitDiameterInches]} clearance
              </span>
            </div>
          );
        })()}

        {/* Clearance bit picker */}
        <section>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Clearance Bit
          </h2>
          <p className="text-sm text-slate-400 mb-3">
            Bigger clearance bits clear bulk material faster but leave more for the
            v-bit to finish. The matrix below shows total time across every combination.
          </p>
          <div className="flex gap-2">
            {CLEARANCE_BIT_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => set('clearanceBitDiameterInches', d)}
                className={`flex-1 py-2 rounded-md text-sm font-semibold border transition-colors
                  ${settings.clearanceBitDiameterInches === d
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
              >
                {CLEARANCE_BIT_LABELS[d]}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            MRR {CLEARANCE_BIT_MRR[settings.clearanceBitDiameterInches].toFixed(2)} in³/min
            for the selected bit.
          </p>
        </section>

        {/* Bit-comparison matrix */}
        {result && (
          <section>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Bit Combinations
            </h2>
            <BitMatrixTable
              matrix={result.machiningTimeTable}
              currentClearanceDiameter={settings.clearanceBitDiameterInches}
              currentVbitAngle={settings.vbitAngleDegrees}
              onSelectCombination={(clearanceDiameter, vbitAngle) => {
                onSettingsChange({
                  ...settings,
                  clearanceBitDiameterInches: clearanceDiameter as ClearanceBitDiameter,
                  vbitAngleDegrees: vbitAngle,
                  // Switching to a preset V-bit clears any custom rates so
                  // the analyzer uses the table values from machiningRates.ts.
                  vbitMRRInches3PerMin: undefined,
                  vbitFeedInchesPerMin: undefined,
                });
              }}
            />
          </section>
        )}

        {!result && (
          <p className="text-sm text-slate-400">
            Run the analysis on Step 2 to populate the bit-comparison matrix.
          </p>
        )}
      </div>

      <StepNav currentStep={4} canAdvance={false} onBack={onBack} />
    </div>
  );
}
