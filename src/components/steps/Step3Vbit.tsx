'use client';

import { useEffect } from 'react';
import type {
  AnalysisResult, DFMSettings, VectorData, WoodConfig, Layer, WoodAnalysis,
} from '@/types';
import { isSideGrain } from '@/lib/grain';
import WoodPanel from '../WoodPanel';
import VbitSelector from '../VbitSelector';
import { StepNav } from '../StepperBar';

type OverlayMode = 'none' | 'threshold' | 'suggestions' | 'depthmap';

interface Step3VbitProps {
  vector: VectorData | null;
  originalLayers: Layer[];
  settings: DFMSettings;
  onSettingsChange: (s: DFMSettings) => void;
  woodConfigs: WoodConfig[];
  result: AnalysisResult | null;
  overlayMode: OverlayMode;
  onOverlayModeChange: (m: OverlayMode) => void;
  busyModification: boolean;
  vbitTouched: boolean;
  onVbitTouched: () => void;

  onExtendForRegistration: (colorHex: string) => void;
  onFillEnclosedHoles: (colorHex: string) => void;
  onResetLayer: (colorHex: string) => void;
  onUpdateWoodConfig: (colorHex: string, patch: Partial<WoodConfig>) => void;
  onMoveWood: (i: number, dir: -1 | 1) => void;

  canAdvance: boolean;
  onBack: () => void;
  onNext: () => void;
}

/**
 * Step 3 — V-bit selection.
 *
 * Preset picker with feasibility annotations + a "Recommended (widest
 * feasible)" badge. Switching presets is instant: every preset's overlay
 * is precomputed in `WoodAnalysis.perPresetAnalysis`, so this step just
 * reads from the cached result and swaps URLs.
 *
 * On first visit (vbitTouched === false), the selected angle is auto-set
 * to the widest feasible preset. Subsequent visits respect the user's
 * choice — they have to click a preset to override.
 */
