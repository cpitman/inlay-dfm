'use client';

import type { DFMSettings } from '@/types';
import { Field, NumberInput } from './form/FormPrimitives';

interface AdvancedSettingsPanelProps {
  settings: DFMSettings;
  onChange: (s: DFMSettings) => void;
}

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
    </div>
  );
}
