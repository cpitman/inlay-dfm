'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisResult } from '@/types';
import type { BoardConfig } from '@/types/board';
import type { QuoteResult } from '@/lib/pricing';
import {
  ADDON_FEET,
  MACHINE_HOURLY,
  MACHINE_MIN_INSET_HANDLES,
  MACHINE_MIN_PER_GROOVE_SIDE,
  MACHINE_MIN_UNDERSIDE_HANDLES,
} from '@/lib/pricing';
import { renderBoardWithFeatures } from '@/lib/boardFeatures';
import { OVERLAY_COLORS, renderIrreducibleProblemOverlay, renderWiderBitOverlay, rgbaCss } from '@/lib/widerBitOverlay';
import { findMaskComponentCentroids } from '@/lib/maskComponents';
import { clearanceBitLabel } from '@/lib/machiningTime';
import type { DesignOptimizationResult, MultiDesignOptimizationResult } from '@/lib/quoteOptimizer';
import HoverMagnifier from '../HoverMagnifier';
import IssueLocatorBadges, { type IssueVariant } from '../IssueLocatorBadges';
import { StepNav } from '../StepperBar';

interface Step3QuoteDisplayProps {
  boardConfig: BoardConfig;
  optimization: MultiDesignOptimizationResult;
  quote: QuoteResult;
  /** Per-design composite PNG dataURL, keyed by design id. */
  compositeUrls: Map<string, string>;
  onBack: () => void;
  onRequestManufacturing: () => void;
}

/**
 * Final step of the guided quote experience. Headline is the price
 * range; below it the multi-design composite preview with per-design
 * overlays + locator badges; alongside, a tips list.
 *
 * The "no feasible angle" flag is the union across designs (any one
 * design with no feasible v-bit makes the whole quote approximate);
 * each design renders its own overlay flavor independently — so a
 * board with one infeasible and one suggestion-only design shows red
 * splashes on the first and teal on the second.
 */
