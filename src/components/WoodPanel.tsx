'use client';

import { useMemo, useRef, useState } from 'react';
import type { WoodAnalysis, AnalysisResult, DFMSettings, VectorData, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES, WOOD_SPECIES_ORDER } from '@/lib/woodSpecies';
import { layerToStandaloneSvg } from '@/lib/svgLayers';
import { formatMinutes } from '@/lib/machiningTime';
import DesignCanvas from './DesignCanvas';
import HoverMagnifier from './HoverMagnifier';
import IssueLocatorBadges, { type IssueVariant } from './IssueLocatorBadges';
import ResultsPanel from './ResultsPanel';

interface WoodPanelProps {
  colorHex: string;
  label: string;
  onLabelChange: (label: string) => void;
  species: WoodSpeciesKey;
  onSpeciesChange: (species: WoodSpeciesKey) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  analysis: WoodAnalysis | null;
  vector: VectorData | null;
  overlayMode: 'none' | 'threshold' | 'suggestions' | 'depthmap';
  common: Pick<AnalysisResult, 'thinWallThresholdInches' | 'alignmentThresholdInches'> | null;
  settings: DFMSettings;
  /** colorHex → label map for all woods (used in alignment warning messages). */
  otherWoodLabels: Record<string, string>;
  /** True if this layer's geometry differs from the original parsed file. */
  isModified: boolean;
  busyModification: boolean;
  /** When true, hide the angle-dependent depth-check pass/fail block in the
   *  per-side ResultsPanel. Step 2 sets this because the user hasn't picked
   *  a v-bit yet — feasibility is summarized at the page level instead. */
  step2Mode?: boolean;
  onExtendForRegistration: () => void;
  onFillEnclosedHoles: () => void;
  onResetLayer: () => void;
}

