'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { DFMSettings, VectorData, AnalysisResult, WoodConfig, WoodSpeciesKey, Layer, LayerSnapshot, Placement } from '@/types';
import { parseVectorFile } from '@/lib/vectorParser';
import { runDfmAnalysis, DEFAULT_CANVAS_WIDTH } from '@/lib/dfmAnalysis';
import { generateComposite } from '@/lib/compositeRenderer';
import { WOOD_SPECIES, guessSpecies } from '@/lib/woodSpecies';
import { combineLayers } from '@/lib/svgLayers';
import { fillEnclosedHoles } from '@/lib/fillEnclosedHoles';
import { downloadSvg } from '@/lib/svgExport';
import { saveSessionToFile, loadSessionFromFile, looksLikeSessionFile } from '@/lib/sessionExport';
import StepperBar, { type StepNumber } from '@/components/StepperBar';
import DesignSelector from '@/components/DesignSelector';
import Step1Design from '@/components/steps/Step1Design';
import Step2DFM from '@/components/steps/Step2DFM';
import Step3Vbit from '@/components/steps/Step3Vbit';
import Step4Time from '@/components/steps/Step4Time';

const DEFAULT_SETTINGS: DFMSettings = {
  designWidthInches: 5,
  vbitAngleDegrees: 60,
  inlayDepthInches: 0.125,
  grainDirection: 'horizontal',
  clearanceBitDiameterInches: 0.25,
  clearanceStrategy: [0.25],
  toolChangeMinutes: 5,
  plugStockMarginInches: 0.25,
  plugGlueGapInches: 0.005,
  plugSurfaceGapInches: 0.010,
  boardWidthInches: 12,
  boardHeightInches: 9,
  designOffsetXInches: 3.5,
  designOffsetYInches: 2,
};

/**
 * Build a `VectorData` for any design (active or not). Mirrors the
 * `vector` memo's logic but without the active-design dependency, so
 * we can analyze a different design without flipping `activeDesignId`
 * and waiting for state to settle.
 */
function vectorForDesign(d: ExpertDesign): VectorData {
  const snap = d.history[d.historyIndex];
  const snapLayers = snap?.layers ?? d.originalVector.layers;
  const orderHexes = d.woodConfigs.map(wc => wc.colorHex);

  let orderedLayers: Layer[];
  if (orderHexes.length === 0) {
    orderedLayers = snapLayers;
  } else {
    const byHex = new Map(snapLayers.map(l => [l.colorHex, l]));
    orderedLayers = [];
    for (const hex of orderHexes) {
      const l = byHex.get(hex);
      if (l) { orderedLayers.push(l); byHex.delete(hex); }
    }
    for (const l of byHex.values()) orderedLayers.push(l);
  }

  return {
    ...d.originalVector,
    layers: orderedLayers,
    svgString: combineLayers(
      orderedLayers, d.originalVector.viewBox, d.originalVector.naturalWidth, d.originalVector.naturalHeight,
    ),
  };
}

/**
 * Per-design state in the expert flow. The user can hold several
 * designs in flight; analysis, layer history, and color→wood mapping
 * are independent per design. Session-global settings (DFM params,
 * v-bit angle, etc.) apply to whichever design is active.
 */
interface ExpertDesign {
  id: string;
  originalVector: VectorData;
  history: LayerSnapshot[];
  historyIndex: number;
  woodConfigs: WoodConfig[];
  /**
   * Where this design sits on the board, in inches. Per-design so two
   * designs can be scaled and positioned independently. The shared
   * `settings.designOffsetX/Y/designWidthInches` mirror the *active*
   * design's placement (kept in sync below) so existing components
   * that read those settings fields keep working unchanged.
   */
  placement: Placement;
}

type Status = 'idle' | 'parsing' | 'analyzing' | 'done' | 'error';
type OverlayMode = 'none' | 'threshold' | 'suggestions' | 'depthmap';

