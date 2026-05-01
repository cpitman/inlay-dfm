'use client';

import type { AnalysisResult, SingleAnalysis, DFMSettings } from '@/types';
import { isSideGrain } from '@/lib/grain';

interface ResultsPanelProps {
  analysis: SingleAnalysis;
  common: Pick<AnalysisResult, 'thinWallThresholdInches'>;
  settings: DFMSettings;
  label: 'Pocket' | 'Plug';
  /**
   * When true, hide the v-bit-angle-dependent depth-check pass/fail header
   * and the per-piece stat grid. Step 2 sets this because the user hasn't
   * picked a v-bit yet — depth-check at an arbitrary default would be
   * misleading. Thin-wall and grain warnings still show (angle-independent).
   */
  hideDepthCheck?: boolean;
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-slate-800 rounded-lg p-2.5">
      <p className="text-xs text-slate-400 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-base font-semibold ${warn ? 'text-red-300' : 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-2.5 flex gap-2 items-start">
      <span className="text-amber-400 shrink-0">⚠</span>
      <p className="text-xs text-amber-200">{children}</p>
    </div>
  );
}

export default function ResultsPanel({ analysis, common, settings, label, hideDepthCheck }: ResultsPanelProps) {
  const {
    fullDepthPercent, problemAreaPercent, passed, hasAnyFullDepth,
    hasIsolatedUnreachableComponent,
    vbitAngleWarning, thinWallPixelCount,
  } = analysis;
  const { thinWallThresholdInches } = common;
  const sideGrain = isSideGrain(settings.grainDirection);
  const isPocket = label === 'Pocket';

  const depthDesc = isPocket
    ? "pocket floor doesn't reach full depth"
    : "background cut doesn't reach full depth in all gaps";
  const thinDesc = isPocket
    ? `Un-carved walls <${thinWallThresholdInches}" opposing the grain`
    : `Raised plug features <${thinWallThresholdInches}" opposing the grain`;

  return (
    <div className="space-y-3">
      {/* Pass / Fail — angle-dependent, hidden on Step 2 */}
      {!hideDepthCheck && (
        <div className={`rounded-lg p-3 flex items-start gap-2.5
          ${passed ? 'bg-green-900/40 border border-green-700' : 'bg-red-900/40 border border-red-700'}`}>
          <span className="text-xl shrink-0 leading-tight">{passed ? '✓' : '✗'}</span>
          <div>
            <p className={`text-sm font-semibold ${passed ? 'text-green-300' : 'text-red-300'}`}>
              {passed ? 'Depth check passed' : 'Depth check failed'}
            </p>
            <p className="text-xs text-slate-300 mt-0.5">
              {!hasAnyFullDepth
                ? 'No area reaches full inlay depth.'
                : hasIsolatedUnreachableComponent
                ? `An isolated piece of the ${isPocket ? 'design' : 'background'} cannot reach full depth at all — too narrow for this V-bit.`
                : passed
                ? 'All not-full-depth zones are within tolerance of a full-depth region.'
                : `${problemAreaPercent.toFixed(2)}% of ${isPocket ? 'design' : 'background'} area: ${depthDesc}.`}
            </p>
          </div>
        </div>
      )}

      {/* Grain warnings — angle-independent */}
      {vbitAngleWarning && !hideDepthCheck && (
        <Warning>
          <strong>V-bit &lt;60° with {settings.grainDirection} grain.</strong>{' '}
          Steeper walls increase tearout risk across fibres.
        </Warning>
      )}
      {sideGrain && thinWallPixelCount > 0 && (
        <Warning>
          <strong>{thinDesc} detected</strong> (amber on overlay).
          These features are at risk of splitting or cracking.
        </Warning>
      )}

      {/* Per-piece stats — angle-dependent, hidden on Step 2 */}
      {!hideDepthCheck && (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Full-Depth Area"
            value={`${fullDepthPercent.toFixed(1)}%`}
            sub={`Of ${isPocket ? 'carved' : 'background'} area at full depth`}
            warn={!hasAnyFullDepth}
          />
          <Stat
            label="Problem Area"
            value={`${problemAreaPercent.toFixed(2)}%`}
            sub="Not-full-depth & beyond threshold from any full-depth zone"
            warn={problemAreaPercent >= 0.1}
          />
        </div>
      )}
    </div>
  );
}