export default function Step3QuoteDisplay({
  boardConfig, optimization, quote, compositeUrls,
  onBack, onRequestManufacturing,
}: Step3QuoteDisplayProps) {
  const { perDesign, aggregated } = optimization;
  const noFeasibleAngle = aggregated.noFeasibleAngle;

  // Render the board PNG and fit-to-container.
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boardPx, setBoardPx] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useEffect(() => {
    let cancelled = false;
    renderBoardWithFeatures(boardConfig).then(url => {
      if (!cancelled) setBoardUrl(url);
    });
    return () => { cancelled = true; };
  }, [boardConfig]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const a = boardConfig.heightInches / boardConfig.widthInches;
    const update = () => {
      const r = wrap.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const widthFromHeight = r.height / a;
      const heightFromWidth = r.width  * a;
      const fitW = widthFromHeight  <= r.width  ? widthFromHeight  : r.width;
      const fitH = widthFromHeight  <= r.width  ? r.height         : heightFromWidth;
      setBoardPx({ width: fitW, height: fitH });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [boardConfig.widthInches, boardConfig.heightInches]);

  const pctX = (inches: number) => `${(inches / boardConfig.widthInches)  * 100}%`;
  const pctY = (inches: number) => `${(inches / boardConfig.heightInches) * 100}%`;

  // Tips against the aggregated inputs.
  const widestSuggestion = perDesign.reduce<number | null>((m, d) => {
    const a = d.result.step2SuggestionAngleDegrees;
    if (a === null) return m;
    return m === null ? a : Math.max(m, a);
  }, null);

  const tips = buildTips({
    boardConfig,
    uniqueSpeciesCount: aggregated.uniqueSpeciesCount,
    noFeasibleAngle,
    suggestionAngleDegrees: widestSuggestion,
  });

  // Track whether ANY design has pocket / plug issues for the legend.
  const hasAnyPocketIssue = perDesign.some(d => hasIssuesOn(d, noFeasibleAngle, 'pocket'));
  const hasAnyPlugIssue   = perDesign.some(d => hasIssuesOn(d, noFeasibleAngle, 'plug'));

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Headline price */}
      <section
        aria-live="polite"
        className={`rounded-xl border-2 p-5 mb-4 shrink-0
          ${noFeasibleAngle
            ? 'bg-red-900/40 border-red-700'
            : 'bg-emerald-900/40 border-emerald-700'}`}
      >
        <div className="flex items-baseline gap-3 flex-wrap">
          <p className={`text-sm font-semibold uppercase tracking-wider
            ${noFeasibleAngle ? 'text-red-300' : 'text-emerald-300'}`}>
            {noFeasibleAngle ? 'Estimate (rough)' : 'Estimated price'}
          </p>
          <p className="text-3xl font-bold text-white">
            <span className="sr-only">Range: </span>
            ${quote.lowDollars.toLocaleString()}
            <span className="text-emerald-200 mx-2" aria-hidden="true">–</span>
            <span className="sr-only">to </span>
            ${quote.highDollars.toLocaleString()}
          </p>
        </div>
        {noFeasibleAngle && (
          <p className="text-sm text-red-100 mt-2">
            Some details in your design{perDesign.length > 1 ? 's' : ''} are too narrow for any standard v-bit. The price above is approximate; widening the highlighted regions below would give a more reliable quote.
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-6 flex-1 min-h-0">
        {/* Composite preview + legend */}
        <div className="min-h-0 flex flex-col gap-2">
          <div ref={wrapRef} className="min-h-0 flex-1 flex items-center justify-center bg-slate-950 rounded-lg">
            {boardUrl && (
              <HoverMagnifier zoom={3} lensSize={180}>
                <div
                  className="relative shadow-xl"
                  style={{ width: boardPx.width, height: boardPx.height }}
                >
                  <img
                    src={boardUrl}
                    alt={`${boardConfig.wood} board preview`}
                    className="absolute inset-0 w-full h-full object-cover rounded select-none pointer-events-none"
                    draggable={false}
                  />
                  {perDesign.map(d => (
                    <DesignOverlay
                      key={d.designId}
                      design={d}
                      compositeUrl={compositeUrls.get(d.designId)}
                      noFeasibleAngle={noFeasibleAngle}
                      pctX={pctX}
                      pctY={pctY}
                    />
                  ))}
                </div>
              </HoverMagnifier>
            )}
          </div>
          <OverlayLegend
            noFeasibleAngle={noFeasibleAngle}
            hasPocketIssues={hasAnyPocketIssue}
            hasPlugIssues={hasAnyPlugIssue}
          />
        </div>

        {/* Tips + actions column */}
        <div className="space-y-4 overflow-y-auto pr-1 min-h-0">
          <ToolingSummary perDesign={perDesign} />

          {tips.length > 0 && (
            <section className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-3">
              <p className="text-sm font-semibold text-slate-200">Cost-reduction tips</p>
              <ul className="space-y-2">
                {tips.map((t, i) => (
                  <li key={i} className="text-xs text-slate-300">
                    <span className="text-slate-100 font-medium">{t.title}</span>
                    {t.body && <p className="text-slate-400 mt-0.5">{t.body}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="bg-slate-800 border border-slate-700 rounded-lg p-4">
            <button
              onClick={onRequestManufacturing}
              className="w-full px-4 py-3 rounded-md text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              Request manufacturing →
            </button>
            <p className="text-xs text-slate-500 mt-2 text-center">
              We'll email back with confirmation and next steps.
            </p>
          </section>
        </div>
      </div>

      <StepNav
        currentStep={3}
        canAdvance={false}
        totalSteps={3}
        onBack={onBack}
      />
    </div>
  );
}

/** True iff this design has any pocket-side OR plug-side issues for the
 *  current overlay flavor (irreducible vs wider-bit-suggestion). */
function hasIssuesOn(d: DesignOptimizationResult, noFeasible: boolean, side: 'pocket' | 'plug'): boolean {
  const woods = d.result.woods;
  const pick = noFeasible
    ? (w: AnalysisResult['woods'][number]) => w.irreducibleProblemMask
    : (w: AnalysisResult['woods'][number]) => w.widerBitInfeasibleMask;
  for (const w of woods) {
    const m = pick(w);
    if (!m) continue;
    const arr = side === 'pocket' ? m.pocket : m.plug;
    for (let i = 0; i < arr.length; i++) if (arr[i]) return true;
  }
  return false;
}

/**
 * Renders one design's composite PNG + overlay PNG + locator badges
 * at its placement on the board. Each design gets its own overlay
 * (and its own canvas dimensions, since each is analyzed at the design's
 * own physical size).
 */
function DesignOverlay({
  design, compositeUrl, noFeasibleAngle, pctX, pctY,
}: {
  design: DesignOptimizationResult;
  compositeUrl: string | undefined;
  noFeasibleAngle: boolean;
  pctX: (inches: number) => string;
  pctY: (inches: number) => string;
}) {
  const aspect = design.vector.naturalHeight / design.vector.naturalWidth;
  const placement = design.placement;
  const designH = placement.designWidthInches * aspect;
  const canvasW = design.result.canvasW;
  const canvasH = design.result.canvasH;

  // The renderer per-design — pick irreducible (red/yellow) or wider-bit (teal/cyan).
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const render = noFeasibleAngle ? renderIrreducibleProblemOverlay : renderWiderBitOverlay;
    render(design.result, canvasW, canvasH).then(url => {
      if (!cancelled) setOverlayUrl(url);
    }).catch(() => {
      if (cancelled) return;
      setOverlayUrl(null);
    });
    return () => { cancelled = true; };
  }, [design.result, canvasW, canvasH, noFeasibleAngle]);

  const overlayComponents = useMemo(() => {
    const pick = noFeasibleAngle
      ? (w: AnalysisResult['woods'][number]) => w.irreducibleProblemMask
      : (w: AnalysisResult['woods'][number]) => w.widerBitInfeasibleMask;
    const pocketUnion = new Uint8Array(canvasW * canvasH);
    const plugUnion   = new Uint8Array(canvasW * canvasH);
    let anyPocket = false, anyPlug = false;
    for (const wood of design.result.woods) {
      const m = pick(wood);
      if (!m) continue;
      if (m.pocket.length === canvasW * canvasH) {
        for (let k = 0; k < pocketUnion.length; k++) if (m.pocket[k]) { pocketUnion[k] = 1; anyPocket = true; }
      }
      if (m.plug.length === canvasW * canvasH) {
        for (let k = 0; k < plugUnion.length; k++) if (m.plug[k]) { plugUnion[k] = 1; anyPlug = true; }
      }
    }
    const pocketVariant: IssueVariant = noFeasibleAngle ? 'pocketIrreducible' : 'pocketSuggestion';
    const plugVariant:   IssueVariant = noFeasibleAngle ? 'plugIrreducible'   : 'plugSuggestion';
    const pocketCentroids = anyPocket ? findMaskComponentCentroids(pocketUnion, canvasW, canvasH) : [];
    const plugCentroids   = anyPlug   ? findMaskComponentCentroids(plugUnion,   canvasW, canvasH) : [];
    return [
      ...pocketCentroids.map(c => ({ ...c, variant: pocketVariant })),
      ...plugCentroids  .map(c => ({ ...c, variant: plugVariant   })),
    ];
  }, [design.result, canvasW, canvasH, noFeasibleAngle]);

  if (!compositeUrl) return null;
  return (
    <div
      className="absolute"
      style={{
        left:   pctX(placement.offsetXInches),
        top:    pctY(placement.offsetYInches),
        width:  pctX(placement.designWidthInches),
        height: pctY(designH),
      }}
    >
      <img
        src={compositeUrl}
        alt={`Design ${design.vector.fileName}`}
        className="absolute inset-0 w-full h-full select-none pointer-events-none"
        draggable={false}
      />
      {overlayUrl && (
        <img
          src={overlayUrl}
          alt={noFeasibleAngle ? 'Unmanufacturable regions' : 'Suggested widening regions'}
          className="absolute inset-0 w-full h-full select-none pointer-events-none"
          draggable={false}
        />
      )}
      {overlayComponents.length > 0 && (
        <IssueLocatorBadges
          components={overlayComponents}
          sourceWidth={canvasW}
          sourceHeight={canvasH}
        />
      )}
    </div>
  );
}

/** Tooling summary across all designs — union of clearance + v-bit angles. */
function ToolingSummary({ perDesign }: { perDesign: DesignOptimizationResult[] }) {
  const clearance = new Set<number>();
  const vbits = new Set<number>();
  for (const d of perDesign) {
    if (!d.bitPlan) continue;
    for (const x of d.bitPlan.strategyDiameters) clearance.add(x);
    for (const a of d.bitPlan.perLayerVbitAngles) vbits.add(a);
  }
  if (clearance.size === 0 && vbits.size === 0) return null;
  const clearanceLabel = clearance.size === 0
    ? 'V-bit only (no clearance pass)'
    : `${[...clearance].sort((a, b) => b - a).map(clearanceBitLabel).join(' + ')} clearance`;
  const vbitLabel = [...vbits].sort((a, b) => a - b).map(a => `${a}°`).join(' + ');

  return (
    <section className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-2">
      <p className="text-sm font-semibold text-slate-200">Tooling</p>
      <p className="text-xs text-slate-400">{clearanceLabel}</p>
      {vbitLabel && (
        <p className="text-xs text-slate-400">V-bits: <span className="font-medium text-slate-300">{vbitLabel}</span></p>
      )}
      {perDesign.length > 1 && (
        <p className="text-[11px] text-slate-500 pt-1">
          Bits are loaded once and shared across designs — counted in the time estimate.
        </p>
      )}
    </section>
  );
}

/**
 * One-line caption under the composite preview, naming the colors
 * that are actually showing on any overlay. Skipped when nothing is
 * highlighted.
 */
function OverlayLegend({
  noFeasibleAngle, hasPocketIssues, hasPlugIssues,
}: {
  noFeasibleAngle: boolean;
  hasPocketIssues: boolean;
  hasPlugIssues:   boolean;
}) {
  if (!hasPocketIssues && !hasPlugIssues) return null;
  const pocketColor = noFeasibleAngle ? OVERLAY_COLORS.pocketRed : OVERLAY_COLORS.pocketTeal;
  const plugColor   = noFeasibleAngle ? OVERLAY_COLORS.plugYellow : OVERLAY_COLORS.plugCyan;
  const pocketLabel = noFeasibleAngle
    ? 'Feature too narrow for any v-bit'
    : 'Widen for a faster v-bit';
  const plugLabel = noFeasibleAngle
    ? 'Gap between inlays too narrow'
    : 'Widening this gap enables a faster v-bit';
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400 px-1 shrink-0">
      {hasPocketIssues && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: rgbaCss(pocketColor) }} aria-hidden="true" />
          {pocketLabel}
        </span>
      )}
      {hasPlugIssues && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: rgbaCss(plugColor) }} aria-hidden="true" />
          {plugLabel}
        </span>
      )}
    </div>
  );
}

