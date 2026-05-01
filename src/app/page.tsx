'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { DFMSettings, VectorData, AnalysisResult, WoodConfig, WoodSpeciesKey, Layer, LayerSnapshot } from '@/types';
import { parseVectorFile } from '@/lib/vectorParser';
import { runDfmAnalysis } from '@/lib/dfmAnalysis';
import { generateComposite } from '@/lib/compositeRenderer';
import { WOOD_SPECIES, WOOD_SPECIES_ORDER, guessSpecies } from '@/lib/woodSpecies';
import { combineLayers } from '@/lib/svgLayers';
import { extendForRegistration } from '@/lib/extendForRegistration';
import { downloadSvg } from '@/lib/svgExport';
import { formatMinutes } from '@/lib/machiningTime';
import FileUpload from '@/components/FileUpload';
import SettingsPanel from '@/components/SettingsPanel';
import WoodSection from '@/components/WoodSection';
import CompositeView from '@/components/CompositeView';
import BitMatrixTable from '@/components/BitMatrixTable';

function GeomStat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div>
      <span className="text-slate-400">{label}</span>
      <span className="ml-2 font-semibold text-white">{value.toFixed(3)}"</span>
      <span className="ml-1 text-slate-500">· {(value * 25.4).toFixed(2)} mm</span>
      {sub && <span className="ml-2 text-slate-600">({sub})</span>}
    </div>
  );
}

function Divider() {
  return <span className="hidden sm:block w-px h-3 bg-slate-600 self-center" />;
}

function clearanceBitLabel(diameterInches: number): string {
  if (diameterInches === 0.125) return '1/8"';
  if (diameterInches === 0.25)  return '1/4"';
  if (diameterInches === 0.5)   return '1/2"';
  return `${diameterInches.toFixed(3)}"`;
}

const DEFAULT_SETTINGS: DFMSettings = {
  designWidthInches: 5,
  vbitAngleDegrees: 60,
  inlayDepthInches: 0.125,
  grainDirection: 'horizontal',
  analysisResolution: 'default',
  clearanceBitDiameterInches: 0.25,
};

/** Convert the user's resolution preset into the canvas pixel width used by the analyzer/extender. */
function resolvedCanvasWidth(res: DFMSettings['analysisResolution']): number {
  return res === 'low' ? 600 : res === 'high' ? 2400 : 1200;
}

type Status = 'idle' | 'parsing' | 'analyzing' | 'done' | 'error';
type OverlayMode = 'none' | 'threshold' | 'depthmap';
type MainView = 'analysis' | 'composite';

