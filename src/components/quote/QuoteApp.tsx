'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import StepperBar, { type StepDef } from '../StepperBar';
import {
  DEFAULT_BOARD_CONFIG, hasTopGroove, hasBottomGroove,
  TOP_GROOVE_INLAY_MARGIN_INCHES, BOTTOM_GROOVE_INLAY_MARGIN_INCHES,
  backSideFeatureAabbs,
  type BoardConfig,
} from '@/types/board';
import type { Design, Placement, WoodConfig, WoodSpeciesKey } from '@/types';
import { parseVectorFile } from '@/lib/vectorParser';
import { generateComposite } from '@/lib/compositeRenderer';
import { guessSpecies, WOOD_SPECIES } from '@/lib/woodSpecies';
import { INLAY_WOOD_OPTIONS, computeQuote, type QuoteResult } from '@/lib/pricing';
import { runQuoteOptimization, type MultiDesignOptimizationResult } from '@/lib/quoteOptimizer';
import { boxesOverlap, findFreeSpot, type AABB } from '@/lib/aabb';
import { effectivePlacementAabb } from '@/lib/rotation';
import Step1BoardForm from './Step1BoardForm';
import Step2ArtPlacement from './Step2ArtPlacement';
import Step3QuoteDisplay from './Step3QuoteDisplay';
import OptimizingOverlay from './OptimizingOverlay';
import RequestManufacturingDialog from './RequestManufacturingDialog';

const QUOTE_STEPS: StepDef[] = [
  { n: 1, label: 'Board',      subtitle: 'Pick your cutting board' },
  { n: 2, label: 'Art',        subtitle: 'Upload and place your designs' },
  { n: 3, label: 'Quote',      subtitle: 'See your estimate' },
];

type QuoteStep = 1 | 2 | 3;

const FALLBACK_INLAY_SPECIES: WoodSpeciesKey = 'walnut';

/** Pick a default inlay species that's in the priced set; fall back to walnut. */
function pickPricedSpecies(hex: string): WoodSpeciesKey {
  const guess = guessSpecies(hex);
  return INLAY_WOOD_OPTIONS.includes(guess) ? guess : FALLBACK_INLAY_SPECIES;
}

/** AABB of a design on the board, in inches — accounts for 90°-step rotation. */
export function designAabb(d: Design): AABB {
  return effectivePlacementAabb(
    d.placement, d.vector.naturalWidth, d.vector.naturalHeight,
  );
}

/** True iff any same-side pair of designs overlaps, OR if any design
 *  on the back side overlaps a fixed back-side feature (feet /
 *  underside handle). Two designs on opposite sides don't conflict. */
function anyOverlap(designs: readonly Design[], boardConfig: BoardConfig): boolean {
  // Same-side pairwise.
  for (let i = 0; i < designs.length; i++) {
    for (let j = i + 1; j < designs.length; j++) {
      if (designs[i].side !== designs[j].side) continue;
      if (boxesOverlap(designAabb(designs[i]), designAabb(designs[j]))) return true;
    }
  }
  // Back-side designs vs fixed features.
  const backFeatures = backSideFeatureAabbs(boardConfig);
  if (backFeatures.length > 0) {
    for (const d of designs) {
      if (d.side !== 'bottom') continue;
      const a = designAabb(d);
      for (const f of backFeatures) if (boxesOverlap(a, f)) return true;
    }
  }
  return false;
}

/** Inset rectangle on the board where designs of a given side are
 *  allowed. Top side respects only the top juice groove margin;
 *  bottom side respects the bottom groove margin. (Feet + handles
 *  are checked as separate AABB obstacles, not via this rect.) */
function placeableRect(boardConfig: BoardConfig, side: 'top' | 'bottom'): AABB {
  const grooveOnSide = side === 'top'
    ? hasTopGroove(boardConfig.juiceGroove)
    : hasBottomGroove(boardConfig.juiceGroove);
  const margin = grooveOnSide
    ? (side === 'top' ? TOP_GROOVE_INLAY_MARGIN_INCHES : BOTTOM_GROOVE_INLAY_MARGIN_INCHES)
    : 0;
  return {
    x: margin, y: margin,
    w: boardConfig.widthInches  - 2 * margin,
    h: boardConfig.heightInches - 2 * margin,
  };
}

/**
 * Top-level container for the guided "Get a quote" experience.
 *
 * Step 1 (Board) → Step 2 (Designs + woods + placement) → optimizer
 * pipeline (background, with progress overlay) → Step 3 (Quote display
 * + tips + Request Manufacturing).
 *
 * Multi-design: the user can upload several designs, each with its own
 * placement and color→wood mapping. Designs cannot AABB-overlap on the
 * board (touching is allowed). Cost is aggregated per species across
 * all designs.
 */