export default function Home() {
  // Multi-design state. The "active" design is the one steps 1-4 render.
  const [designs, setDesigns] = useState<ExpertDesign[]>([]);
  const [activeDesignId, setActiveDesignId] = useState<string | null>(null);
  const [settings, setSettings] = useState<DFMSettings>(DEFAULT_SETTINGS);
  const [hasEverAnalyzed, setHasEverAnalyzed] = useState(false);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('suggestions');
  const [backgroundSpecies, setBackgroundSpecies] = useState<WoodSpeciesKey>('maple');
  /** Per-design composite PNG dataURL (keyed by design id), so the
   *  CompositeView can paint every design on the board, not just the
   *  active one. The active design is read out of this map by
   *  `compositeDataUrl` below. */
  const [compositeUrls, setCompositeUrls] = useState<Map<string, string>>(new Map());
  const [compositeGenerating, setCompositeGenerating] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [busyModification, setBusyModification] = useState(false);
  const compositeAbort = useRef<{ cancelled: boolean }>({ cancelled: false });
  // Set by session-load to defer analysis until the corresponding state
  // updates have been committed and the derived `vector` memo has settled.
  const pendingSessionAnalysis = useRef(false);
  const [sessionRestoring, setSessionRestoring] = useState(false);

  // Stepper state.
  const [currentStep, setCurrentStep] = useState<StepNumber>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<StepNumber>(1);
  const [vbitTouched, setVbitTouched] = useState(false);

  /** The active design — most state derivations key off this. */
  const activeDesign = useMemo(
    () => designs.find(d => d.id === activeDesignId) ?? null,
    [designs, activeDesignId],
  );

  /** Mutate just the active design via a transformer; no-op if none. */
  const updateActiveDesign = useCallback((fn: (d: ExpertDesign) => ExpertDesign) => {
    setDesigns(prev => prev.map(d => d.id === activeDesignId ? fn(d) : d));
  }, [activeDesignId]);

  // Active design's analysis result — derived from its current snapshot.
  const result: AnalysisResult | null = useMemo(() => {
    if (!activeDesign) return null;
    return activeDesign.history[activeDesign.historyIndex]?.result ?? null;
  }, [activeDesign]);

  const analysisStale = hasEverAnalyzed && result === null;

  // Order-only key for the active design — drives expensive memos that
  // shouldn't refire on label/species edits.
  const activeColorOrderKey = useMemo(
    () => activeDesign?.woodConfigs.map(w => w.colorHex).join('|') ?? '',
    [activeDesign],
  );

  // Live vector — active design's metadata + the current snapshot's
  // layers, reordered to match its woodConfigs.
  const vector: VectorData | null = useMemo(() => {
    if (!activeDesign) return null;
    const { originalVector, history, historyIndex } = activeDesign;
    const snap = history[historyIndex];
    const snapLayers = snap?.layers ?? originalVector.layers;
    const orderHexes = activeColorOrderKey ? activeColorOrderKey.split('|').filter(Boolean) : [];

    let orderedLayers: Layer[];
    if (orderHexes.length === 0) {
      orderedLayers = snapLayers;
    } else {
      const byHex = new Map(snapLayers.map(l => [l.colorHex, l]));
      orderedLayers = [];
      for (const hex of orderHexes) {
        const l = byHex.get(hex);
        if (l) { orderedLayers.push(l); byHex.delete(hex); }
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
  }, [activeDesign, activeColorOrderKey]);

  // Settings keys split by scope:
  //   - sessionSettingsKey: fields that apply to every design. A change
  //     here invalidates ALL designs' cached analyses.
  //   - placement settings (designWidthInches, designOffsetX/Y) are NOT
  //     in either key here — they're per-design now, and we invalidate
  //     the active design inline in `onSettingsChange` / `onCommitPlacement`
  //     so a design-selector swap (which syncs settings) doesn't masquerade
  //     as an analysis-input change.
  const sessionSettingsKey = useMemo(() => [
    settings.inlayDepthInches,
    settings.grainDirection,
    settings.plugStockMarginInches,
    settings.plugGlueGapInches,
    settings.plugSurfaceGapInches,
    settings.vbitMRRInches3PerMin,
    settings.vbitFeedInchesPerMin,
  ].join('|'), [
    settings.inlayDepthInches,
    settings.grainDirection,
    settings.plugStockMarginInches,
    settings.plugGlueGapInches,
    settings.plugSurfaceGapInches,
    settings.vbitMRRInches3PerMin,
    settings.vbitFeedInchesPerMin,
  ]);
  // Skip the first run so we don't clobber freshly-loaded session caches
  // on initial mount.
  const sessionSettingsKeyDidMount = useRef(false);
  useEffect(() => {
    if (!sessionSettingsKeyDidMount.current) {
      sessionSettingsKeyDidMount.current = true;
      return;
    }
    // Session-global settings changed — every design's cached analysis
    // is stale. Per-design placement and color-order changes are
    // invalidated inline (see moveWood / onCommitPlacement / onSettingsChange).
    setDesigns(prev => prev.map(d => {
      if (!d.history.some(s => s.result)) return d;
      return { ...d, history: d.history.map(s => (s.result ? { ...s, result: undefined } : s)) };
    }));
  }, [sessionSettingsKey]);


  // Regenerate per-design composites whenever any design's vector /
  // configs / bg species change. One PNG per design — used by
  // CompositeView to paint every design on the board (active editable,
  // others read-only ghosts).
  useEffect(() => {
    if (designs.length === 0) {
      setCompositeUrls(new Map());
      setCompositeGenerating(false);
      return;
    }
    const token = { cancelled: false };
    compositeAbort.current = token;
    setCompositeGenerating(true);
    Promise.all(designs.map(async d => {
      if (d.woodConfigs.length === 0) return [d.id, null] as const;
      const v = vectorForDesign(d);
      const url = await generateComposite(v, d.woodConfigs, backgroundSpecies);
      return [d.id, url] as const;
    })).then(entries => {
      if (token.cancelled) return;
      const next = new Map<string, string>();
      for (const [id, url] of entries) if (url) next.set(id, url);
      setCompositeUrls(next);
      setCompositeGenerating(false);
    }).catch(err => {
      if (token.cancelled) return;
      // eslint-disable-next-line no-console
      console.error('Composite render failed:', err);
      setCompositeGenerating(false);
    });
    return () => { token.cancelled = true; };
  }, [designs, backgroundSpecies]);

  /** Composite for the active design (used by Step1's primary composite slot). */
  const compositeDataUrl = activeDesignId ? (compositeUrls.get(activeDesignId) ?? null) : null;

  /** Other designs (non-active) for read-only ghost rendering. */
  const otherDesigns = useMemo(() => {
    return designs
      .filter(d => d.id !== activeDesignId)
      .map(d => ({
        id: d.id,
        vector: d.originalVector,
        compositeUrl: compositeUrls.get(d.id) ?? null,
        placement: d.placement,
      }));
  }, [designs, activeDesignId, compositeUrls]);

  /** Add a new design from a parsed vector — same auto-init as the previous single-design path. */
  const appendDesign = useCallback((parsed: VectorData) => {
    const id = crypto.randomUUID();
    const woodConfigs: WoodConfig[] = parsed.detectedColors.map((hex, i) => ({
      colorHex: hex,
      label: WOOD_SPECIES[guessSpecies(hex)].name + (parsed.detectedColors.length > 1 ? ` ${i + 1}` : ''),
      species: guessSpecies(hex),
    }));

    // Default placement: same auto-fit as the previous single-design
    // path used (centered, sized to fit the board's aspect ratio).
    // Each new design gets its OWN placement — they'll likely overlap
    // on first paint, which the user fixes by dragging in the
    // composite view (same UX as the guided flow).
    const aspect = parsed.naturalHeight / parsed.naturalWidth;
    const maxWForBoard = Math.min(settings.boardWidthInches, settings.boardHeightInches / aspect);
    const designW = Math.min(settings.designWidthInches, maxWForBoard);
    const designH = designW * aspect;
    const placement: Placement = {
      designWidthInches: designW,
      offsetXInches: Math.max(0, (settings.boardWidthInches  - designW) / 2),
      offsetYInches: Math.max(0, (settings.boardHeightInches - designH) / 2),
    };

    const newDesign: ExpertDesign = {
      id,
      originalVector: parsed,
      history: [{ layers: parsed.layers, label: 'Original' }],
      historyIndex: 0,
      woodConfigs,
      placement,
    };
    setDesigns(prev => [...prev, newDesign]);
    setActiveDesignId(id);
    return id;
  }, [settings.boardWidthInches, settings.boardHeightInches, settings.designWidthInches]);

  const handleFile = useCallback(async (file: File) => {
    setStatus('parsing');
    setErrorMsg('');
    try {
      // .json files are saved sessions; route them to the session-restore
      // path. Everything else (.svg / .dxf) is appended as a new design.
      if (looksLikeSessionFile(file)) {
        const session = await loadSessionFromFile(file);
        // Session schema v2 carries `designs[]`; v1 sessions are hoisted
        // into a single-design list by the loader.
        setDesigns(session.designs);
        setActiveDesignId(session.activeDesignId ?? session.designs[0]?.id ?? null);
        setSettings(session.settings);
        setBackgroundSpecies(session.backgroundSpecies);
        setCurrentStep(session.currentStep);
        setMaxReachedStep(session.maxReachedStep);
        setVbitTouched(session.vbitTouched);
        setHasEverAnalyzed(session.hasEverAnalyzed);
        if (session.currentStep === 2) setOverlayMode('suggestions');
        else if (session.currentStep === 3) setOverlayMode('threshold');
        setCompositeUrls(new Map());
        pendingSessionAnalysis.current = true;
        setSessionRestoring(true);
        setStatus('idle');
        return;
      }

      // Fresh design upload — append. Reset session step state only
      // when this is the FIRST design.
      const parsed = await parseVectorFile(file);
      const wasEmpty = designs.length === 0;
      if (wasEmpty) {
        setCompositeUrls(new Map());
        setHasEverAnalyzed(false);
        setCurrentStep(1);
        setMaxReachedStep(1);
        setVbitTouched(false);
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
      }
      appendDesign(parsed);
      setStatus('idle');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
    }
  }, [designs.length, appendDesign]);

  /** Remove a design from the list. If the active one is removed, fall back to the first remaining. */
  const handleRemoveDesign = useCallback((id: string) => {
    setDesigns(prev => prev.filter(d => d.id !== id));
    setActiveDesignId(prev => {
      if (prev !== id) return prev;
      const remaining = designs.filter(d => d.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [designs]);

  /** Save the entire session — all designs + settings — as a JSON file. */
  const handleSaveSession = useCallback(() => {
    if (designs.length === 0) return;
    saveSessionToFile({
      designs,
      activeDesignId,
      settings,
      backgroundSpecies,
      currentStep,
      maxReachedStep,
      vbitTouched,
      hasEverAnalyzed,
    });
  }, [
    designs, activeDesignId, settings, backgroundSpecies,
    currentStep, maxReachedStep, vbitTouched, hasEverAnalyzed,
  ]);

  /** Push a new snapshot onto the active design's history. */
  const pushSnapshot = useCallback((layers: Layer[], label: string) => {
    updateActiveDesign(d => {
      const truncated = d.history.slice(0, d.historyIndex + 1);
      return { ...d, history: [...truncated, { layers, label }], historyIndex: d.historyIndex + 1 };
    });
  }, [updateActiveDesign]);

  const canUndo = activeDesign ? activeDesign.historyIndex > 0 : false;
  const canRedo = activeDesign ? activeDesign.historyIndex < activeDesign.history.length - 1 : false;

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    updateActiveDesign(d => ({ ...d, historyIndex: d.historyIndex - 1 }));
  }, [canUndo, updateActiveDesign]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    updateActiveDesign(d => ({ ...d, historyIndex: d.historyIndex + 1 }));
  }, [canRedo, updateActiveDesign]);

  const handleResetAll = useCallback(() => {
    if (!activeDesign) return;
    pushSnapshot(activeDesign.originalVector.layers, 'Reset all to original');
  }, [activeDesign, pushSnapshot]);

  const handleResetLayer = useCallback((colorHex: string) => {
    if (!activeDesign || !vector) return;
    const orig = activeDesign.originalVector.layers.find(l => l.colorHex === colorHex);
    if (!orig) return;
    const newLayers = vector.layers.map(l => l.colorHex === colorHex ? orig : l);
    const label = activeDesign.woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;
    pushSnapshot(newLayers, `Reset ${label}`);
  }, [activeDesign, vector, pushSnapshot]);

  const handleFillEnclosedHoles = useCallback(async (colorHex: string) => {
    if (!vector || !activeDesign) return;
    setBusyModification(true);
    setErrorMsg('');
    try {
      const colorOrder = activeDesign.woodConfigs.map(wc => wc.colorHex);
      const canvasWidth = DEFAULT_CANVAS_WIDTH;
      const res = await fillEnclosedHoles(vector, colorHex, settings.designWidthInches, colorOrder, canvasWidth);
      if (res.filledHoleCount === 0) {
        setErrorMsg('No fillable enclosed holes found on this layer.');
        setStatus('error');
      } else {
        const label = activeDesign.woodConfigs.find(w => w.colorHex === colorHex)?.label ?? colorHex;
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
  }, [vector, activeDesign, settings.designWidthInches, pushSnapshot]);

  const handleFillAll = useCallback(async (colorHexes: string[]) => {
    if (!vector || !activeDesign || colorHexes.length === 0) return;
    setBusyModification(true);
    setErrorMsg('');
    try {
      const colorOrder = activeDesign.woodConfigs.map(wc => wc.colorHex);
      const canvasWidth = DEFAULT_CANVAS_WIDTH;
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
  }, [vector, activeDesign, settings.designWidthInches, pushSnapshot]);

  const handleExportSvg = useCallback(() => {
    if (vector) downloadSvg(vector);
  }, [vector]);

  /**
   * Run DFM analysis on a specific design (not necessarily the active
   * one). Used by `handleStep1Next` to analyze every uploaded design
   * before advancing to Step 2. Each design is analyzed with its OWN
   * placement (designWidth + offsets) overlayed onto the session-
   * shared `settings`.
   */
  const handleAnalyzeFor = useCallback(async (
    design: ExpertDesign | null,
  ): Promise<AnalysisResult | null> => {
    if (!design) return null;
    if (status === 'analyzing') return null;
    if (design.placement.designWidthInches <= 0 || settings.inlayDepthInches <= 0) {
      setErrorMsg('Design width and inlay depth must be greater than zero.');
      setStatus('error');
      return null;
    }
    setStatus('analyzing');
    setErrorMsg('');
    const designVector = vectorForDesign(design);
    const effSettings: DFMSettings = {
      ...settings,
      designWidthInches:    design.placement.designWidthInches,
      designOffsetXInches:  design.placement.offsetXInches,
      designOffsetYInches:  design.placement.offsetYInches,
    };
    const colorOrder = design.woodConfigs.map(wc => wc.colorHex);
    const canvasWidth = DEFAULT_CANVAS_WIDTH;
    const designIdAtStart = design.id;
    const snapshotIndexAtStart = design.historyIndex;
    try {
      const r = await runDfmAnalysis(designVector, effSettings, colorOrder, canvasWidth);
      setDesigns(prev => prev.map(d => {
        if (d.id !== designIdAtStart) return d;
        return {
          ...d,
          history: d.history.map((s, i) => i === snapshotIndexAtStart ? { ...s, result: r } : s),
        };
      }));
      setHasEverAnalyzed(true);
      setStatus('done');
      return r;
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus('error');
      return null;
    }
  }, [settings, status]);

  /** Convenience: analyze the currently-active design. */
  const handleAnalyze = useCallback(
    () => handleAnalyzeFor(activeDesign),
    [activeDesign, handleAnalyzeFor],
  );

  // Deferred analysis after a session load.
  useEffect(() => {
    if (!pendingSessionAnalysis.current) return;
    if (!vector || !activeDesign || activeDesign.woodConfigs.length === 0) return;
    pendingSessionAnalysis.current = false;
    handleAnalyze().finally(() => setSessionRestoring(false));
  }, [vector, activeDesign, handleAnalyze]);

  const moveWood = useCallback((index: number, dir: -1 | 1) => {
    updateActiveDesign(d => {
      const next = [...d.woodConfigs];
      const swap = index + dir;
      if (swap < 0 || swap >= next.length) return d;
      [next[index], next[swap]] = [next[swap], next[index]];
      // Color order is an analysis input — invalidate this design's cache.
      return {
        ...d,
        woodConfigs: next,
        history: d.history.map(snap => snap.result ? { ...snap, result: undefined } : snap),
      };
    });
  }, [updateActiveDesign]);

  const updateWoodConfig = useCallback((colorHex: string, patch: Partial<WoodConfig>) => {
    updateActiveDesign(d => ({
      ...d,
      woodConfigs: d.woodConfigs.map(wc => wc.colorHex === colorHex ? { ...wc, ...patch } : wc),
    }));
  }, [updateActiveDesign]);

  // Per-step validity. A step is valid iff EVERY design satisfies its
  // prerequisites — otherwise switching to a new design from a later
  // step would leave the user on a step whose preconditions don't hold.
  const everyDesignValid = (predicate: (d: ExpertDesign) => boolean): boolean =>
    designs.length > 0 && designs.every(predicate);
  const everyDesignAnalyzed = everyDesignValid(d => d.history[d.historyIndex]?.result != null);
  const step1Valid = everyDesignValid(d => d.woodConfigs.length > 0);
  const step2Valid = step1Valid && everyDesignAnalyzed;
  const step3Valid = step2Valid;
  const step4Valid = step3Valid;
  const validity: Record<StepNumber, boolean> = { 1: step1Valid, 2: step2Valid, 3: step3Valid, 4: step4Valid };

  const goToStep = useCallback((step: StepNumber) => {
    setCurrentStep(step);
    setMaxReachedStep(prev => (step > prev ? step : prev));
    if (step === 2) setOverlayMode('suggestions');
    else if (step === 3) setOverlayMode('threshold');
  }, []);

  // Step 1's "Next" doubles as Run Analysis for ALL designs (one at a time).
  const handleStep1Next = useCallback(async () => {
    const unanalyzed = designs.filter(d => d.history[d.historyIndex]?.result == null);
    if (unanalyzed.length === 0) { goToStep(2); return; }
    for (const d of unanalyzed) {
      await handleAnalyzeFor(d);
    }
    goToStep(2);
  }, [designs, handleAnalyzeFor, goToStep]);

  /**
   * Settings update path. Keeps `settings.designOffsetX/Y/designWidthInches`
   * in sync with the active design's `placement` — so two designs can be
   * scaled and positioned independently while the existing components
   * (CompositeView, Step1Design inputs) keep reading from settings as
   * before. The active design is the source of truth on save and analysis.
   *
   * `designWidthInches` is an analysis input, so a width change also
   * invalidates the active design's cache. Pure offset changes don't
   * affect analysis (only the composite-view placement).
   */
  const onSettingsChange = useCallback((s: DFMSettings) => {
    setSettings(s);
    if (!activeDesign) return;
    const offsetXChanged = s.designOffsetXInches !== activeDesign.placement.offsetXInches;
    const offsetYChanged = s.designOffsetYInches !== activeDesign.placement.offsetYInches;
    const widthChanged   = s.designWidthInches   !== activeDesign.placement.designWidthInches;
    if (!offsetXChanged && !offsetYChanged && !widthChanged) return;
    updateActiveDesign(d => {
      const next = {
        ...d,
        placement: {
          offsetXInches: s.designOffsetXInches,
          offsetYInches: s.designOffsetYInches,
          designWidthInches: s.designWidthInches,
        },
      };
      // Width drives pixelsPerInch, so its change invalidates the cache.
      if (widthChanged) {
        next.history = d.history.map(snap => snap.result ? { ...snap, result: undefined } : snap);
      }
      return next;
    });
  }, [activeDesign, updateActiveDesign]);

  /** Commit a drag/resize from CompositeView. Updates BOTH the active
   *  design's placement and settings (so inputs reflect immediately).
   *  A width change also invalidates the active design's cache. */
  const onCommitPlacement = useCallback((offsetX: number, offsetY: number, designWidth: number) => {
    setSettings(prev => ({
      ...prev,
      designOffsetXInches: offsetX,
      designOffsetYInches: offsetY,
      designWidthInches: designWidth,
    }));
    updateActiveDesign(d => {
      const widthChanged = designWidth !== d.placement.designWidthInches;
      const next = {
        ...d,
        placement: {
          ...d.placement,
          offsetXInches: offsetX,
          offsetYInches: offsetY,
          designWidthInches: designWidth,
        },
      };
      if (widthChanged) {
        next.history = d.history.map(snap => snap.result ? { ...snap, result: undefined } : snap);
      }
      return next;
    });
  }, [updateActiveDesign]);

  /** Commit a 90°-step rotation from CompositeView. Rotation rotates
   *  around the design's center — recompute the visible AABB's top-
   *  left so the design stays "in place" — then clamp to fit the
   *  board. Does NOT invalidate the cached analysis: the DFM pipeline
   *  is rotation-invariant on the pixel grid for 90° steps, so the
   *  cached `AnalysisResult` (machining time, bit plan, plug OBB) is
   *  still correct. */
  const onCommitRotation = useCallback((next: import('@/types').RotationDegrees) => {
    if (!activeDesign) return;
    const aspect = activeDesign.originalVector.naturalHeight / activeDesign.originalVector.naturalWidth;
    const oldTurned = ((activeDesign.placement.rotationDegrees ?? 0) % 180) !== 0;
    const newTurned = (next % 180) !== 0;
    const dw = activeDesign.placement.designWidthInches;
    const oldVisW = oldTurned ? dw * aspect : dw;
    const oldVisH = oldTurned ? dw          : dw * aspect;
    const newVisW = newTurned ? dw * aspect : dw;
    const newVisH = newTurned ? dw          : dw * aspect;
    const cx = activeDesign.placement.offsetXInches + oldVisW / 2;
    const cy = activeDesign.placement.offsetYInches + oldVisH / 2;
    // Clamp the new top-left so the visible AABB stays inside the
    // board. (Width itself doesn't change on rotation.)
    const ox = Math.max(0, Math.min(cx - newVisW / 2, settings.boardWidthInches  - newVisW));
    const oy = Math.max(0, Math.min(cy - newVisH / 2, settings.boardHeightInches - newVisH));
    updateActiveDesign(d => ({
      ...d,
      placement: {
        ...d.placement,
        offsetXInches: ox,
        offsetYInches: oy,
        rotationDegrees: next,
      },
    }));
    // Mirror the post-rotation offset into settings so sidebar inputs
    // reflect the new position. Width is unchanged by rotation.
    setSettings(prev => ({
      ...prev,
      designOffsetXInches: ox,
      designOffsetYInches: oy,
    }));
  }, [activeDesign, updateActiveDesign, settings.boardWidthInches, settings.boardHeightInches]);

  /** When the active design changes (selection swap), pull its
   *  placement into settings so CompositeView and Step1 inputs render
   *  the new design's values. The reverse direction (settings → design)
   *  is handled by `onSettingsChange` and `onCommitPlacement`. */
  useEffect(() => {
    if (!activeDesign) return;
    setSettings(prev => {
      if (prev.designWidthInches    === activeDesign.placement.designWidthInches
       && prev.designOffsetXInches  === activeDesign.placement.offsetXInches
       && prev.designOffsetYInches  === activeDesign.placement.offsetYInches) return prev;
      return {
        ...prev,
        designWidthInches:    activeDesign.placement.designWidthInches,
        designOffsetXInches:  activeDesign.placement.offsetXInches,
        designOffsetYInches:  activeDesign.placement.offsetYInches,
      };
    });
    // Intentionally only on ID change — re-running on every activeDesign
    // mutation would loop with the settings-write path above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDesignId]);

  const step1NextLabel = !everyDesignAnalyzed ? 'Run analysis →' : 'Next →';
  const originalLayers = activeDesign?.originalVector.layers ?? [];
  const woodConfigs = activeDesign?.woodConfigs ?? [];

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

        {activeDesign && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleUndo}
              disabled={!canUndo || busyModification}
              title={canUndo ? `Undo: ${activeDesign.history[activeDesign.historyIndex].label}` : 'Nothing to undo'}
              className="px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ← Undo
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo || busyModification}
              title={canRedo ? `Redo: ${activeDesign.history[activeDesign.historyIndex + 1]?.label}` : 'Nothing to redo'}
              className="px-2 py-1 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Redo →
            </button>
            <span className="text-xs text-slate-500 max-w-[14rem] truncate hidden lg:inline" title={activeDesign.history[activeDesign.historyIndex]?.label}>
              {activeDesign.historyIndex + 1}/{activeDesign.history.length}: {activeDesign.history[activeDesign.historyIndex]?.label}
            </span>
            <button
              onClick={handleResetAll}
              disabled={(activeDesign.historyIndex === 0 && activeDesign.history.length === 1) || busyModification}
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
            <button
              onClick={handleSaveSession}
              title="Download a .inlay-session.json that captures every design, settings, and history. Drop it back into the file picker to restore."
              className="px-3 py-1 rounded text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-100 transition-colors"
            >
              Save session
            </button>
          </div>
        )}
      </header>

      <StepperBar
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        validity={validity}
        onStepClick={(n) => goToStep(n as StepNumber)}
      />

      <main className="flex-1 overflow-hidden p-6 min-h-0">
        {/* Design selector — visible whenever there are any designs. */}
        {designs.length > 0 && activeDesignId && (
          <DesignSelector
            designs={designs.map(d => ({ id: d.id, fileName: d.originalVector.fileName }))}
            activeDesignId={activeDesignId}
            onSelect={setActiveDesignId}
            onAdd={handleFile}
            onRemove={handleRemoveDesign}
          />
        )}

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
            otherDesigns={otherDesigns}
            onCommitPlacement={onCommitPlacement}
            designRotationDegrees={activeDesign?.placement.rotationDegrees}
            onCommitRotation={onCommitRotation}
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
            onFillEnclosedHoles={handleFillEnclosedHoles}
            onFillAll={handleFillAll}
            onResetLayer={handleResetLayer}
            onUpdateWoodConfig={updateWoodConfig}
            onMoveWood={moveWood}
            canAdvance={step2Valid}
            onBack={() => goToStep(1)}
            onNext={() => goToStep(3)}
          />
        )}

        {currentStep === 3 && (
          <Step3Vbit
            vector={vector}
            originalLayers={originalLayers}
            settings={settings}
            onSettingsChange={onSettingsChange}
            woodConfigs={woodConfigs}
            result={result}
            overlayMode={overlayMode}
            onOverlayModeChange={setOverlayMode}
            busyModification={busyModification}
            vbitTouched={vbitTouched}
            onVbitTouched={() => setVbitTouched(true)}
            onFillEnclosedHoles={handleFillEnclosedHoles}
            onResetLayer={handleResetLayer}
            onUpdateWoodConfig={updateWoodConfig}
            onMoveWood={moveWood}
            canAdvance={step3Valid}
            onBack={() => goToStep(2)}
            onNext={() => goToStep(4)}
          />
        )}

        {currentStep === 4 && (
          <Step4Time
            result={result}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onBack={() => goToStep(3)}
          />
        )}
      </main>

      {sessionRestoring && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center"
        >
          <div className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl px-6 py-5 flex items-center gap-4 max-w-md">
            <span className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <div>
              <p className="text-sm font-semibold text-slate-100">Restoring session…</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Re-running analysis to populate the steps. This usually takes a few seconds.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