export default function Home() {
  // `originalVector` is the parsed file (immutable after parse).
  // `history` is a stack of layer snapshots; `historyIndex` points at the
  // currently-applied snapshot. The "live" vector is reconstructed by
  // combining `originalVector`'s metadata with `history[historyIndex].layers`.
  const [originalVector, setOriginalVector] = useState<VectorData | null>(null);
  const [history, setHistory] = useState<LayerSnapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [settings, setSettings] = useState<DFMSettings>(DEFAULT_SETTINGS);
  // Result is derived from the current snapshot's cache (if any). This means
  // undo/redo automatically restores the previously-shown analysis without a
  // re-run, and the cache is invalidated by clearing the snapshot's `result`.
  const [hasEverAnalyzed, setHasEverAnalyzed] = useState(false);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('threshold');
  const [mainView, setMainView] = useState<MainView>('analysis');
  const [woodConfigs, setWoodConfigs] = useState<WoodConfig[]>([]);
  const [backgroundSpecies, setBackgroundSpecies] = useState<WoodSpeciesKey>('maple');
  const [compositeDataUrl, setCompositeDataUrl] = useState<string | null>(null);
  const [compositeGenerating, setCompositeGenerating] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyModification, setBusyModification] = useState(false);
  const [showBitMatrix, setShowBitMatrix] = useState(false);
  const compositeAbort = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Current analysis result — derived from the snapshot's cache so that
  // undo/redo restores the previously-shown analysis automatically.
  const result: AnalysisResult | null = useMemo(
    () => history[historyIndex]?.result ?? null,
    [history, historyIndex],
  );

  // The Run button highlights when the user has analyzed at least once but
  // the displayed analysis is stale — either invalidated by a settings/order
  // change (cache cleared) or by switching to a snapshot that wasn't analyzed.
  const analysisStale = hasEverAnalyzed && result === null;

  // Live vector — original metadata plus the current snapshot's layers,
  // reordered to match woodConfigs so the combined svgString reflects the
  // user's chosen z-order. Without this reorder, the composite view, the
  // exported SVG, and any combined-image consumer would always render in
  // the original parse order regardless of how the user arranged the layers.
  const vector: VectorData | null = useMemo(() => {
    if (!originalVector) return null;
    const snap = history[historyIndex];
    const snapLayers = snap?.layers ?? originalVector.layers;

    let orderedLayers: Layer[];
    if (woodConfigs.length === 0) {
      orderedLayers = snapLayers;
    } else {
      const byHex = new Map(snapLayers.map(l => [l.colorHex, l]));
      orderedLayers = [];
      for (const wc of woodConfigs) {
        const l = byHex.get(wc.colorHex);
        if (l) { orderedLayers.push(l); byHex.delete(wc.colorHex); }
      }
      // Defensive: any snapshot layer not represented in woodConfigs gets
      // appended so we never silently drop geometry.
      for (const l of byHex.values()) orderedLayers.push(l);
    }

    return {
      ...originalVector,
      layers: orderedLayers,
      svgString: combineLayers(
        orderedLayers, originalVector.viewBox, originalVector.naturalWidth, originalVector.naturalHeight,
      ),
    };
  }, [originalVector, history, historyIndex, woodConfigs]);

  // Invalidate every snapshot's cached analysis result whenever a setting or
  // the layer order changes — those inputs are part of what the analysis
  // consumed, so any cached result no longer matches.
  const colorOrderKey = useMemo(() => woodConfigs.map(w => w.colorHex).join('|'), [woodConfigs]);
  useEffect(() => {
    setHistory(prev => {
      if (!prev.some(s => s.result)) return prev;
      return prev.map(s => (s.result ? { ...s, result: undefined } : s));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, colorOrderKey]);

  // Init woodConfigs from detected colors whenever a NEW file is parsed.
  // Bound to originalVector (not the live `vector` snapshot) so undo/redo do
  // not reset the user's species/label/order choices.
  useEffect(() => {
    if (!originalVector) { setWoodConfigs([]); setCompositeDataUrl(null); return; }
    setWoodConfigs(
      originalVector.detectedColors.map((hex, i) => ({
        colorHex: hex,
        label: WOOD_SPECIES[guessSpecies(hex)].name + (originalVector.detectedColors.length > 1 ? ` ${i + 1}` : ''),
        species: guessSpecies(hex),
      }))
    );
  }, [originalVector]);

  // Regenerate composite whenever configs or vector changes
  useEffect(() => {
    if (!vector || woodConfigs.length === 0) { setCompositeDataUrl(null); return; }

    const token = { cancelled: false };
    compositeAbort.current = token;
    setCompositeGenerating(true);

    generateComposite(vector, woodConfigs, backgroundSpecies)
      .then(url => { if (!token.cancelled) { setCompositeDataUrl(url); setCompositeGenerating(false); } })
      .catch(() => { if (!token.cancelled) setCompositeGenerating(false); });

    return () => { token.cancelled = true; };
  }, [vector, woodConfigs, backgroundSpecies]);

  const handleFile = useCallback(async (file: File) => {
    setStatus('parsing');
    setErrorMsg('');
    setCompositeDataUrl(null);
    setHasEverAnalyzed(false);
    try {
      const parsed = await parseVectorFile(file);
      setOriginalVector(parsed);
      setHistory([{ layers: parsed.layers, label: 'Original' }]);
      setHistoryIndex(0);
      setStatus('idle');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    }
  }, []);

  // Push a new snapshot onto history, truncating any redo stack ahead of the
  // current index (standard editor undo/redo semantics).
  const pushSnapshot = useCallback((layers: Layer[], label: string) => {
    setHistory(prev => {
      const truncated = prev.slice(0, historyIndex + 1);
      return [...truncated, { layers, label }];
    });
    setHistoryIndex(idx => idx + 1);
  }, [historyIndex]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const handleUndo = useCallback(() => {
    if (canUndo) setHistoryIndex(historyIndex - 1);
  }, [canUndo, historyIndex]);

  const handleRedo = useCallback(() => {
    if (canRedo) setHistoryIndex(historyIndex + 1);
  }, [canRedo, historyIndex]);

  const handleResetAll = useCallback(() => {
    if (!originalVector) return;
    pushSnapshot(originalVector.layers, 'Reset all to original');
  }, [originalVector, pushSnapshot]);

  const handleResetLayer = useCallback((colorHex: string) => {
    if (!originalVector || !vector) return;
    const orig = originalVector.layers.find(l => l.colorHex === colorHex);
    if (!orig) return;
    const newLayers = vector.layers.map(l => l.colorHex === colorHex ? orig : l);
    const label = woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;
    pushSnapshot(newLayers, `Reset ${label}`);
  }, [originalVector, vector, woodConfigs, pushSnapshot]);

  const handleExtendForRegistration = useCallback(async (colorHex: string) => {
    if (!vector) return;
    setBusyModification(true);
    setErrorMsg('');
    try {
      const colorOrder = woodConfigs.map(wc => wc.colorHex);
      const canvasWidth = resolvedCanvasWidth(settings.analysisResolution);
      const res = await extendForRegistration(vector, colorHex, settings.designWidthInches, colorOrder, canvasWidth);
      if (res.addedPixelCount === 0) {
        setErrorMsg('No alignment risk regions found to extend on this layer.');
        setStatus('error');
      } else {
        const label = woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;
        pushSnapshot(res.layers, `Extend ${label} for registration (+${res.addedAreaSqInches.toFixed(3)} in²)`);
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    } finally {
      setBusyModification(false);
    }
  }, [vector, woodConfigs, settings.designWidthInches, settings.analysisResolution, pushSnapshot]);

  const handleExportSvg = useCallback(() => {
    if (vector) downloadSvg(vector);
  }, [vector]);

  const handleAnalyze = useCallback(async () => {
    if (!vector) return;
    if (settings.designWidthInches <= 0 || settings.inlayDepthInches <= 0) {
      setErrorMsg('Design width and inlay depth must be greater than zero.');
      setStatus('error');
      return;
    }
    setStatus('analyzing');
    setErrorMsg('');
    const colorOrder = woodConfigs.map(wc => wc.colorHex);
    const canvasWidth = resolvedCanvasWidth(settings.analysisResolution);
    // Capture the snapshot we're analyzing so the result lands on the
    // right history entry even if the user undoes/redoes mid-analysis.
    const snapshotAtStart = history[historyIndex];
    try {
      const r = await runDfmAnalysis(vector, settings, colorOrder, canvasWidth);
      setHistory(prev => prev.map(s => (s === snapshotAtStart ? { ...s, result: r } : s)));
      setHasEverAnalyzed(true);
      setOverlayMode('threshold');
      setStatus('done');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    }
  }, [vector, settings, woodConfigs, history, historyIndex]);

  const moveWood = useCallback((index: number, dir: -1 | 1) => {
    setWoodConfigs(prev => {
      const next = [...prev];
      const swap = index + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[index], next[swap]] = [next[swap], next[index]];
      return next;
    });
  }, []);

  const updateWoodConfig = useCallback((colorHex: string, patch: Partial<WoodConfig>) => {
    setWoodConfigs(prev => prev.map(wc => wc.colorHex === colorHex ? { ...wc, ...patch } : wc));
  }, []);

  const busy = status === 'parsing' || status === 'analyzing';

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center gap-3 sticky top-0 z-20 backdrop-blur">
        <svg className="w-6 h-6 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <h1 className="font-semibold text-slate-100 text-lg">Inlay DFM Analyzer</h1>
        <span className="text-slate-500 text-sm hidden sm:block">— VCarve design feasibility for CNC inlays</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 shrink-0 bg-slate-800/50 border-r border-slate-700 flex flex-col">
          <div className="p-5 space-y-6 flex-1 overflow-y-auto min-h-0">
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Design File</h2>
              <FileUpload onFile={handleFile} fileName={vector?.fileName} />
              {status === 'parsing' && (
                <p className="text-xs text-slate-400 mt-2 text-center animate-pulse">Parsing file…</p>
              )}
              {vector && vector.detectedColors.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {vector.detectedColors.map(hex => (
                    <span
                      key={hex}
                      title={woodConfigs.find(w => w.colorHex === hex)?.label ?? hex}
                      className="w-5 h-5 rounded border border-slate-600"
                      style={{ background: hex }}
                    />
                  ))}
                  <span className="text-xs text-slate-500 self-center">
                    {vector.detectedColors.length} wood{vector.detectedColors.length !== 1 ? 's' : ''} detected
                  </span>
                </div>
              )}
            </section>

            {/* Base board species */}
            {vector && (
              <section>
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Base Board</h2>
                <div className="flex items-center gap-2">
                  <span
                    className="w-5 h-5 rounded shrink-0 border border-slate-600"
                    style={{ background: WOOD_SPECIES[backgroundSpecies].baseHex }}
                  />
                  <select
                    value={backgroundSpecies}
                    onChange={e => setBackgroundSpecies(e.target.value as WoodSpeciesKey)}
                    className="flex-1 bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {WOOD_SPECIES_ORDER.map(key => (
                      <option key={key} value={key}>{WOOD_SPECIES[key].name}</option>
                    ))}
                  </select>
                </div>
              </section>
            )}

            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Parameters</h2>
              <SettingsPanel settings={settings} onChange={setSettings} />
            </section>
          </div>

          <div className="p-5 border-t border-slate-700 space-y-3 shrink-0">
            {/* History controls (Undo / Redo / Reset / Export) */}
            {vector && history.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={handleUndo}
                    disabled={!canUndo || busyModification}
                    title={canUndo ? `Undo: ${history[historyIndex].label}` : 'Nothing to undo'}
                    className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    ← Undo
                  </button>
                  <button
                    onClick={handleRedo}
                    disabled={!canRedo || busyModification}
                    title={canRedo ? `Redo: ${history[historyIndex + 1]?.label}` : 'Nothing to redo'}
                    className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Redo →
                  </button>
                </div>
                <p className="text-xs text-slate-500 text-center truncate" title={history[historyIndex]?.label}>
                  Step {historyIndex + 1}/{history.length}: {history[historyIndex]?.label}
                </p>
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={handleResetAll}
                    disabled={(historyIndex === 0 && history.length === 1) || busyModification}
                    className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Reset all
                  </button>
                  <button
                    onClick={handleExportSvg}
                    className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
                  >
                    Export SVG
                  </button>
                </div>
              </div>
            )}

            {status === 'error' && (
              <p className="text-xs text-red-400 bg-red-900/30 rounded p-2">{errorMsg}</p>
            )}
            <button
              onClick={handleAnalyze}
              disabled={!vector || busy}
              className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-colors text-white
                disabled:opacity-40 disabled:cursor-not-allowed disabled:animate-none
                ${analysisStale
                  ? 'bg-amber-600 hover:bg-amber-500 ring-2 ring-amber-400/60 animate-pulse'
                  : 'bg-blue-600 hover:bg-blue-500'}`}
            >
              {status === 'analyzing' ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Analyzing…
                </span>
              ) : analysisStale ? 'Re-run DFM Analysis' : 'Run DFM Analysis'}
            </button>
            <p className="text-xs text-slate-500 text-center">
              {!vector
                ? 'Upload a design file first'
                : analysisStale
                  ? 'Results are stale — click to refresh'
                  : 'Runs entirely in your browser'}
            </p>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6">
          {/* View toggle + overlay controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            {/* Left: legend or placeholder */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
              {!vector ? (
                <span className="text-slate-500 text-sm">
                  Upload a design file to get started
                </span>
              ) : mainView === 'composite' ? (
                <span className="text-slate-500 text-sm">Composite view — assembled inlay preview</span>
              ) : !result ? (
                <span className="text-slate-500 text-sm">Ready to analyze — click Run DFM Analysis</span>
              ) : overlayMode === 'threshold' ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-slate-300 inline-block" />
                    OK
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-red-500 inline-block" />
                    Too narrow — never reaches full depth
                  </span>
                  {settings.grainDirection !== 'end' && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(220,150,30)' }} />
                      Thin wall opposing grain
                    </span>
                  )}
                  {vector && vector.detectedColors.length > 1 && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded inline-block" style={{ background: 'rgb(210,50,210)' }} />
                      Alignment risk (staged cuts)
                    </span>
                  )}
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

            {/* Right: view toggle + overlay toggle */}
            <div className="flex items-center gap-2">
              {/* Analysis / Composite tabs */}
              {vector && (
                <div className="flex items-center gap-1 mr-2">
                  {(['analysis', 'composite'] as const).map(v => (
                    <button
                      key={v}
                      onClick={() => setMainView(v)}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors
                        ${mainView === v
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                    >
                      {v === 'analysis' ? 'Analysis' : 'Composite'}
                    </button>
                  ))}
                </div>
              )}

              {/* Overlay toggle (analysis view only) */}
              {result && mainView === 'analysis' && (
                <div className="flex items-center gap-1">
                  {(['none', 'threshold', 'depthmap'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setOverlayMode(mode)}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors
                        ${overlayMode === mode
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                    >
                      {mode === 'none' ? 'Off' : mode === 'threshold' ? 'Threshold' : 'Depth Map'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {mainView === 'composite' && vector ? (
            <CompositeView
              dataUrl={compositeDataUrl}
              generating={compositeGenerating}
              woodConfigs={woodConfigs}
              backgroundSpecies={backgroundSpecies}
            />
          ) : (
            <>
              {/* Shared geometry */}
              {result && (
                <div className="bg-slate-800 rounded-lg px-4 py-3 mb-5 text-xs space-y-2">
                  <div className="flex flex-wrap gap-x-6 gap-y-2 items-center">
                    <GeomStat label="V-bit cut width"   value={result.vbitCutWidthInches}    />
                    <Divider />
                    <GeomStat label="Full-depth radius" value={result.fullDepthRadiusInches} />
                    <Divider />
                    <GeomStat label="Problem threshold" value={result.thresholdInches}       sub="2× cut width" />
                    {settings.grainDirection !== 'end' && (
                      <>
                        <Divider />
                        <GeomStat label="Thin-wall threshold" value={result.thinWallThresholdInches} />
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-2 items-center pt-2 border-t border-slate-700">
                    <div>
                      <span className="text-slate-400">Total machine time</span>
                      <span className="ml-2 font-semibold text-white">
                        {isFinite(result.totalMachineTimeMinutes)
                          ? formatMinutes(result.totalMachineTimeMinutes)
                          : '—'}
                      </span>
                      {!isFinite(result.totalMachineTimeMinutes) && (
                        <span className="ml-2 text-amber-400">(set V-bit MRR + feed for custom angle)</span>
                      )}
                    </div>
                    <Divider />
                    <span className="text-slate-500">
                      Clearance {clearanceBitLabel(result.clearanceBitDiameterInches)} @ {result.clearanceMRR.toFixed(2)} in³/min
                      {isFinite(result.vbitMRR) && (
                        <>
                          {' · '}
                          V-bit {settings.vbitAngleDegrees}° @ {result.vbitMRR.toFixed(2)} in³/min, {result.vbitFeed.toFixed(0)} in/min
                        </>
                      )}
                    </span>
                    <button
                      onClick={() => setShowBitMatrix(s => !s)}
                      className="ml-auto px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                    >
                      {showBitMatrix ? 'Hide' : 'Compare'} bit combinations
                    </button>
                  </div>
                </div>
              )}

              {/* Bit-combination comparison table */}
              {result && showBitMatrix && (
                <div className="mb-5">
                  <BitMatrixTable
                    matrix={result.machiningTimeTable}
                    currentClearanceDiameter={settings.clearanceBitDiameterInches}
                    currentVbitAngle={settings.vbitAngleDegrees}
                    onSelectCombination={(clearanceDiameter, vbitAngle) => {
                      setSettings(prev => ({
                        ...prev,
                        clearanceBitDiameterInches: clearanceDiameter as 0.125 | 0.25 | 0.5,
                        vbitAngleDegrees: vbitAngle,
                        // Switching to a preset V-bit clears any custom rates so
                        // the analyzer uses the table values from machiningRates.ts.
                        vbitMRRInches3PerMin: undefined,
                        vbitFeedInchesPerMin: undefined,
                      }));
                    }}
                  />
                </div>
              )}

              {/* Per-wood sections */}
              {vector && (
                <div className="space-y-6">
                  {woodConfigs.map((wc, i) => {
                    const woodResult = result?.woods.find(w => w.colorHex === wc.colorHex) ?? null;
                    const otherWoodLabels = Object.fromEntries(
                      woodConfigs.filter(w => w.colorHex !== wc.colorHex).map(w => [w.colorHex, w.label])
                    );
                    const origLayer = originalVector?.layers.find(l => l.colorHex === wc.colorHex);
                    const curLayer = vector.layers.find(l => l.colorHex === wc.colorHex);
                    const isModified = !!(origLayer && curLayer && origLayer.svgFragment !== curLayer.svgFragment);
                    return (
                      <WoodSection
                        key={wc.colorHex}
                        colorHex={wc.colorHex}
                        label={wc.label}
                        onLabelChange={label => updateWoodConfig(wc.colorHex, { label })}
                        species={wc.species}
                        onSpeciesChange={species => updateWoodConfig(wc.colorHex, { species })}
                        canMoveUp={i > 0}
                        canMoveDown={i < woodConfigs.length - 1}
                        onMoveUp={() => moveWood(i, -1)}
                        onMoveDown={() => moveWood(i, 1)}
                        analysis={woodResult}
                        vector={vector}
                        overlayMode={overlayMode}
                        common={result}
                        settings={settings}
                        otherWoodLabels={otherWoodLabels}
                        isModified={isModified}
                        busyModification={busyModification}
                        onExtendForRegistration={() => handleExtendForRegistration(wc.colorHex)}
                        onResetLayer={() => handleResetLayer(wc.colorHex)}
                      />
                    );
                  })}
                </div>
              )}

              {/* How it works (pre-upload) */}
              {!vector && (
                <div className="mt-6 bg-slate-800/40 border border-slate-700 rounded-lg p-5 text-sm text-slate-400 space-y-2 max-w-2xl">
                  <p className="font-semibold text-slate-300">How it works</p>
                  <p>Upload your VCarve design (SVG or DXF). Each distinct fill color is treated as a separate wood species — assign names and species using the controls that appear after upload.</p>
                  <p>Set the real-world width, V-bit angle, inlay depth, and grain direction, then click <strong className="text-slate-200">Run DFM Analysis</strong>.</p>
                  <p>Both the <strong className="text-slate-200">pocket</strong> (the cavity cut into the base) and the <strong className="text-slate-200">plug</strong> (the piece cut from the matching wood stock) are analyzed for each color independently.</p>
                  <p>The formula for depth at any interior point:</p>
                  <code className="block bg-slate-900 rounded px-3 py-2 text-blue-300 text-xs">
                    depth = distance_from_edge / tan(vbit_angle / 2)
                  </code>
                  <p>Areas that never reach full inlay depth <em>and</em> are far from any full-depth zone are highlighted in red. Thin opposing-grain walls are highlighted in amber.</p>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