export default function QuoteApp() {
  const [currentStep, setCurrentStep] = useState<QuoteStep>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<QuoteStep>(1);

  const [boardConfig, setBoardConfig] = useState<BoardConfig>(DEFAULT_BOARD_CONFIG);

  const [designs, setDesigns] = useState<Design[]>([]);
  /** Which face the user is currently viewing in Step 2 / Step 3.
   *  New uploads attach to this side. */
  const [currentSide, setCurrentSide] = useState<'top' | 'bottom'>('top');
  const [parsing, setParsing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  /** Per-design composite PNG dataURL, keyed by design id. */
  const [compositeUrls, setCompositeUrls] = useState<Map<string, string>>(new Map());

  // Optimization + quote state.
  const [optimizingLabel, setOptimizingLabel] = useState<string | null>(null);
  const [optimization, setOptimization] = useState<MultiDesignOptimizationResult | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);

  /** Invalidate any cached optimizer/quote output. Call when design or board changes. */
  const invalidateQuote = useCallback(() => {
    setOptimization(null);
    setQuote(null);
  }, []);

  // ---------------------------------------------------------------
  // File upload → parse → init woodConfigs → auto-fit placement.
  // Append a new Design to the list. Auto-position to a free spot;
  // fall back to placing at origin if nothing fits (the user gets a
  // visible overlap they can fix).
  // ---------------------------------------------------------------
  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setErrorMsg('');
    try {
      const parsed = await parseVectorFile(file);

      const initialConfigs: WoodConfig[] = parsed.detectedColors.map((hex, i) => {
        const species = pickPricedSpecies(hex);
        return {
          colorHex: hex,
          label: WOOD_SPECIES[species].name + (parsed.detectedColors.length > 1 ? ` ${i + 1}` : ''),
          species,
        };
      });

      const aspect = parsed.naturalHeight / parsed.naturalWidth;
      const bounds = placeableRect(boardConfig, currentSide);

      // Same-side designs participate in the free-spot search; designs
      // on the other side are irrelevant (different physical face).
      // On the back side we also need to dodge feet + underside-handle
      // pockets, which we treat as fixed AABB obstacles.
      const sameSideAabbs = designs.filter(d => d.side === currentSide).map(designAabb);
      const fixedFeatureAabbs = currentSide === 'bottom' ? backSideFeatureAabbs(boardConfig) : [];
      const obstacles = [...sameSideAabbs, ...fixedFeatureAabbs];

      // Default size: a quarter of the placeable area (capped to fit
      // both dimensions). For the FIRST design on this side, fill the
      // placeable area as before. Otherwise pick a free non-
      // overlapping spot.
      const isFirstOnSide = sameSideAabbs.length === 0 && fixedFeatureAabbs.length === 0;
      const defaultW = Math.min(bounds.w * 0.5, bounds.h / aspect * 0.5);

      let offsetX: number;
      let offsetY: number;
      let designWidthInches: number;
      if (isFirstOnSide) {
        designWidthInches = Math.min(bounds.w, bounds.h / aspect);
        const designHeightInches = designWidthInches * aspect;
        offsetX = bounds.x + (bounds.w - designWidthInches)  / 2;
        offsetY = bounds.y + (bounds.h - designHeightInches) / 2;
      } else {
        const defaultH = defaultW * aspect;
        const spot = findFreeSpot(defaultW, defaultH, bounds, obstacles);
        offsetX = spot?.x ?? bounds.x;
        offsetY = spot?.y ?? bounds.y;
        designWidthInches = defaultW;
      }

      const newDesign: Design = {
        id: crypto.randomUUID(),
        vector: parsed,
        woodConfigs: initialConfigs,
        placement: { offsetXInches: offsetX, offsetYInches: offsetY, designWidthInches },
        side: currentSide,
      };
      setDesigns(prev => [...prev, newDesign]);
      invalidateQuote();
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setParsing(false);
    }
  }, [boardConfig, designs, currentSide, invalidateQuote]);

  const removeDesign = useCallback((id: string) => {
    setDesigns(prev => prev.filter(d => d.id !== id));
    setCompositeUrls(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    invalidateQuote();
  }, [invalidateQuote]);

  const updateDesignPlacement = useCallback((id: string, placement: Placement) => {
    setDesigns(prev => prev.map(d => d.id === id ? { ...d, placement } : d));
    invalidateQuote();
  }, [invalidateQuote]);

  const updateDesignWoodConfig = useCallback((
    designId: string, colorHex: string, patch: Partial<WoodConfig>,
  ) => {
    setDesigns(prev => prev.map(d => {
      if (d.id !== designId) return d;
      return {
        ...d,
        woodConfigs: d.woodConfigs.map(wc => wc.colorHex === colorHex ? { ...wc, ...patch } : wc),
      };
    }));
    invalidateQuote();
  }, [invalidateQuote]);

  // Board changes invalidate the quote too — every cost lever depends on it.
  const updateBoardConfig = useCallback((next: BoardConfig) => {
    setBoardConfig(next);
    invalidateQuote();
  }, [invalidateQuote]);

  // ---------------------------------------------------------------
  // Composite regeneration whenever any design's vector / wood
  // assignments / board wood change. One PNG per design.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (designs.length === 0) {
      setCompositeUrls(new Map());
      return;
    }
    const cancel = { cancelled: false };
    Promise.all(designs.map(async d => {
      const url = await generateComposite(d.vector, d.woodConfigs, boardConfig.wood);
      return [d.id, url] as const;
    })).then(entries => {
      if (cancel.cancelled) return;
      setCompositeUrls(new Map(entries));
    }).catch(err => {
      if (cancel.cancelled) return;
      // eslint-disable-next-line no-console
      console.error('Composite render failed:', err);
    });
    return () => { cancel.cancelled = true; };
  }, [designs, boardConfig.wood]);

  // ---------------------------------------------------------------
  // Step 2 → Quote: run the optimizer (per design), aggregate, compute
  // the quote, and advance to Step 3. Failures bubble up as a banner.
  // ---------------------------------------------------------------
  const runOptimizationAndQuote = useCallback(async () => {
    if (designs.length === 0) return;
    setOptimizingLabel('Starting…');
    setErrorMsg('');
    try {
      const opt = await runQuoteOptimization({
        designs,
        onProgress: setOptimizingLabel,
      });
      // Replace any NaN cutting times (a side with all-infeasible
      // designs) with 0 so the cost model proceeds rather than
      // propagating NaN. The "approximate quote" banner is gated on
      // `noFeasibleAngle` instead.
      const sanitizeSide = (s: typeof opt.aggregated.perSide.top) => ({
        ...s,
        totalCuttingMinutes: isFinite(s.totalCuttingMinutes) ? s.totalCuttingMinutes : 0,
      });
      const q = computeQuote({
        boardConfig,
        perSide: {
          top:    sanitizeSide(opt.aggregated.perSide.top),
          bottom: sanitizeSide(opt.aggregated.perSide.bottom),
        },
      });
      setOptimization(opt);
      setQuote(q);
      setCurrentStep(3);
      setMaxReachedStep(prev => prev < 3 ? 3 : prev);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setOptimizingLabel(null);
    }
  }, [designs, boardConfig]);

  // ---------------------------------------------------------------
  // Validity gates.
  // Step 2 valid iff at least one design AND no overlaps.
  // ---------------------------------------------------------------
  const overlapping = useMemo(() => anyOverlap(designs, boardConfig), [designs, boardConfig]);
  const step1Valid = true;
  const step2Valid = designs.length > 0 && !overlapping;
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
            designs={designs}
            compositeUrls={compositeUrls}
            parsing={parsing}
            errorMsg={errorMsg}
            overlapping={overlapping}
            currentSide={currentSide}
            onChangeSide={setCurrentSide}
            onAddDesign={handleFile}
            onRemoveDesign={removeDesign}
            onUpdateDesignPlacement={updateDesignPlacement}
            onUpdateDesignWoodConfig={updateDesignWoodConfig}
            onBack={() => goToStep(1)}
            onNext={runOptimizationAndQuote}
            canAdvance={step2Valid}
          />
        )}
        {currentStep === 3 && optimization && quote && (
          <Step3QuoteDisplay
            boardConfig={boardConfig}
            optimization={optimization}
            quote={quote}
            compositeUrls={compositeUrls}
            currentSide={currentSide}
            onChangeSide={setCurrentSide}
            onBack={() => goToStep(2)}
            onRequestManufacturing={() => setRequestDialogOpen(true)}
          />
        )}
      </main>

      {optimizingLabel !== null && <OptimizingOverlay label={optimizingLabel} />}

      {quote && optimization && (
        <RequestManufacturingDialog
          open={requestDialogOpen}
          onClose={() => setRequestDialogOpen(false)}
          boardConfig={boardConfig}
          optimization={optimization}
          quote={quote}
        />
      )}
    </div>
  );
}
