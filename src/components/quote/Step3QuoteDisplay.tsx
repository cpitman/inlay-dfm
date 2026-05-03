'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisResult, VectorData, WoodConfig } from '@/types';
import type { BoardConfig } from '@/types/board';
import type { QuoteResult } from '@/lib/pricing';
import type { PerLayerBitPlan } from '@/lib/machiningTime';
import { clearanceBitLabel } from '@/lib/machiningTime';
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
import HoverMagnifier from '../HoverMagnifier';
import IssueLocatorBadges, { type IssueVariant } from '../IssueLocatorBadges';
import { StepNav } from '../StepperBar';
import type { Placement } from './Step2ArtPlacement';

interface Step3QuoteDisplayProps {
  boardConfig: BoardConfig;
  vector: VectorData;
  woodConfigs: WoodConfig[];
  result: AnalysisResult;
  quote: QuoteResult;
  /** Per-layer bit plan from the optimizer. Drives the tooling summary. */
  bitPlan: PerLayerBitPlan | null;
  /** True when the optimizer found NO feasible v-bit at any preset. */
  noFeasibleAngle: boolean;
  designCompositeUrl: string | null;
  placement: Placement;
  onBack: () => void;
  onRequestManufacturing: () => void;
}

/**
 * Final step of the guided quote experience. Headline is the price
 * range; below it the composite preview with an optional teal overlay
 * highlighting "make these larger" regions; alongside, a tips list.
 *
 * When `noFeasibleAngle` is true the wider-bit overlay is replaced by
 * the smallest-preset's irreducible-problem signal (still rendered by
 * `renderWiderBitOverlay`'s data — but framed as "these features are
 * unmanufacturable as-is").
 */
export default function Step3QuoteDisplay({
  boardConfig, vector, woodConfigs, result, quote, bitPlan, noFeasibleAngle,
  designCompositeUrl, placement,
  onBack, onRequestManufacturing,
}: Step3QuoteDisplayProps) {
  const aspect = vector.naturalHeight / vector.naturalWidth;
  // Mask coordinates exposed by the analysis. Scales with the design's
  // physical size in the guided pipeline (240 ppi); the overlay
  // renderer + badge math need these to match the masks exactly.
  const canvasW = result.canvasW;
  const canvasH = result.canvasH;

  // Render the highlight overlay PNG that sits over the design composite.
  // Two flavors:
  //   - Feasible design with a wider-bit upgrade path → teal "widen these
  //     to enable a faster bit" hints (renderWiderBitOverlay).
  //   - No-feasible-angle design → red "these regions can't be carved by
  //     any preset, widen or remove them" (renderIrreducibleProblemOverlay).
  // The renderer is selected by `noFeasibleAngle`; the unused field on
  // each WoodAnalysis is null and would otherwise produce a blank PNG.
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const render = noFeasibleAngle
      ? renderIrreducibleProblemOverlay
      : renderWiderBitOverlay;
    render(result, canvasW, canvasH).then(url => {
      if (!cancelled) setOverlayUrl(url);
    }).catch(() => {
      if (cancelled) return;
      setOverlayUrl(null);
    });
    return () => { cancelled = true; };
  }, [result, canvasW, canvasH, noFeasibleAngle]);

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
  const designHeight = placement.designWidthInches * aspect;

  // Centroids of every flagged region across all woods, tagged with
  // pocket vs plug so the badges can color-code "feature too narrow"
  // (red) vs "gap between inlays too narrow" (yellow). Source switches
  // with the overlay flavor: irreducible problem regions when no v-bit
  // can carve the design, otherwise wider-bit upgrade hints (teal/cyan).
  const { overlayComponents, hasPocketIssues, hasPlugIssues } = useMemo(() => {
    const pick = noFeasibleAngle
      ? (w: AnalysisResult['woods'][number]) => w.irreducibleProblemMask
      : (w: AnalysisResult['woods'][number]) => w.widerBitInfeasibleMask;
    const pocketUnion = new Uint8Array(canvasW * canvasH);
    const plugUnion   = new Uint8Array(canvasW * canvasH);
    let anyPocket = false, anyPlug = false;
    for (const wood of result.woods) {
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
    const tagged = [
      ...pocketCentroids.map(c => ({ ...c, variant: pocketVariant })),
      ...plugCentroids  .map(c => ({ ...c, variant: plugVariant   })),
    ];
    return { overlayComponents: tagged, hasPocketIssues: anyPocket, hasPlugIssues: anyPlug };
  }, [result, canvasW, canvasH, noFeasibleAngle]);

  // Build tips list. Only show items that genuinely apply.
  const tips = buildTips({ boardConfig, woodConfigs, noFeasibleAngle, suggestionAngleDegrees: result.step2SuggestionAngleDegrees });

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
            Some details in your design are too narrow for any standard v-bit. The price above is approximate; widening the highlighted regions below would give a more reliable quote.
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
                {designCompositeUrl && (
                  <div
                    className="absolute"
                    style={{
                      left:   pctX(placement.offsetXInches),
                      top:    pctY(placement.offsetYInches),
                      width:  pctX(placement.designWidthInches),
                      height: pctY(designHeight),
                    }}
                  >
                    <img
                      src={designCompositeUrl}
                      alt="Design"
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
                )}
              </div>
            </HoverMagnifier>
          )}
        </div>
          <OverlayLegend
            noFeasibleAngle={noFeasibleAngle}
            hasPocketIssues={hasPocketIssues}
            hasPlugIssues={hasPlugIssues}
          />
        </div>

        {/* Tips + actions column */}
        <div className="space-y-4 overflow-y-auto pr-1 min-h-0">
          {bitPlan && (
            <ToolingSummary bitPlan={bitPlan} woodConfigs={woodConfigs} />
          )}

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

