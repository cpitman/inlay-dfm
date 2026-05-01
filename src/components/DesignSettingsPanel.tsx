'use client';

import type { DFMSettings } from '@/types';
import { Field, NumberInput } from './form/FormPrimitives';

interface DesignSettingsPanelProps {
  settings: DFMSettings;
  onChange: (s: DFMSettings) => void;
}

/**
 * Step 1 (Design) settings: board size, design width, inlay depth, grain
 * direction. The v-bit angle is a Step 3 decision and lives in VbitSelector.
 * Clearance bit, plug margin, and analysis resolution live in
 * AdvancedSettingsPanel.
 */
export default function DesignSettingsPanel({ settings, onChange }: DesignSettingsPanelProps) {
  const set = <K extends keyof DFMSettings>(k: K, v: DFMSettings[K]) =>
    onChange({ ...settings, [k]: v });

  return (
    <div className="space-y-4">
      <Field
        label="Board Dimensions"
        hint="The actual board the design will sit on."
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 w-12">Width</span>
          <NumberInput
            value={settings.boardWidthInches}
            onChange={(v) => set('boardWidthInches', v)}
            min={0.5}
            step={0.5}
            unit="in"
          />
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-xs text-slate-500 w-12">Height</span>
          <NumberInput
            value={settings.boardHeightInches}
            onChange={(v) => set('boardHeightInches', v)}
            min={0.5}
            step={0.5}
            unit="in"
          />
        </div>
      </Field>

      <Field
        label="Design Width"
        hint="Real-world width of the design itself. Updates live when you scale the design on the preview."
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
    </div>
  );
}
