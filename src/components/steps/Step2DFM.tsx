'use client';

import type {
  AnalysisResult, DFMSettings, VectorData, WoodConfig, Layer,
} from '@/types';
import WoodPanel from '../WoodPanel';
import AutoImprovementsPanel from '../AutoImprovementsPanel';
import StaticTipsPanel from '../StaticTipsPanel';
import FeasibilityCallout from '../FeasibilityCallout';
import { StepNav } from '../StepperBar';

type OverlayMode = 'none' | 'threshold' | 'suggestions' | 'depthmap';

interface Step2DFMProps {
  vector: VectorData | null;
  originalLayers: Layer[];
  settings: DFMSettings;
  woodConfigs: WoodConfig[];
  result: AnalysisResult | null;
  analysisStale: boolean;
  status: 'idle' | 'parsing' | 'analyzing' | 'done' | 'error';
  errorMsg: string;
  overlayMode: OverlayMode;
  onOverlayModeChange: (m: OverlayMode) => void;
  busyModification: boolean;

  onAnalyze: () => void;
  onExtendForRegistration: (colorHex: string) => void;
  onFillEnclosedHoles: (colorHex: string) => void;
  onExtendAll: (colorHexes: string[]) => void;
  onFillAll: (colorHexes: string[]) => void;
  onResetLayer: (colorHex: string) => void;
  onUpdateWoodConfig: (colorHex: string, patch: Partial<WoodConfig>) => void;
  onMoveWood: (i: number, dir: -1 | 1) => void;

  canAdvance: boolean;
  onBack: () => void;
  onNext: () => void;
}

function GeomStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="text-slate-400">{label}</span>
      <span className="ml-2 font-semibold text-white">{value.toFixed(3)}"</span>
      <span className="ml-1 text-slate-500">· {(value * 25.4).toFixed(2)} mm</span>
    </div>
  );
}

function Divider() {
  return <span className="hidden sm:block w-px h-3 bg-slate-600 self-center" />;
}

/**
 * Step 2 — DFM (Design for Manufacturability).
 *
 * For PR 1 this is a re-housing of the existing analysis UI — geometry
 * stats, overlay toggle, per-wood panels with their built-in extend /
 * fill / alignment / fillable-hole cards. PR 2 polishes this with an
 * AutoImprovementsPanel + StaticTipsPanel + a new "regions only reachable
 * by an infeasible smaller v-bit" canvas overlay color.
 */
export default function Step2DFM({
  vector, originalLayers, settings, woodConfigs, result,
  analysisStale, status, errorMsg, overlayMode, onOverlayModeChange,
  busyModification,
  onAnalyze, onExtendForRegistration, onFillEnclosedHoles, onResetLayer,
  onExtendAll, onFillAll,
  onUpdateWoodConfig, onMoveWood,
  canAdvance, onBack, onNext,
}: Step2DFMProps) {
  const showRunBanner = !result || analysisStale;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5">
        {/* Run / re-run banner when result is stale or missing */}
        {vector && showRunBanner && (
          <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border
            ${analysisStale
              ? 'bg-amber-900/20 border-amber-700/60'
              : 'bg-slate-800 border-slate-700'}`}
          >
            <div className="text-sm">
              <p className={`font-semibold ${analysisStale ? 'text-amber-300' : 'text-slate-200'}`}>
                {analysisStale ? 'Results are stale' : 'No analysis yet'}
              </p>
              <p className="text-xs text-slate-400">
                {analysisStale
                  ? 'Settings or layers changed — re-run to refresh DFM checks.'
                  : 'Click Run to evaluate this design for manufacturing.'}
              </p>
            </div>
            <button
              onClick={onAnalyze}
              disabled={status === 'analyzing'}
              className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors
                ${analysisStale ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'}
                disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {status === 'analyzing' ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Analyzing…
                </span>
              ) : analysisStale ? 'Re-run analysis' : 'Run analysis'}
            </button>
          </div>
        )}

        {status === 'error' && errorMsg && (
          <p className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded p-2">{errorMsg}</p>
        )}

        {/* Headline: feasibility ceiling for the whole design */}
        {result && <FeasibilityCallout result={result} />}

        {/* Geometry stats — angle-independent (depend on grain + thresholds) */}
        {result && (
          <div className="bg-slate-800 rounded-lg px-4 py-3 text-xs">
            <div className="flex flex-wrap gap-x-6 gap-y-2 items-center">
              {settings.grainDirection !== 'end' && (
                <GeomStat label="Thin-wall threshold" value={result.thinWallThresholdInches} />
              )}
              {settings.grainDirection !== 'end' && <Divider />}
              <span className="text-slate-500">
                Detailed machining time and bit comparisons are on Step 4.
              </span>
            </div>
          </div>
        )}

        {/* Overlay legend + toggle */}
        {result && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
              {overlayMode === 'suggestions' ? (
                <>
                  {result.step2DisplayAngleDegrees === null && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded bg-red-500 inline-block" />
                      Unreachable by any v-bit
                    </span>
                  )}
                  {settings.grainDirection !== 'end' && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(220,150,30)' }} />
                      Thin wall opposing grain
                    </span>
                  )}
                  {vector && vector.detectedColors.length > 1 && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(210,50,210)' }} />
                      Alignment risk
                    </span>
                  )}
                  {result.step2SuggestionAngleDegrees !== null && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(40,200,210)' }} />
                      Widen for {result.step2SuggestionAngleDegrees}° v-bit (faster)
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
                    Full depth
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(220,40,30)' }} />
                    No depth (at edge)
                  </span>
                </>
              ) : null}
            </div>

            <div className="flex items-center gap-1">
              {(['none', 'suggestions', 'depthmap'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => onOverlayModeChange(mode)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors
                    ${overlayMode === mode ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                >
                  {mode === 'none' ? 'Off' : mode === 'suggestions' ? 'Suggestions' : 'Depth Map'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Auto-improvements summary — apply to all eligible layers in one click */}
        {result && (
          <AutoImprovementsPanel
            result={result}
            woodConfigs={woodConfigs}
            busy={busyModification}
            onExtendAll={onExtendAll}
            onFillAll={onFillAll}
          />
        )}

        {/* Per-wood panels */}
        {vector && result && (
          <div className="space-y-6">
            {woodConfigs.map((wc, i) => {
              const woodResult = result.woods.find(w => w.colorHex === wc.colorHex) ?? null;
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
                  analysis={woodResult}
                  vector={vector}
                  overlayMode={overlayMode}
                  common={result}
                  settings={settings}
                  otherWoodLabels={otherWoodLabels}
                  isModified={isModified}
                  busyModification={busyModification}
                  step2Mode={true}
                  onExtendForRegistration={() => onExtendForRegistration(wc.colorHex)}
                  onFillEnclosedHoles={() => onFillEnclosedHoles(wc.colorHex)}
                  onResetLayer={() => onResetLayer(wc.colorHex)}
                />
              );
            })}
          </div>
        )}

        {/* Static general-purpose DFM tips */}
        {result && <StaticTipsPanel />}
      </div>

      <StepNav currentStep={2} canAdvance={canAdvance} onBack={onBack} onNext={onNext} />
    </div>
  );
}
