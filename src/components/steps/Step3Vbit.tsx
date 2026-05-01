'use client';

import type { DFMSettings, AnalysisResult } from '@/types';
import { VBIT_RATES } from '@/lib/machiningRates';
import { StepNav } from '../StepperBar';

interface Step3VbitProps {
  settings: DFMSettings;
  onSettingsChange: (s: DFMSettings) => void;
  result: AnalysisResult | null;
  canAdvance: boolean;
  onBack: () => void;
  onNext: () => void;
}

const VBIT_ANGLES = [15, 30, 45, 60, 90, 120];

/**
 * Step 3 — V-bit selection.
 *
 * For PR 1: the existing v-bit angle picker, lifted out of SettingsPanel.
 * PR 3 will add:
 *   - Per-preset feasibility annotations ("3.2% unreachable") read from
 *     `result.machiningTimeMatrix`.
 *   - "Recommended (widest feasible)" badge on the largest feasible angle.
 *   - Live preview overlay showing what an infeasible angle can't reach.
 *   - Custom angle input that triggers an on-demand single-angle pass.
 */
export default function Step3Vbit({
  settings, onSettingsChange, result,
  canAdvance, onBack, onNext,
}: Step3VbitProps) {
  const set = <K extends keyof DFMSettings>(k: K, v: DFMSettings[K]) =>
    onSettingsChange({ ...settings, [k]: v });

  const presetVbitRates = VBIT_RATES[settings.vbitAngleDegrees];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
        <section>
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            V-Bit Angle
          </h2>
          <p className="text-sm text-slate-400 mb-3">
            Pick the v-bit you'll use for the carving pass. A wider angle clears
            material faster but can't reach narrow corners; a sharper angle reaches
            into details but takes longer.
          </p>

          <div className="flex flex-wrap gap-2">
            {VBIT_ANGLES.map(deg => (
              <button
                key={deg}
                onClick={() => set('vbitAngleDegrees', deg)}
                className={`flex-1 min-w-16 py-2 rounded-md text-sm font-semibold border transition-colors
                  ${settings.vbitAngleDegrees === deg
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
              >
                {deg}°
              </button>
            ))}
          </div>

          {presetVbitRates && (
            <p className="text-xs text-slate-500 mt-3">
              <span className="text-slate-400">Rates:</span>{' '}
              MRR {presetVbitRates.mrr.toFixed(3)} in³/min · Feed {presetVbitRates.feed} in/min
            </p>
          )}
        </section>

        {result && (
          <section className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 text-sm text-slate-400 space-y-2">
            <p className="font-semibold text-slate-300">Feasibility hint</p>
            <p>
              Use the bit-comparison matrix on Step 4 to see which v-bit angles
              cover the design fully and which leave isolated unreachable regions.
              Anything in green there is feasible.
            </p>
            <p className="text-xs text-slate-500">
              A future update will surface per-preset feasibility next to each
              button on this step, and let you preview unreachable areas
              directly on the design.
            </p>
          </section>
        )}
      </div>

      <StepNav currentStep={3} canAdvance={canAdvance} onBack={onBack} onNext={onNext} />
    </div>
  );
}
