'use client';

import { useState } from 'react';
import Link from 'next/link';
import StepperBar, { type StepDef } from '../StepperBar';
import { DEFAULT_BOARD_CONFIG, type BoardConfig } from '@/types/board';
import Step1BoardForm from './Step1BoardForm';

const QUOTE_STEPS: StepDef[] = [
  { n: 1, label: 'Board',      subtitle: 'Pick your cutting board' },
  { n: 2, label: 'Art',        subtitle: 'Upload and place your design' },
  { n: 3, label: 'Quote',      subtitle: 'See your estimate' },
];

type QuoteStep = 1 | 2 | 3;

/**
 * Top-level container for the guided "Get a quote" experience. Holds all
 * state for the flow and renders whichever step is active. Subsequent
 * PRs add Step 2 (art upload + placement) and Step 3 (quote display).
 */
export default function QuoteApp() {
  const [currentStep, setCurrentStep] = useState<QuoteStep>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<QuoteStep>(1);
  const [boardConfig, setBoardConfig] = useState<BoardConfig>(DEFAULT_BOARD_CONFIG);

  // Step 1 prerequisites: always satisfied — board has a default config.
  // Steps 2 and 3 will gain real validity checks as they're built out.
  const validity: Record<number, boolean> = { 1: true, 2: false, 3: false };

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
          <ComingSoonStub label="Step 2: Art upload + placement" />
        )}
        {currentStep === 3 && (
          <ComingSoonStub label="Step 3: Quote display" />
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
