'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { DFMSettings, VectorData, AnalysisResult, WoodConfig, WoodSpeciesKey, Layer, LayerSnapshot } from '@/types';
import { parseVectorFile } from '@/lib/vectorParser';
import { runDfmAnalysis } from '@/lib/dfmAnalysis';
import { generateComposite } from '@/lib/compositeRenderer';
import { WOOD_SPECIES, guessSpecies } from '@/lib/woodSpecies';
import { combineLayers } from '@/lib/svgLayers';
import { extendForRegistration } from '@/lib/extendForRegistration';
import { fillEnclosedHoles } from '@/lib/fillEnclosedHoles';
import { downloadSvg } from '@/lib/svgExport';
import StepperBar, { type StepNumber } from '@/components/StepperBar';
import Step1Design from '@/components/steps/Step1Design';
import Step2DFM from '@/components/steps/Step2DFM';
import Step3Vbit from '@/components/steps/Step3Vbit';
import Step4Time from '@/components/steps/Step4Time';

const DEFAULT_SETTINGS: DFMSettings = {
  designWidthInches: 5,
  vbitAngleDegrees: 60,
  inlayDepthInches: 0.125,
  grainDirection: 'horizontal',
  analysisResolution: 'default',
  clearanceBitDiameterInches: 0.25,
  plugStockMarginInches: 0.25,
  boardWidthInches: 12,
  boardHeightInches: 9,
  designOffsetXInches: 3.5,
  designOffsetYInches: 2,
};

/** Convert the user's resolution preset into the canvas pixel width used by the analyzer/extender. */
function resolvedCanvasWidth(res: DFMSettings['analysisResolution']): number {
  return res === 'low' ? 600 : res === 'high' ? 2400 : 1200;
}

type Status = 'idle' | 'parsing' | 'analyzing' | 'done' | 'error';
type OverlayMode = 'none' | 'threshold' | 'suggestions' | 'depthmap';

