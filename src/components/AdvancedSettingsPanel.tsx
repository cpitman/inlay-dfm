'use client';

import type { DFMSettings, AnalysisResolution } from '@/types';

interface AdvancedSettingsPanelProps {
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
  value, onChange, min, max, step, unit,
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

const RESOLUTION_OPTIONS: { key: AnalysisResolution; label: string; px: number }[] = [
  { key: 'low',     label: 'Low',     px: 600  },
  { key: 'default', label: 'Default', px: 1200 },
  { key: 'high',    label: 'High',    px: 2400 },
];

/**
 * Defaults that affect analysis math but rarely need tuning per design.
 * Rendered inside a collapsible <details> on Step 1.
 */
export default function AdvancedSettingsPanel({ settings, onChange }: AdvancedSettingsPanelProps) {
  const set = <K extends keyof DFMSettings>(k: K, v: DFMSettings[K]) =>
    onChange({ ...settings, [k]: v });

  return (
    <div className="space-y-4">
      <Field
        label="Plug Stock Margin"
        hint="Extra material added around each plug's convex hull when modeling the plug stock."
      >
        <NumberInput
          value={settings.plugStockMarginInches}
          onChange={(v) => set('plugStockMarginInches', v)}
          min={0}
          step={0.0625}
          unit="inches"
        />
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
