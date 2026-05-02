'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import StepperBar, { type StepDef } from '../StepperBar';
import { DEFAULT_BOARD_CONFIG, hasTopGroove, TOP_GROOVE_INLAY_MARGIN_INCHES, type BoardConfig } from '@/types/board';
import type { VectorData, WoodConfig, WoodSpeciesKey } from '@/types';
import { parseVectorFile } from '@/lib/vectorParser';
import { generateComposite } from '@/lib/compositeRenderer';
import { guessSpecies, WOOD_SPECIES } from '@/lib/woodSpecies';
import { INLAY_WOOD_OPTIONS } from '@/lib/pricing';
import Step1BoardForm from './Step1BoardForm';
import Step2ArtPlacement, { type Placement } from './Step2ArtPlacement';

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
 * Top-level container for the guided "Get a quote" experience. Holds all
 * state for the flow and renders whichever step is active.
 *
 * State:
 *   - boardConfig: physical board features (Step 1).
 *   - vector: parsed design file (loaded in Step 2).
 *   - woodConfigs: per-detected-color species choice (priced set).
 *   - placement: design's offset + width on the board, in inches.
 *   - designCompositeUrl: PNG of the design with each color mapped to
 *     its assigned wood — overlaid on the board preview.
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

      // Auto-fit: largest size that fits inside the placeable area, centered.
      const aspect = parsed.naturalHeight / parsed.naturalWidth;
      const margin = hasTopGroove(boardConfig.juiceGroove) ? TOP_GROOVE_INLAY_MARGIN_INCHES : 0;
      const placeableW = boardConfig.widthInches  - 2 * margin;
      const placeableH = boardConfig.heightInches - 2 * margin;
      const widthFromW = placeableW;
      const widthFromH = placeableH / aspect;
      const designWidthInches = Math.min(widthFromW, widthFromH);
      const designHeightInches = designWidthInches * aspect;
      setPlacement({
        offsetXInches: margin + (placeableW - designWidthInches)  / 2,
        offsetYInches: margin + (placeableH - designHeightInches) / 2,
        designWidthInches,
      });
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setParsing(false);
    }
  }, [boardConfig.juiceGroove, boardConfig.widthInches, boardConfig.heightInches]);

  // ---------------------------------------------------------------
  // Composite regeneration whenever vector or wood assignments change.
  // generateComposite renders the design with each layer remapped to
  // its chosen wood; backgroundSpecies = the board wood so the composite
  // visually blends into the board surface.
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
  }, []);

  // Step validity. Step 2 requires a parsed vector with at least one inlay
  // color; the picker forces the species into the priced set so type-wise
  // we just need woodConfigs.length > 0 alongside the vector.
  const step1Valid = true;
  const step2Valid = vector !== null && woodConfigs.length > 0;
  const step3Valid = step2Valid; // becomes "results computed" in PR D
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
            onChange={setBoardConfig}
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
            onNext={() => goToStep(3)}
            canAdvance={step2Valid}
          />
        )}
        {currentStep === 3 && (
          <ComingSoonStub label="Step 3: Quote display (PR D)" />
        )}
      </main>
    </div>
  );
}

function ComingSoonStub({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-sm text-slate-400">🚧 {label} — coming in the next PR.</p>
    </div>
  );
}
