'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import StepperBar, { type StepDef } from '../StepperBar';
import { DEFAULT_BOARD_CONFIG, hasTopGroove, TOP_GROOVE_INLAY_MARGIN_INCHES, type BoardConfig } from '@/types/board';
import type { AnalysisResult, VectorData, WoodConfig, WoodSpeciesKey } from '@/types';
import { parseVectorFile } from '@/lib/vectorParser';
import { generateComposite } from '@/lib/compositeRenderer';
import { guessSpecies, WOOD_SPECIES } from '@/lib/woodSpecies';
import { INLAY_WOOD_OPTIONS, computeQuote, type QuoteResult } from '@/lib/pricing';
import { runQuoteOptimization } from '@/lib/quoteOptimizer';
import type { PerLayerBitPlan } from '@/lib/machiningTime';
import Step1BoardForm from './Step1BoardForm';
import Step2ArtPlacement, { type Placement } from './Step2ArtPlacement';
import Step3QuoteDisplay from './Step3QuoteDisplay';
import OptimizingOverlay from './OptimizingOverlay';
import RequestManufacturingDialog from './RequestManufacturingDialog';

const QUOTE_STEPS: StepDef[] = [
  { n: 1, label: 'Board',      subtitle: 'Pick your cutting board' },
  { n: 2, label: 'Art',        subtitle: 'Upload and place your design' },
  { n: 3, label: 'Quote',      subtitle: 'See your estimate' },
];

type QuoteStep = 1 | 2 | 3;

const FALLBACK_INLAY_SPECIES: WoodSpeciesKey = 'walnut';

/** Pick a default inlay species that's in the priced set; fall back to walnut. */
function pickPricedSpecies(hex: string): WoodSpeciesKey {
  const guess = guessSpecies(hex);
  return INLAY_WOOD_OPTIONS.includes(guess) ? guess : FALLBACK_INLAY_SPECIES;
}

/**
 * Top-level container for the guided "Get a quote" experience.
 *
 * Step 1 (Board) → Step 2 (Art + woods + placement) → optimizer pipeline
 * (background, with progress overlay) → Step 3 (Quote display + tips +
 * Request Manufacturing).
 */
