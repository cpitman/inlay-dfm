'use client';

/**
 * Shared form primitives. Both DesignSettingsPanel and AdvancedSettingsPanel
 * (and any future settings UI) render labeled fields with optional hint
 * text and number inputs. Without this module the same components were
 * duplicated across files; pull them here so styling stays consistent.
 */

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
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

interface NumberInputProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  ariaLabel?: string;
}

export function NumberInput({
  value, onChange, min, max, step, unit, ariaLabel,
}: NumberInputProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 'any'}
        aria-label={ariaLabel}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5 text-sm text-white
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      {unit && <span className="text-xs text-slate-400 whitespace-nowrap">{unit}</span>}
    </div>
  );
}