/**
 * One-line caption under the composite preview, naming the colors
 * that are actually showing on the overlay. Skipped when nothing is
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

function ToolingSummary({ bitPlan, woodConfigs }: { bitPlan: PerLayerBitPlan; woodConfigs: WoodConfig[] }) {
  // Group layers by chosen v-bit angle so the summary reads e.g.
  // "60° v-bit: Cherry · Walnut" + "30° v-bit: Padauk".
  const byAngle = new Map<number, string[]>();
  for (let i = 0; i < bitPlan.perLayerVbitAngles.length; i++) {
    const angle = bitPlan.perLayerVbitAngles[i];
    const wc = woodConfigs[i];
    if (!byAngle.has(angle)) byAngle.set(angle, []);
    byAngle.get(angle)!.push(wc?.label ?? `Layer ${i + 1}`);
  }
  // Sort angles ascending so the summary reads sharpest-first.
  const entries = [...byAngle.entries()].sort((a, b) => a[0] - b[0]);

  const clearanceLabel = bitPlan.strategyDiameters.length === 0
    ? 'V-bit only (no clearance pass)'
    : `${bitPlan.strategyDiameters.map(clearanceBitLabel).join(' → ')} clearance`;

  return (
    <section className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-2">
      <p className="text-sm font-semibold text-slate-200">Tooling</p>
      <p className="text-xs text-slate-400">{clearanceLabel}</p>
      <ul className="space-y-1.5">
        {entries.map(([angle, labels]) => (
          <li key={angle} className="text-xs">
            <span className="font-medium text-slate-200">{angle}° v-bit</span>
            <span className="text-slate-500"> · {labels.join(', ')}</span>
          </li>
        ))}
      </ul>
      {entries.length > 1 && (
        <p className="text-[11px] text-slate-500 pt-1">
          Using a different v-bit per layer saves machining time vs. forcing every layer to the sharpest angle.
        </p>
      )}
    </section>
  );
}

interface Tip { title: string; body?: string }

function buildTips(input: {
  boardConfig: BoardConfig;
  woodConfigs: WoodConfig[];
  noFeasibleAngle: boolean;
  suggestionAngleDegrees: number | null;
}): Tip[] {
  const { boardConfig, woodConfigs, noFeasibleAngle, suggestionAngleDegrees } = input;
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

  if (woodConfigs.length > 1) {
    tips.push({
      title: 'Use fewer inlay colors',
      body: `Each color adds material cost and ~30 min of setup. Going from ${woodConfigs.length} colors to 1 could save $${perInlayApproxSavings(woodConfigs.length)}+.`,
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

/** Rough per-inlay savings to surface in the "fewer colors" tip. */
function perInlayApproxSavings(currentCount: number): number {
  // Assumes ~$30 of inlay-stock + ~30 min of machine + 30 min of labor
  // per inlay we drop. (Conservative; real savings depend on which color
  // is dropped.) Round to $10.
  const perInlayDollars = 30 + (30/60) * MACHINE_HOURLY + (30/60) * 40;
  return Math.round(((currentCount - 1) * perInlayDollars) / 10) * 10;
}