export default function WoodPanel({
  colorHex, label, onLabelChange,
  species, onSpeciesChange,
  canMoveUp, canMoveDown, onMoveUp, onMoveDown,
  analysis, vector, overlayMode, common, settings,
  otherWoodLabels,
  isModified, busyModification, step2Mode,
  onExtendForRegistration, onFillEnclosedHoles, onResetLayer,
}: WoodPanelProps) {
  const overlay = (side: 'pocket' | 'plug') => {
    if (!analysis) return null;
    if (overlayMode === 'threshold')   return analysis[side].overlayDataUrl;
    if (overlayMode === 'suggestions') return analysis[side].suggestionOverlayDataUrl || analysis[side].overlayDataUrl;
    if (overlayMode === 'depthmap')    return analysis[side].depthMapDataUrl;
    return null;
  };

  // Badges point at small problem regions on the threshold overlay.
  // Other overlay modes don't carry per-component centroids today. The
  // variant tags each badge so the disc color matches the overlay
  // beneath (red for pocket "feature too narrow", yellow for plug
  // "gap between inlays too narrow").
  const badgeComponents = (side: 'pocket' | 'plug') => {
    if (!analysis || overlayMode !== 'threshold') return [];
    const variant: IssueVariant = side === 'pocket' ? 'pocketIrreducible' : 'plugIrreducible';
    return analysis[side].problemComponents.map(c => ({ ...c, variant }));
  };

  // Refs for the hover-magnifier loupe to sample full-resolution pixels.
  const pocketCanvasRef = useRef<HTMLCanvasElement>(null);
  const plugCanvasRef   = useRef<HTMLCanvasElement>(null);
  const [pocketPin, setPocketPin] = useState<{ x: number; y: number } | null>(null);
  const [plugPin,   setPlugPin]   = useState<{ x: number; y: number } | null>(null);

  const sourceW = vector?.naturalWidth  ?? 0;
  const sourceH = vector?.naturalHeight ?? 0;

  // Render only this wood's layer in the no-overlay base view.
  const layerSvg = useMemo(() => {
    if (!vector) return undefined;
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    if (!layer) return undefined;
    return layerToStandaloneSvg(layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight);
  }, [vector, colorHex]);

  // For the plug-side preview, append the modeled plug-stock outline so the
  // user can see the boundary of the stock the plug is being cut from.
  const plugLayerSvg = useMemo(() => {
    if (!vector) return undefined;
    const layer = vector.layers.find(l => l.colorHex === colorHex);
    if (!layer) return undefined;
    const outline = analysis?.plugStockOutlineSvg ?? '';
    if (!outline) return layerSvg;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.viewBox}" width="${vector.naturalWidth}" height="${vector.naturalHeight}">
${layer.svgFragment}
${outline}
</svg>`;
  }, [vector, colorHex, analysis?.plugStockOutlineSvg, layerSvg]);

  return (
    <div className="border border-slate-700 rounded-lg overflow-hidden">
      {/* Wood header */}
      <div className="bg-slate-800 px-4 py-2.5 flex items-center gap-3 border-b border-slate-700">
        {/* Order buttons */}
        <div className="flex flex-col gap-0.5 shrink-0">
          <button
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`Move ${label} up`}
            className="w-5 h-4 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
            title="Move up"
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M6 2l5 7H1z" />
            </svg>
          </button>
          <button
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`Move ${label} down`}
            className="w-5 h-4 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
            title="Move down"
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M6 10L1 3h10z" />
            </svg>
          </button>
        </div>

        {/* Color swatch */}
        <span
          className="w-4 h-4 rounded shrink-0 border border-slate-600"
          style={{ background: colorHex }}
        />

        {/* Label */}
        <input
          type="text"
          value={label}
          onChange={e => onLabelChange(e.target.value)}
          className="bg-transparent text-slate-200 font-semibold text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 min-w-0 w-32"
        />

        {/* Species selector */}
        <select
          value={species}
          onChange={e => onSpeciesChange(e.target.value as WoodSpeciesKey)}
          className="bg-slate-700 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {WOOD_SPECIES_ORDER.map(key => (
            <option key={key} value={key}>{WOOD_SPECIES[key].name}</option>
          ))}
        </select>

        {/* Species color swatch */}
        <span
          className="w-4 h-4 rounded shrink-0 border border-slate-600"
          style={{ background: WOOD_SPECIES[species].baseHex }}
          title={WOOD_SPECIES[species].name}
        />

        <span className="text-slate-600 text-xs font-mono ml-auto">{colorHex}</span>
      </div>

      {/* Pocket + Plug columns */}
      <div className="grid grid-cols-2 gap-4 p-4">
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-300">Pocket</h3>
            <p className="text-xs text-slate-500">Carved from base board</p>
          </div>
          <HoverMagnifier sourceCanvasRef={pocketCanvasRef} pinPosition={pocketPin}>
            <DesignCanvas
              vector={vector}
              overlayDataUrl={overlay('pocket')}
              svgOverride={layerSvg}
              canvasRef={pocketCanvasRef}
            />
            {sourceW > 0 && (
              <IssueLocatorBadges
                components={badgeComponents('pocket')}
                sourceWidth={sourceW}
                sourceHeight={sourceH}
                onPin={setPocketPin}
              />
            )}
          </HoverMagnifier>
          {analysis && common && (
            <ResultsPanel analysis={analysis.pocket} common={common} settings={settings} label="Pocket" hideDepthCheck={step2Mode} />
          )}
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-300">Plug</h3>
            <p className="text-xs text-slate-500">Raised piece cut from {label || 'this'} stock</p>
          </div>
          <HoverMagnifier sourceCanvasRef={plugCanvasRef} pinPosition={plugPin}>
            <DesignCanvas
              vector={vector}
              overlayDataUrl={overlay('plug')}
              svgOverride={plugLayerSvg}
              canvasRef={plugCanvasRef}
            />
            {sourceW > 0 && (
              <IssueLocatorBadges
                components={badgeComponents('plug')}
                sourceWidth={sourceW}
                sourceHeight={sourceH}
                onPin={setPlugPin}
              />
            )}
          </HoverMagnifier>
          {analysis && common && (
            <ResultsPanel analysis={analysis.plug} common={common} settings={settings} label="Plug" hideDepthCheck={step2Mode} />
          )}
        </div>
      </div>

      {/* Per-layer machine time */}
      {analysis && (
        <div className="mx-4 mb-4 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>
            <span className="text-slate-400">Layer machine time</span>
            <span className="ml-2 font-semibold text-white">
              {isFinite(analysis.layerMachineTimeMinutes)
                ? formatMinutes(analysis.layerMachineTimeMinutes)
                : '—'}
            </span>
            <span className="ml-1 text-slate-500">(pocket + plug)</span>
          </span>
          {isFinite(analysis.layerMachineTimeMinutes) && (
            <>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">
                Pocket clearance {analysis.clearanceAreaSqIn.toFixed(2)} in² ·
                V-bit {analysis.vbitAreaSqIn.toFixed(2)} in²
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">
                Plug clearance {analysis.plugClearanceAreaSqIn.toFixed(2)} in² ·
                V-bit {analysis.plugVbitAreaSqIn.toFixed(2)} in²
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">
                Perimeter {analysis.perimeterIn.toFixed(2)}"
              </span>
            </>
          )}
        </div>
      )}

      {/* Alignment warnings */}
      {analysis && analysis.alignmentIssues.length > 0 && common && (
        <div className="mx-4 mb-4 border border-fuchsia-700 rounded-lg bg-fuchsia-900/20 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-fuchsia-300 flex items-center gap-1.5">
            <span>⚠</span>
            Staged alignment risk
          </p>
          {analysis.alignmentIssues.map(issue => (
            <p key={issue.otherColorHex} className="text-xs text-fuchsia-200">
              Edge is within{' '}
              <strong>{(common.alignmentThresholdInches * 1000).toFixed(0)} thou</strong>{' '}
              of{' '}
              <strong>{otherWoodLabels[issue.otherColorHex] ?? issue.otherColorHex}</strong>
              {issue.affectedPercent > 0 && (
                <span className="text-fuchsia-400"> ({issue.affectedPercent.toFixed(1)}% of perimeter)</span>
              )}
              . A registration error when staging these inlays will be visible.
            </p>
          ))}
          <p className="text-xs text-fuchsia-500">
            Affected edge shown in magenta on the Threshold overlay above.
          </p>
          <div className="pt-1.5">
            <button
              onClick={onExtendForRegistration}
              disabled={busyModification}
              className="px-3 py-1.5 rounded text-xs font-medium bg-fuchsia-700 hover:bg-fuchsia-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busyModification ? 'Working…' : 'Extend under later inlays (+0.05")'}
            </button>
            <span className="ml-2 text-xs text-fuchsia-500">
              Re-run analysis to verify the issue is resolved.
            </span>
          </div>
        </div>
      )}

      {/* Fillable enclosed holes — DFM optimization opportunity */}
      {analysis && analysis.fillableHoleCount > 0 && (
        <div className="mx-4 mb-4 border border-cyan-700 rounded-lg bg-cyan-900/20 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-cyan-300 flex items-center gap-1.5">
            <span>○</span>
            Fillable enclosed holes
          </p>
          <p className="text-xs text-cyan-200">
            <strong>{analysis.fillableHoleCount}</strong> hole{analysis.fillableHoleCount !== 1 ? 's' : ''}
            {' '}fully covered by later inlay layers ({analysis.fillableHoleAreaSqIn.toFixed(2)} in² total).
            {isFinite(analysis.fillableSavedTimeMin) && analysis.fillableSavedTimeMin > 0 && (
              <> Filling them could save approximately <strong>{analysis.fillableSavedTimeMin.toFixed(1)} min</strong> of V-bit perimeter time.</>
            )}
          </p>
          <p className="text-xs text-cyan-500">
            The covered holes are invisible in the final design; filling them removes the V-bit perimeter passes the bit would otherwise trace on both pocket and plug.
          </p>
          <div className="pt-1.5">
            <button
              onClick={onFillEnclosedHoles}
              disabled={busyModification}
              className="px-3 py-1.5 rounded text-xs font-medium bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busyModification ? 'Working…' : `Fill ${analysis.fillableHoleCount} hole${analysis.fillableHoleCount !== 1 ? 's' : ''}`}
            </button>
            <span className="ml-2 text-xs text-cyan-500">
              Re-run analysis to update the time estimate.
            </span>
          </div>
        </div>
      )}

      {/* Modified-layer indicator + per-layer reset */}
      {isModified && (
        <div className="mx-4 mb-4 border border-amber-700/60 rounded-lg bg-amber-900/10 px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-amber-300">This layer has been modified from the original.</span>
          <button
            onClick={onResetLayer}
            disabled={busyModification}
            className="px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-40 transition-colors"
          >
            Reset this layer
          </button>
        </div>
      )}
    </div>
  );
}
