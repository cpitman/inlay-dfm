'use client';

export type StepNumber = 1 | 2 | 3 | 4;

export interface StepDef {
  n: number;
  label: string;
  subtitle: string;
}

const DEFAULT_EXPERT_STEPS: StepDef[] = [
  { n: 1, label: 'Design',  subtitle: 'Set up the inlay'             },
  { n: 2, label: 'DFM',     subtitle: 'Optimize for manufacturing'   },
  { n: 3, label: 'V-bit',   subtitle: 'Pick the carving bit'         },
  { n: 4, label: 'Time',    subtitle: 'Compare machining times'      },
];

interface StepperBarProps {
  currentStep: number;
  maxReachedStep: number;
  /** Per-step prerequisite validity. Keyed by step number (1-based). */
  validity: Record<number, boolean>;
  onStepClick: (step: number) => void;
  /** Optional override of the default 4-step expert config. */
  steps?: StepDef[];
}

/**
 * Linear stepper. A step is:
 *   - current  → blue background, large
 *   - complete → checkmark, clickable
 *   - locked   → grayed out, non-clickable (prerequisites not met)
 *
 * `validity[n]` reflects whether step n's prerequisites are currently met.
 * `maxReachedStep` is the high-water mark — once a step has been unlocked
 * the user can always click back to it, even if a downstream edit
 * temporarily invalidates a later step. This keeps navigation predictable.
 */
export default function StepperBar({
  currentStep, maxReachedStep, validity, onStepClick, steps,
}: StepperBarProps) {
  const stepDefs = steps ?? DEFAULT_EXPERT_STEPS;
  return (
    <nav
      className="bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center gap-2 backdrop-blur"
      aria-label="Workflow steps"
    >
      {stepDefs.map((def, idx) => {
        const isCurrent  = currentStep === def.n;
        const isReached  = def.n <= maxReachedStep;
        const isComplete = isReached && def.n < currentStep && validity[def.n];
        const isClickable = isReached;

        return (
          <div key={def.n} className="flex items-center gap-2 flex-1 min-w-0">
            <button
              onClick={() => isClickable && onStepClick(def.n)}
              disabled={!isClickable}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors w-full text-left
                ${isCurrent
                  ? 'bg-blue-600 text-white'
                  : isClickable
                    ? 'bg-slate-700/40 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-800/40 text-slate-500 cursor-not-allowed'}`}
              title={
                isClickable
                  ? def.subtitle
                  : 'Complete the previous step to unlock'
              }
            >
              <span
                className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
                  ${isCurrent
                    ? 'bg-white text-blue-700'
                    : isComplete
                      ? 'bg-emerald-500 text-white'
                      : isClickable
                        ? 'bg-slate-600 text-slate-200'
                        : 'bg-slate-700 text-slate-500'}`}
              >
                {isComplete ? (
                  <svg viewBox="0 0 12 12" fill="currentColor" className="w-3 h-3">
                    <path d="M2 6.5l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                ) : (
                  def.n
                )}
              </span>
              <span className="min-w-0 flex flex-col leading-tight">
                <span className="text-sm font-semibold truncate">{def.label}</span>
                <span className={`text-[11px] truncate ${isCurrent ? 'text-blue-100' : 'text-slate-500'}`}>
                  {def.subtitle}
                </span>
              </span>
            </button>

            {idx < stepDefs.length - 1 && (
              <span className="shrink-0 text-slate-600 select-none">›</span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

interface StepNavProps {
  currentStep: number;
  canAdvance: boolean;
  nextLabel?: string;
  onBack?: () => void;
  onNext?: () => void;
  /** Highest step number in the flow. Defaults to 4 (expert). */
  totalSteps?: number;
}

/**
 * Bottom-of-step Back/Next pair. Each step renders this at the end of its
 * content area; `canAdvance` reflects step-specific validity.
 */
export function StepNav({ currentStep, canAdvance, nextLabel, onBack, onNext, totalSteps }: StepNavProps) {
  const isFirst = currentStep === 1;
  const isLast  = currentStep === (totalSteps ?? 4);

  return (
    <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-slate-700">
      <button
        onClick={onBack}
        disabled={isFirst}
        className="px-4 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ← Back
      </button>

      {!isLast && (
        <button
          onClick={onNext}
          disabled={!canAdvance}
          className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors text-white
            ${canAdvance
              ? 'bg-blue-600 hover:bg-blue-500'
              : 'bg-slate-700 text-slate-500 cursor-not-allowed'}`}
        >
          {nextLabel ?? 'Next →'}
        </button>
      )}
    </div>
  );
}