export default function Step3Vbit({
  vector, originalLayers, settings, onSettingsChange,
  woodConfigs, result, overlayMode, onOverlayModeChange,
  busyModification, vbitTouched, onVbitTouched,
  onExtendForRegistration, onFillEnclosedHoles, onResetLayer,
  onUpdateWoodConfig, onMoveWood,
  canAdvance, onBack, onNext,
}: Step3VbitProps) {
  // Find the widest feasible preset — this becomes the default recommendation.
  const recommendedAngle: number | null = result
    ? (() => {
        const vbits = result.machiningTimeTable.vbits;
        for (let i = vbits.length - 1; i >= 0; i--) {
          if (vbits[i].feasible) return vbits[i].angleDegrees;
        }
        return null;
      })()
    : null;

  // Auto-select the recommended preset on first visit. Doesn't invalidate
  // the cached analysis (vbitAngleDegrees is excluded from analysisInputsKey).
  useEffect(() => {
    if (!vbitTouched && recommendedAngle !== null && settings.vbitAngleDegrees !== recommendedAngle) {
      onSettingsChange({ ...settings, vbitAngleDegrees: recommendedAngle });
    }
  }, [vbitTouched, recommendedAngle, settings, onSettingsChange]);

  const handlePresetSelect = (angle: number) => {
    onVbitTouched();
    onSettingsChange({
      ...settings,
      vbitAngleDegrees: angle,
      // Switching to a preset clears any custom rates so the analyzer uses
      // the canonical table values from machiningRates.ts.
      vbitMRRInches3PerMin: undefined,
      vbitFeedInchesPerMin: undefined,
    });
  };

  // Build a synthetic per-wood analysis where the pocket/plug fields reflect
  // the currently selected angle. Step 3's WoodPanel uses 'threshold'
  // overlay mode, so the swapped overlayDataUrl drives the canvas.
  const woodForDisplay = (wood: WoodAnalysis): WoodAnalysis => {
    const preset = wood.perPresetAnalysis.find(p => p.angleDegrees === settings.vbitAngleDegrees);
    if (!preset) return wood;
    return {
      ...wood,
      pocket: { ...wood.pocket, ...preset.pocket },
      plug:   { ...wood.plug,   ...preset.plug   },
    };
  };

  const selectedVbitInfo = result?.machiningTimeTable.vbits.find(
    v => v.angleDegrees === settings.vbitAngleDegrees,
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
        {!result && (
          <p className="text-sm text-slate-400 bg-slate-800/40 border border-slate-700 rounded-lg p-4">
            Run the analysis on Step 2 first — feasibility annotations and live preview are
            populated from the analysis result.
          </p>
        )}

        {result && (
          <>
            <section>
              <div className="flex items-center justify-between gap-3 mb-2">
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  V-Bit Angle
                </h2>
                {recommendedAngle === null && (
                  <span className="text-xs text-red-300">No preset is feasible.</span>
                )}
              </div>
              <p className="text-sm text-slate-400 mb-4">
                Pick the v-bit angle for the carving pass. Wider angles carve faster but
                can't reach narrow corners; sharper angles reach details but take longer.
                The recommended preset is the widest one feasible for this design.
              </p>
              <VbitSelector
                vbits={result.machiningTimeTable.vbits}
                selectedAngle={settings.vbitAngleDegrees}
                recommendedAngle={recommendedAngle}
                onSelect={handlePresetSelect}
              />
              {selectedVbitInfo && (
                <p className="text-xs text-slate-500 mt-3">
                  <span className="text-slate-300">{selectedVbitInfo.angleDegrees}° v-bit</span>
                  {selectedVbitInfo.mrr > 0 && (
                    <> · MRR {selectedVbitInfo.mrr.toFixed(3)} in³/min · Feed {selectedVbitInfo.feed.toFixed(0)} in/min</>
                  )}
                  {!selectedVbitInfo.feasible && (
                    <span className="ml-2 text-red-300">
                      Infeasible — {selectedVbitInfo.hasIsolatedComponent
                        ? "an isolated piece of the design can't be reached"
                        : `${selectedVbitInfo.maxProblemAreaPercent.toFixed(1)}% of the design unreachable`}.
                    </span>
                  )}
                </p>
              )}
            </section>

            {/* Overlay legend + toggle */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                {overlayMode === 'threshold' ? (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded bg-slate-300 inline-block" />
                      OK at {settings.vbitAngleDegrees}°
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded bg-red-500 inline-block" />
                      Unreachable at {settings.vbitAngleDegrees}°
                    </span>
                    {isSideGrain(settings.grainDirection) && (
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(220,150,30)' }} />
                        Thin wall opposing grain
                      </span>
                    )}
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 inline-block border-t-2 border-dashed" style={{ borderColor: 'rgb(255,140,0)' }} />
                      Plug stock outline (modeled, plug side only)
                    </span>
                  </>
                ) : overlayMode === 'depthmap' ? (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(40,200,70)' }} />
                      Full depth at {settings.vbitAngleDegrees}°
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(220,40,30)' }} />
                      No depth (at edge)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 inline-block border-t-2 border-dashed" style={{ borderColor: 'rgb(255,140,0)' }} />
                      Plug stock outline (modeled, plug side only)
                    </span>
                  </>
                ) : null}
              </div>

              <div className="flex items-center gap-1">
                {(['none', 'threshold', 'depthmap'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => onOverlayModeChange(mode)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors
                      ${overlayMode === mode ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                  >
                    {mode === 'none' ? 'Off' : mode === 'threshold' ? 'Threshold' : 'Depth Map'}
                  </button>
                ))}
              </div>
            </div>

            {/* Per-wood preview at the selected angle */}
            {vector && (
              <div className="space-y-6">
                {woodConfigs.map((wc, i) => {
                  const woodResult = result.woods.find(w => w.colorHex === wc.colorHex) ?? null;
                  const displayWood = woodResult ? woodForDisplay(woodResult) : null;
                  const otherWoodLabels = Object.fromEntries(
                    woodConfigs.filter(w => w.colorHex !== wc.colorHex).map(w => [w.colorHex, w.label])
                  );
                  const origLayer = originalLayers.find(l => l.colorHex === wc.colorHex);
                  const curLayer = vector.layers.find(l => l.colorHex === wc.colorHex);
                  const isModified = !!(origLayer && curLayer && origLayer.svgFragment !== curLayer.svgFragment);
                  return (
                    <WoodPanel
                      key={wc.colorHex}
                      colorHex={wc.colorHex}
                      label={wc.label}
                      onLabelChange={label => onUpdateWoodConfig(wc.colorHex, { label })}
                      species={wc.species}
                      onSpeciesChange={species => onUpdateWoodConfig(wc.colorHex, { species })}
                      canMoveUp={i > 0}
                      canMoveDown={i < woodConfigs.length - 1}
                      onMoveUp={() => onMoveWood(i, -1)}
                      onMoveDown={() => onMoveWood(i, 1)}
                      analysis={displayWood}
                      vector={vector}
                      overlayMode={overlayMode}
                      common={result}
                      settings={settings}
                      otherWoodLabels={otherWoodLabels}
                      isModified={isModified}
                      busyModification={busyModification}
                      onExtendForRegistration={() => onExtendForRegistration(wc.colorHex)}
                      onFillEnclosedHoles={() => onFillEnclosedHoles(wc.colorHex)}
                      onResetLayer={() => onResetLayer(wc.colorHex)}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <StepNav currentStep={3} canAdvance={canAdvance} onBack={onBack} onNext={onNext} />
    </div>
  );
}
