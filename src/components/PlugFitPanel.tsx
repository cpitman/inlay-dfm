'use client';

import type { DFMSettings } from '@/types';
import { Field, NumberInput } from './form/FormPrimitives';

interface PlugFitPanelProps {
  settings: DFMSettings;
  onChange: (s: DFMSettings) => void;
}

/**
 * Step 1 (Design) plug-fit settings: vertical clearances applied to the
 * plug-side carve so the inlay seats cleanly with room for glue.
 *
 *   - **Glue gap** shortens the entire plug uniformly. The plug sits
 *     `glueGap` above the pocket floor when seated, leaving room for
 *     glue. Implemented as `depth - glueGap` clamped at 0 across the
 *     plug carve.
 *   - **Surface gap** is an additional drop applied only to the flat-
 *     bottom region of the plug carve (where the v-bit reaches full
 *     depth). Creates a step-down at the foot of the tapered wall so
 *     the plug's "shoulder" doesn't bottom out before the plug seats.
 *     The horizontal width of the band is determined by the v-bit's
 *     taper (≈ surfaceGap × tan(halfAngle)).
 *
 * Net effective carve depth used for plug-side machining-time estimates
 * is `inlayDepth − glueGap + surfaceGap`. With the defaults below
 * (glue 0.005", surface 0.010") the net effect is +0.005" of depth on
 * the plug side, a small change vs the base inlay depth.
 */
export default function PlugFitPanel({ settings, onChange }: PlugFitPanelProps) {
  const set = <K extends keyof DFMSettings>(k: K, v: DFMSettings[K]) =>
    onChange({ ...settings, [k]: v });

  return (
    <div className="space-y-4">
      <Field
        label="Glue Gap"
        hint="Clearance under the plug for glue. The plug-side carve is shortened uniformly by this amount."
      >
        <NumberInput
          value={settings.plugGlueGapInches}
          onChange={v => set('plugGlueGapInches', Math.max(0, v))}
          min={0}
          step={0.001}
          unit="inches"
          ariaLabel="Plug glue gap, in inches"
        />
      </Field>

      <Field
        label="Surface Gap"
        hint="Step-down at the foot of the v-bit slope so the plug shoulder clears as it seats. Net plug depth = inlay depth − glue gap + surface gap."
      >
        <NumberInput
          value={settings.plugSurfaceGapInches}
          onChange={v => set('plugSurfaceGapInches', Math.max(0, v))}
          min={0}
          step={0.001}
          unit="inches"
          ariaLabel="Plug surface gap, in inches"
        />
      </Field>
    </div>
  );
}
