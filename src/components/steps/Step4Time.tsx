'use client';

import type { AnalysisResult, DFMSettings } from '@/types';
import { type ClearanceBitDiameter } from '@/lib/machiningRates';
import { formatMinutes, totalCellTime } from '@/lib/machiningTime';
import BitMatrixTable from '../BitMatrixTable';
import RecommendedSetupCard from '../RecommendedSetupCard';
import { StepNav } from '../StepperBar';

interface Step4TimeProps {
  result: AnalysisResult | null;
  settings: DFMSettings;
  onSettingsChange: (s: DFMSettings) => void;
  onBack: () => void;
}

const ATC_TOOL_CHANGE_MIN = 0.5;     // ~30 seconds for an Automatic Tool Changer
const MANUAL_TOOL_CHANGE_MIN = 5;    // typical hand-swap estimate

/**
 * Step 4 — Machining time exploration.
 *
 * Tops with a prominent RecommendedSetupCard naming the fastest feasible
 * (clearance strategy × v-bit) combination including tool-change overhead.
 * Below: a tool-change time control (ATC vs Manual presets), then the full
 * BitMatrixTable showing all 8 strategies × 6 v-bit angles.
 */
export default function Step4Time({
  result, settings, onSettingsChange, onBack,
}: Step4TimeProps) {
  const applyCombination = (strategyDiameters: number[], vbitAngle: number) => {
    onSettingsChange({
      ...settings,
      clearanceStrategy: strategyDiameters,
      // Per-wood machining-time displays on Step 2 / 3 use this single bit;
      // keep it in sync with the largest in the chosen strategy. When the
      // strategy is empty (v-bit only), fall back to a sensible default
      // (1/4") so per-wood displays don't break.
      clearanceBitDiameterInches: (strategyDiameters[0] ?? 0.25) as ClearanceBitDiameter,
      vbitAngleDegrees: vbitAngle,
      // Switching to a preset v-bit clears any custom rates.
      vbitMRRInches3PerMin: undefined,
      vbitFeedInchesPerMin: undefined,
    });
  };

  const setToolChangeMin = (v: number) => {
    onSettingsChange({ ...settings, toolChangeMinutes: Math.max(0, v) });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
        {/* Recommended setup — fastest feasible combo, with one-click apply */}
        {result && (
          <RecommendedSetupCard
            result={result}
            currentStrategyDiameters={settings.clearanceStrategy}
            currentVbitAngle={settings.vbitAngleDegrees}
            toolChangeMinutes={settings.toolChangeMinutes}
            onApply={applyCombination}
          />
        )}

        {/* Total time header — looked up from the matrix at the current
            (strategy, v-bit) selection so it stays in sync when Step 3
            changes the angle without re-running analysis. */}
        {result && (() => {
          const matrix = result.machiningTimeTable;
          const si = matrix.strategies.findIndex(s =>
            s.diameters.length === settings.clearanceStrategy.length
            && s.diameters.every((d, i) => d === settings.clearanceStrategy[i])
          );
          const vi = matrix.vbits.findIndex(v => v.angleDegrees === settings.vbitAngleDegrees);
          const t = (si >= 0 && vi >= 0)
            ? totalCellTime(matrix, si, vi, settings.toolChangeMinutes)
            : NaN;
          const stratLabel = si >= 0 ? matrix.strategies[si].label : 'Custom strategy';
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
                {settings.vbitAngleDegrees}° v-bit · {stratLabel}
              </span>
            </div>
          );
        })()}

        {/* Tool-change time — drives the per-bit overhead added to every cell */}
        <section>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Tool Change Time
          </h2>
          <p className="text-sm text-slate-400 mb-3">
            How long it takes your CNC to load or swap a bit. Each strategy
            below pays this cost once per bit it uses (counting the initial
            load). ATC machines swap automatically in seconds; manual swaps
            usually take a few minutes.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={0.5}
                value={settings.toolChangeMinutes}
                onChange={e => setToolChangeMin(parseFloat(e.target.value) || 0)}
                className="w-24 bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5 text-sm text-white
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <span className="text-xs text-slate-400">min</span>
            </div>
            <button
              onClick={() => setToolChangeMin(ATC_TOOL_CHANGE_MIN)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors
                ${settings.toolChangeMinutes === ATC_TOOL_CHANGE_MIN
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
            >
              ATC (30 s)
            </button>
            <button
              onClick={() => setToolChangeMin(MANUAL_TOOL_CHANGE_MIN)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors
                ${settings.toolChangeMinutes === MANUAL_TOOL_CHANGE_MIN
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
            >
              Manual (5 min)
            </button>
          </div>
        </section>

        {/* Strategy × v-bit matrix */}
        {result && (
          <section>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Clearance Strategy × V-bit
            </h2>
            <BitMatrixTable
              matrix={result.machiningTimeTable}
              currentStrategyDiameters={settings.clearanceStrategy}
              currentVbitAngle={settings.vbitAngleDegrees}
              toolChangeMinutes={settings.toolChangeMinutes}
              onSelectCombination={applyCombination}
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
