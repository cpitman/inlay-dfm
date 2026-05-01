'use client';

import type { DFMSettings, AnalysisResolution } from '@/types';
import {
  CLEARANCE_BIT_OPTIONS, CLEARANCE_BIT_MRR,
  VBIT_RATES,
  type ClearanceBitDiameter,
} from '@/lib/machiningRates';

interface SettingsPanelProps {
  settings: DFMSettings;
  onChange: (s: DFMSettings) => void;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 'any'}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5 text-sm text-white
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      {unit && <span className="text-xs text-slate-400 whitespace-nowrap">{unit}</span>}
    </div>
  );
}

const VBIT_ANGLES = [15, 30, 45, 60, 90, 120];

const RESOLUTION_OPTIONS: { key: AnalysisResolution; label: string; px: number }[] = [
  { key: 'low',     label: 'Low',     px: 600  },
  { key: 'default', label: 'Default', px: 1200 },
  { key: 'high',    label: 'High',    px: 2400 },
];

const CLEARANCE_BIT_LABELS: Record<ClearanceBitDiameter, string> = {
  0.125: '1/8"',
  0.25:  '1/4"',
  0.5:   '1/2"',
};

export default function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const set = <K extends keyof DFMSettings>(k: K, v: DFMSettings[K]) =>
    onChange({ ...settings, [k]: v });

  const presetVbitRates = VBIT_RATES[settings.vbitAngleDegrees];

  return (
    <div className="space-y-4">
      <Field
        label="Design Width"
        hint="The real-world width of the uploaded design."
      >
        <NumberInput
          value={settings.designWidthInches}
          onChange={(v) => set('designWidthInches', v)}
          min={0.1}
          step={0.25}
          unit="inches"
        />
      </Field>

      <Field
        label="V-Bit Angle"
        hint="Included angle of the V-bit you plan to use."
      >
        <div className="flex flex-wrap gap-1.5">
          {VBIT_ANGLES.map((deg) => (
            <button
              key={deg}
              onClick={() => set('vbitAngleDegrees', deg)}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium border transition-colors min-w-12
                ${settings.vbitAngleDegrees === deg
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
            >
              {deg}°
            </button>
          ))}
        </div>
        {presetVbitRates && (
          <p className="text-xs text-slate-500 mt-2">
            <span className="text-slate-400">Rates:</span>{' '}
            MRR {presetVbitRates.mrr.toFixed(3)} in³/min · Feed {presetVbitRates.feed} in/min
          </p>
        )}
      </Field>

      <Field
        label="Inlay Depth"
        hint="How deep the V-bit cuts into the wood."
      >
        <NumberInput
          value={settings.inlayDepthInches}
          onChange={(v) => set('inlayDepthInches', v)}
          min={0.01}
          step={0.0625}
          unit="inches"
        />
        <div className="flex gap-1 mt-1 flex-wrap">
          {[0.0625, 0.125, 0.1875, 0.25].map((d) => (
            <button
              key={d}
              onClick={() => set('inlayDepthInches', d)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors
                ${settings.inlayDepthInches === d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-400'}`}
            >
              {d < 0.125 ? '1/16"' : d === 0.125 ? '1/8"' : d === 0.1875 ? '3/16"' : '1/4"'}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Grain Direction"
        hint="End grain is weakest and requires wider features."
      >
        <div className="flex gap-2">
          {(['horizontal', 'vertical', 'end'] as const).map((g) => (
            <button
              key={g}
              onClick={() => set('grainDirection', g)}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium border capitalize transition-colors
                ${settings.grainDirection === g
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
            >
              {g}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Clearance Bit"
        hint={`MRR ${CLEARANCE_BIT_MRR[settings.clearanceBitDiameterInches].toFixed(2)} in³/min — clears bulk material before the V-bit pass.`}
      >
        <div className="flex gap-2">
          {CLEARANCE_BIT_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => set('clearanceBitDiameterInches', d)}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium border transition-colors
                ${settings.clearanceBitDiameterInches === d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
            >
              {CLEARANCE_BIT_LABELS[d]}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Analysis Resolution"
        hint="Higher resolution detects finer features but uses ~4× memory and time per step."
      >
        <div className="flex gap-2">
          {RESOLUTION_OPTIONS.map((r) => (
            <button
              key={r.key}
              onClick={() => set('analysisResolution', r.key)}
              title={`${r.px}px wide`}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium border transition-colors
                ${settings.analysisResolution === r.key
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}