export default function QuoteApp() {
  const [currentStep, setCurrentStep] = useState<QuoteStep>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<QuoteStep>(1);

  const [boardConfig, setBoardConfig] = useState<BoardConfig>(DEFAULT_BOARD_CONFIG);

  const [vector, setVector] = useState<VectorData | null>(null);
  const [parsing, setParsing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [woodConfigs, setWoodConfigs] = useState<WoodConfig[]>([]);
  const [placement, setPlacement] = useState<Placement>({
    offsetXInches: 0, offsetYInches: 0, designWidthInches: boardConfig.widthInches,
  });

  const [designCompositeUrl, setDesignCompositeUrl] = useState<string | null>(null);
  const compositeAbort = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Optimization + quote state.
  const [optimizingLabel, setOptimizingLabel] = useState<string | null>(null);
  const [optimizedVector, setOptimizedVector] = useState<VectorData | null>(null);
  const [optimizedWoodConfigs, setOptimizedWoodConfigs] = useState<WoodConfig[]>([]);
  const [optimizedResult, setOptimizedResult] = useState<AnalysisResult | null>(null);
  const [bitPlan, setBitPlan] = useState<PerLayerBitPlan | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [noFeasibleAngle, setNoFeasibleAngle] = useState(false);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);

  // ---------------------------------------------------------------
  // File upload → parse → init woodConfigs → auto-fit placement.
  // ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setErrorMsg('');
    try {
      const parsed = await parseVectorFile(file);
      setVector(parsed);

      const initialConfigs: WoodConfig[] = parsed.detectedColors.map((hex, i) => {
        const species = pickPricedSpecies(hex);
        return {
          colorHex: hex,
          label: WOOD_SPECIES[species].name + (parsed.detectedColors.length > 1 ? ` ${i + 1}` : ''),
          species,
        };
      });
      setWoodConfigs(initialConfigs);

      const aspect = parsed.naturalHeight / parsed.naturalWidth;
      const margin = hasTopGroove(boardConfig.juiceGroove) ? TOP_GROOVE_INLAY_MARGIN_INCHES : 0;
      const placeableW = boardConfig.widthInches  - 2 * margin;
      const placeableH = boardConfig.heightInches - 2 * margin;
      const designWidthInches = Math.min(placeableW, placeableH / aspect);
      const designHeightInches = designWidthInches * aspect;
      setPlacement({
        offsetXInches: margin + (placeableW - designWidthInches)  / 2,
        offsetYInches: margin + (placeableH - designHeightInches) / 2,
        designWidthInches,
      });

      // Loading new art invalidates any previously-computed quote.
      setOptimizedVector(null);
      setOptimizedResult(null);
      setBitPlan(null);
      setQuote(null);
      setNoFeasibleAngle(false);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setParsing(false);
    }
  }, [boardConfig.juiceGroove, boardConfig.widthInches, boardConfig.heightInches]);

  // ---------------------------------------------------------------
  // Composite regeneration whenever vector / wood assignments / board
  // wood change. Used as the design overlay on Steps 2 and 3.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!vector || woodConfigs.length === 0) {
      setDesignCompositeUrl(null);
      return;
    }
    const token = { cancelled: false };
    compositeAbort.current = token;
    generateComposite(vector, woodConfigs, boardConfig.wood)
      .then(url => { if (!token.cancelled) setDesignCompositeUrl(url); })
      .catch(err => {
        if (token.cancelled) return;
        // eslint-disable-next-line no-console
        console.error('Composite render failed:', err);
        setDesignCompositeUrl(null);
      });
    return () => { token.cancelled = true; };
  }, [vector, woodConfigs, boardConfig.wood]);

  const updateWoodConfig = useCallback((colorHex: string, patch: Partial<WoodConfig>) => {
    setWoodConfigs(prev => prev.map(wc => wc.colorHex === colorHex ? { ...wc, ...patch } : wc));
    // Wood-color change invalidates the cached quote (different material cost).
    setQuote(null);
    setOptimizedResult(null);
    setBitPlan(null);
  }, []);

  // Board changes invalidate the quote too — every cost lever depends on it.
  const updateBoardConfig = useCallback((next: BoardConfig) => {
    setBoardConfig(next);
    setQuote(null);
    setOptimizedResult(null);
    setBitPlan(null);
  }, []);

  // ---------------------------------------------------------------
  // Step 2 → Quote: run the optimizer, then compute the quote and
  // advance to Step 3. Failures bubble up as a banner on Step 2.
  // ---------------------------------------------------------------
  const runOptimizationAndQuote = useCallback(async () => {
    if (!vector || woodConfigs.length === 0) return;
    setOptimizingLabel('Starting…');
    setErrorMsg('');
    try {
      const opt = await runQuoteOptimization({
        vector,
        woodConfigs,
        designWidthInches: placement.designWidthInches,
        onProgress: setOptimizingLabel,
      });
      const totalMachineMinutes = isFinite(opt.totalMachineMinutes) ? opt.totalMachineMinutes : 0;
      const q = computeQuote({
        boardConfig,
        woodConfigs: opt.woodConfigs,
        totalMachineMinutes,
      });
      setOptimizedVector(opt.vector);
      setOptimizedWoodConfigs(opt.woodConfigs);
      setOptimizedResult(opt.result);
      setBitPlan(opt.bitPlan);
      setQuote(q);
      setNoFeasibleAngle(opt.bitPlan === null);
      // Advance.
      setCurrentStep(3);
      setMaxReachedStep(prev => prev < 3 ? 3 : prev);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setOptimizingLabel(null);
    }
  }, [vector, woodConfigs, placement.designWidthInches, boardConfig]);

  // Validity
  const step1Valid = true;
  const step2Valid = vector !== null && woodConfigs.length > 0;
  const step3Valid = quote !== null;
  const validity: Record<number, boolean> = { 1: step1Valid, 2: step2Valid, 3: step3Valid };

  const goToStep = (step: number) => {
    if (step < 1 || step > 3) return;
    setCurrentStep(step as QuoteStep);
    setMaxReachedStep(prev => (step > prev ? step as QuoteStep : prev));
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900">
      <header className="bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center gap-3 shrink-0">
        <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">← Home</Link>
        <h1 className="font-semibold text-slate-100 text-lg ml-2">Get a quote</h1>
        <span className="text-slate-500 text-sm hidden md:block">— inlaid cutting board, custom art</span>
      </header>

      <StepperBar
        currentStep={currentStep}
        maxReachedStep={maxReachedStep}
        validity={validity}
        steps={QUOTE_STEPS}
        onStepClick={goToStep}
      />

      <main className="flex-1 overflow-hidden p-6 min-h-0">
        {currentStep === 1 && (
          <Step1BoardForm
            config={boardConfig}
            onChange={updateBoardConfig}
            onNext={() => goToStep(2)}
          />
        )}
        {currentStep === 2 && (
          <Step2ArtPlacement
            boardConfig={boardConfig}
            vector={vector}
            parsing={parsing}
            errorMsg={errorMsg}
            onFile={handleFile}
            woodConfigs={woodConfigs}
            onUpdateWoodConfig={updateWoodConfig}
            placement={placement}
            onPlacementChange={setPlacement}
            designCompositeUrl={designCompositeUrl}
            onBack={() => goToStep(1)}
            onNext={runOptimizationAndQuote}
            canAdvance={step2Valid}
          />
        )}
        {currentStep === 3 && optimizedVector && optimizedResult && quote && (
          <Step3QuoteDisplay
            boardConfig={boardConfig}
            vector={optimizedVector}
            woodConfigs={optimizedWoodConfigs}
            result={optimizedResult}
            quote={quote}
            bitPlan={bitPlan}
            noFeasibleAngle={noFeasibleAngle}
            designCompositeUrl={designCompositeUrl}
            placement={placement}
            onBack={() => goToStep(2)}
            onRequestManufacturing={() => setRequestDialogOpen(true)}
          />
        )}
      </main>

      {optimizingLabel !== null && <OptimizingOverlay label={optimizingLabel} />}

      {quote && (
        <RequestManufacturingDialog
          open={requestDialogOpen}
          onClose={() => setRequestDialogOpen(false)}
          boardConfig={boardConfig}
          woodConfigs={optimizedWoodConfigs}
          quote={quote}
        />
      )}
    </div>
  );
}