interface Tip { title: string; body?: string }

function buildTips(input: {
  boardConfig: BoardConfig;
  uniqueSpeciesCount: number;
  noFeasibleAngle: boolean;
  suggestionAngleDegrees: number | null;
}): Tip[] {
  const { boardConfig, uniqueSpeciesCount, noFeasibleAngle, suggestionAngleDegrees } = input;
  const tips: Tip[] = [];

  if (noFeasibleAngle) {
    tips.push({
      title: 'Widen the red regions',
      body: 'Some details are too narrow for any v-bit. Enlarge them in your art before requesting manufacturing for a reliable quote.',
    });
  } else if (suggestionAngleDegrees !== null) {
    tips.push({
      title: `Make the teal regions larger`,
      body: `Widening these spots could enable a ${suggestionAngleDegrees}° v-bit, cutting machining time and cost noticeably.`,
    });
  }

  if (uniqueSpeciesCount > 1) {
    tips.push({
      title: 'Use fewer inlay species',
      body: `Each species adds material cost and ~30 min of setup. Going from ${uniqueSpeciesCount} species to 1 could save $${perInlayApproxSavings(uniqueSpeciesCount)}+.`,
    });
  }

  if (boardConfig.juiceGroove !== 'none') {
    const sides = boardConfig.juiceGroove === 'both' ? 2 : 1;
    const min = sides * MACHINE_MIN_PER_GROOVE_SIDE;
    tips.push({
      title: 'Skip the juice groove',
      body: `~$${Math.round(min / 60 * MACHINE_HOURLY)} of machine time at ${sides} side${sides === 1 ? '' : 's'}.`,
    });
  }

  if (boardConfig.handles !== 'none') {
    const min = boardConfig.handles === 'inset' ? MACHINE_MIN_INSET_HANDLES : MACHINE_MIN_UNDERSIDE_HANDLES;
    tips.push({
      title: 'Skip handles',
      body: `${boardConfig.handles === 'inset' ? 'Side-recessed handles' : 'Underside pockets'} add ~$${Math.round(min / 60 * MACHINE_HOURLY)} of machine time.`,
    });
  }

  if (boardConfig.sided === 'feet') {
    tips.push({
      title: 'Skip rubber feet',
      body: `Saves $${ADDON_FEET}.`,
    });
  }

  return tips;
}

/** Rough per-species savings to surface in the "fewer species" tip. */
function perInlayApproxSavings(currentCount: number): number {
  // Assumes ~$30 of inlay-stock + ~30 min of machine + 30 min of labor
  // per species we drop. (Conservative; real savings depend on which
  // species is dropped.) Round to $10.
  const perInlayDollars = 30 + (30/60) * MACHINE_HOURLY + (30/60) * 40;
  return Math.round(((currentCount - 1) * perInlayDollars) / 10) * 10;
}