export default function Home() {
  // `originalVector` is the parsed file (immutable after parse).
  // `history` is a stack of layer snapshots; `historyIndex` points at the
  // currently-applied snapshot. The "live" vector is reconstructed by
  // combining `originalVector`'s metadata with `history[historyIndex].layers`.
  const [originalVector, setOriginalVector] = useState<VectorData | null>(null);
  const [history, setHistory] = useState<LayerSnapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [settings, setSettings] = useState<DFMSettings>(DEFAULT_SETTINGS);
  const [hasEverAnalyzed, setHasEverAnalyzed] = useState(false);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('suggestions');
  const [woodConfigs, setWoodConfigs] = useState<WoodConfig[]>([]);
  const [backgroundSpecies, setBackgroundSpecies] = useState<WoodSpeciesKey>('maple');
  const [compositeDataUrl, setCompositeDataUrl] = useState<string | null>(null);
  const [compositeGenerating, setCompositeGenerating] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyModification, setBusyModification] = useState(false);
  const compositeAbort = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Stepper state. `maxReachedStep` is the high-water mark; once a step has
  // been visited the user can always click back to it from the stepper bar,
  // even if a downstream edit invalidated a later step's prerequisite.
  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<StepNumber>(1);

  // Current analysis result — derived from the snapshot's cache.
  const result: AnalysisResult | null = useMemo(
    () => history[historyIndex]?.result ?? null,
    [history, historyIndex],
  );

  const analysisStale = hasEverAnalyzed && result === null;

  // Live vector — original metadata plus the current snapshot's layers,
  // reordered to match woodConfigs so the combined svgString reflects the
  // user's chosen z-order.
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
  // the layer order changes.
  const colorOrderKey = useMemo(() => woodConfigs.map(w => w.colorHex).join('|'), [woodConfigs]);
  useEffect(() => {
    setHistory(prev => {
      if (!prev.some(s => s.result)) return prev;
      return prev.map(s => (s.result ? { ...s, result: undefined } : s));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, colorOrderKey]);

  // Init woodConfigs from detected colors whenever a NEW file is parsed.
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
    setCurrentStep(1);
    setMaxReachedStep(1);
    try {
      const parsed = await parseVectorFile(file);
      setOriginalVector(parsed);
      setHistory([{ layers: parsed.layers, label: 'Original' }]);
      setHistoryIndex(0);
      setSettings(prev => {
        const aspect = parsed.naturalHeight / parsed.naturalWidth;
        const maxWForBoard = Math.min(prev.boardWidthInches, prev.boardHeightInches / aspect);
        const designW = Math.min(prev.designWidthInches, maxWForBoard);
        const designH = designW * aspect;
        return {
          ...prev,
          designWidthInches: designW,
          designOffsetXInches: Math.max(0, (prev.boardWidthInches  - designW) / 2),
          designOffsetYInches: Math.max(0, (prev.boardHeightInches - designH) / 2),
        };
      });
      setStatus('idle');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    }
  }, []);

  // Push a new snapshot onto history.
  const pushSnapshot = useCallback((layers: Layer[], label: string) => {
    setHistory(prev => {
      const truncated = prev.slice(0, historyIndex + 1);
      return [...truncated, { layers, label }];
    });
    setHistoryIndex(idx => idx + 1);
  }, [historyIndex]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const handleUndo = useCallback(() => { if (canUndo) setHistoryIndex(historyIndex - 1); }, [canUndo, historyIndex]);
  const handleRedo = useCallback(() => { if (canRedo) setHistoryIndex(historyIndex + 1); }, [canRedo, historyIndex]);

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

  const handleFillEnclosedHoles = useCallback(async (colorHex: string) => {
    if (!vector) return;
    setBusyModification(true);
    setErrorMsg('');
    try {
      const colorOrder = woodConfigs.map(wc => wc.colorHex);
      const canvasWidth = resolvedCanvasWidth(settings.analysisResolution);
      const res = await fillEnclosedHoles(vector, colorHex, settings.designWidthInches, colorOrder, canvasWidth);
      if (res.filledHoleCount === 0) {
        setErrorMsg('No fillable enclosed holes found on this layer.');
        setStatus('error');
      } else {
        const label = woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;
        pushSnapshot(
          res.layers,
          `Fill ${res.filledHoleCount} hole${res.filledHoleCount !== 1 ? 's' : ''} in ${label} (+${res.filledAreaSqIn.toFixed(3)} in²)`,
        );
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    } finally {
      setBusyModification(false);
    }
  }, [vector, woodConfigs, settings.designWidthInches, settings.analysisResolution, pushSnapshot]);

  // Apply extend-for-registration to every eligible layer in a single
  // undoable snapshot. Threads the per-step result through a working layer
  // array so each call sees the previous one's output, instead of relying
  // on React state which is async.
  const handleExtendAll = useCallback(async (colorHexes: string[]) => {
    if (!vector || colorHexes.length === 0) return;
    setBusyModification(true);
    setErrorMsg('');
    try {
      const colorOrder = woodConfigs.map(wc => wc.colorHex);
      const canvasWidth = resolvedCanvasWidth(settings.analysisResolution);
      let workingLayers = vector.layers;
      let totalAdded = 0;
      let appliedCount = 0;
      for (const colorHex of colorHexes) {
        const workingVector: VectorData = {
          ...vector,
          layers: workingLayers,
          svgString: combineLayers(
            workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight,
          ),
        };
        const res = await extendForRegistration(
          workingVector, colorHex, settings.designWidthInches, colorOrder, canvasWidth,
        );
        if (res.addedPixelCount > 0) {
          workingLayers = res.layers;
          totalAdded += res.addedAreaSqInches;
          appliedCount++;
        }
      }
      if (appliedCount > 0) {
        pushSnapshot(
          workingLayers,
          `Extend ${appliedCount} layer${appliedCount === 1 ? '' : 's'} for registration (+${totalAdded.toFixed(3)} in²)`,
        );
      } else {
        setErrorMsg('No alignment risk regions found across the eligible layers.');
        setStatus('error');
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    } finally {
      setBusyModification(false);
    }
  }, [vector, woodConfigs, settings.designWidthInches, settings.analysisResolution, pushSnapshot]);

  const handleFillAll = useCallback(async (colorHexes: string[]) => {
    if (!vector || colorHexes.length === 0) return;
    setBusyModification(true);
    setErrorMsg('');
    try {
      const colorOrder = woodConfigs.map(wc => wc.colorHex);
      const canvasWidth = resolvedCanvasWidth(settings.analysisResolution);
      let workingLayers = vector.layers;
      let totalFilled = 0;
      let totalArea = 0;
      let appliedLayerCount = 0;
      for (const colorHex of colorHexes) {
        const workingVector: VectorData = {
          ...vector,
          layers: workingLayers,
          svgString: combineLayers(
            workingLayers, vector.viewBox, vector.naturalWidth, vector.naturalHeight,
          ),
        };
        const res = await fillEnclosedHoles(
          workingVector, colorHex, settings.designWidthInches, colorOrder, canvasWidth,
        );
        if (res.filledHoleCount > 0) {
          workingLayers = res.layers;
          totalFilled += res.filledHoleCount;
          totalArea += res.filledAreaSqIn;
          appliedLayerCount++;
        }
      }
      if (totalFilled > 0) {
        pushSnapshot(
          workingLayers,
          `Fill ${totalFilled} hole${totalFilled === 1 ? '' : 's'} across ${appliedLayerCount} layer${appliedLayerCount === 1 ? '' : 's'} (+${totalArea.toFixed(3)} in²)`,
        );
      } else {
        setErrorMsg('No fillable enclosed holes found across the eligible layers.');
        setStatus('error');
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

  // Returns the new result so callers (like Step-1 Next) can chain on success.
  const handleAnalyze = useCallback(async (): Promise<AnalysisResult | null> => {
    if (!vector) return null;
    if (settings.designWidthInches <= 0 || settings.inlayDepthInches <= 0) {
      setErrorMsg('Design width and inlay depth must be greater than zero.');
      setStatus('error');
      return null;
    }
    setStatus('analyzing');
    setErrorMsg('');
    const colorOrder = woodConfigs.map(wc => wc.colorHex);
    const canvasWidth = resolvedCanvasWidth(settings.analysisResolution);
    const snapshotAtStart = history[historyIndex];
    try {
      const r = await runDfmAnalysis(vector, settings, colorOrder, canvasWidth);
      setHistory(prev => prev.map(s => (s === snapshotAtStart ? { ...s, result: r } : s)));
      setHasEverAnalyzed(true);
      // Step 2 is the immediate destination after analysis; default its
      // overlay to suggestions (DFM mode). Step 3 will switch to 'threshold'
      // when the user advances there.
      setOverlayMode('suggestions');
      setStatus('done');
      return r;
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
      return null;
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

  // Per-step validity. Steps gate on derived prerequisites — no extra state.
  const step1Valid = vector !== null && woodConfigs.length > 0;
  const step2Valid = step1Valid && result !== null;
  const step3Valid = step2Valid;
  const step4Valid = step3Valid;
  const validity: Record<StepNumber, boolean> = { 1: step1Valid, 2: step2Valid, 3: step3Valid, 4: step4Valid };

  const advanceTo = useCallback((step: StepNumber) => {
    setCurrentStep(step);
    setMaxReachedStep(prev => (step > prev ? step : prev));
  }, []);

  // Step 1's "Next" doubles as Run Analysis. If a fresh result already exists
  // we just advance. Otherwise we run analysis and advance on success.
  const handleStep1Next = useCallback(async () => {
    if (result) { advanceTo(2); return; }
    const r = await handleAnalyze();
    if (r) advanceTo(2);
  }, [result, handleAnalyze, advanceTo]);

  const onStepperClick = useCallback((step: StepNumber) => {
    setCurrentStep(step);
  }, []);

  const onSettingsChange = useCallback((s: DFMSettings) => setSettings(s), []);

  const onCommitPlacement = useCallback((offsetX: number, offsetY: number, designWidth: number) => {
    setSettings(prev => ({
      ...prev,
      designOffsetXInches: offsetX,
      designOffsetYInches: offsetY,
      designWidthInches: designWidth,
    }));
  }, []);

  const step1NextLabel = !result ? 'Run analysis →' : 'Next →';
  const originalLayers = originalVector?.layers ?? [];

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center gap-3 z-20 backdrop-blur shrink-0">
        <svg className="w-6 h-6 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <h1 className="font-semibold text-slate-100 text-lg">Inlay DFM Analyzer</h1>
        <span className="text-slate-500 text-sm hidden md:block">— VCarve design feasibility for CNC inlays</span>

        {vector && history.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleUndo}
              disabled={!canUndo || busyModification}
              title={canUndo ? `Undo: ${history[historyIndex].label}` : 'Nothing to undo'}
              className="px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ← Undo
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo || busyModification}
              title={canRedo ? `Redo: ${history[historyIndex + 1]?.label}` : 'Nothing to redo'}
              className="px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Redo →
            </button>
            <span className="text-xs text-slate-500 max-w-[14rem] truncate hidden lg:inline" title={history[historyIndex]?.label}>
              {historyIndex + 1}/{history.length}: {history[historyIndex]?.label}
            </span>
            <button
              onClick={handleResetAll}
              disabled={(historyIndex === 0 && history.length === 1) || busyModification}
              className="px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Reset all
            </button>
            <button
              onClick={handleExportSvg}
              className="px-3 py-1 rounded text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              Export SVG
            </button>
          </div>
        )}
      </header>

      <StepperBar
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        validity={validity}
        onStepClick={onStepperClick}
      />

      <main className="flex-1 overflow-hidden p-6 min-h-0">
        {currentStep === 1 && (
          <Step1Design
            vector={vector}
            fileName={vector?.fileName}
            onFile={handleFile}
            parsing={status === 'parsing'}
            settings={settings}
            onSettingsChange={onSettingsChange}
            woodConfigs={woodConfigs}
            onUpdateWoodConfig={updateWoodConfig}
            onMoveWood={moveWood}
            backgroundSpecies={backgroundSpecies}
            onBackgroundSpeciesChange={setBackgroundSpecies}
            compositeDataUrl={compositeDataUrl}
            compositeGenerating={compositeGenerating}
            onCommitPlacement={onCommitPlacement}
            canAdvance={step1Valid && status !== 'analyzing'}
            nextLabel={status === 'analyzing' ? 'Analyzing…' : step1NextLabel}
            onNext={handleStep1Next}
          />
        )}

        {currentStep === 2 && (
          <Step2DFM
            vector={vector}
            originalLayers={originalLayers}
            settings={settings}
            woodConfigs={woodConfigs}
            result={result}
            analysisStale={analysisStale}
            status={status}
            errorMsg={errorMsg}
            overlayMode={overlayMode}
            onOverlayModeChange={setOverlayMode}
            busyModification={busyModification}
            onAnalyze={() => { void handleAnalyze(); }}
            onExtendForRegistration={handleExtendForRegistration}
            onFillEnclosedHoles={handleFillEnclosedHoles}
            onExtendAll={handleExtendAll}
            onFillAll={handleFillAll}
            onResetLayer={handleResetLayer}
            onUpdateWoodConfig={updateWoodConfig}
            onMoveWood={moveWood}
            canAdvance={step2Valid}
            onBack={() => setCurrentStep(1)}
            onNext={() => advanceTo(3)}
          />
        )}

        {currentStep === 3 && (
          <Step3Vbit
            settings={settings}
            onSettingsChange={onSettingsChange}
            result={result}
            canAdvance={step3Valid}
            onBack={() => setCurrentStep(2)}
            onNext={() => advanceTo(4)}
          />
        )}

        {currentStep === 4 && (
          <Step4Time
            result={result}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onBack={() => setCurrentStep(3)}
          />
        )}
      </main>
    </div>
  );
}
