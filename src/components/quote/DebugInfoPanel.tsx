'use client';

import { useState } from 'react';
import type { Design, Layer } from '@/types';
import type { BoardConfig } from '@/types/board';
import {
  ADDON_FEET, BASE_BOARD_PRICE, INLAY_PACKING_THRESHOLD, INLAY_SHEET_AREA_SQ_IN,
  INLAY_WOOD_PRICE, LABOR_HOURLY, LABOR_MIN_FINISHING, LABOR_MIN_PER_INLAY,
  LABOR_MIN_SETUP, MACHINE_HOURLY, MACHINE_MIN_INSET_HANDLES,
  MACHINE_MIN_PER_GROOVE_SIDE, MACHINE_MIN_PER_INLAY,
  MACHINE_MIN_UNDERSIDE_HANDLES,
  type QuoteResult,
} from '@/lib/pricing';
import { layerToStandaloneSvg } from '@/lib/svgLayers';
import { CODE_VERSION, CODE_VERSION_NOTE } from '@/lib/codeVersion';
import type { DesignOptimizationResult, MultiDesignOptimizationResult } from '@/lib/quoteOptimizer';

interface DebugInfoPanelProps {
  boardConfig: BoardConfig;
  /** Original input designs — used to compare pre-optimization vs post-optimization layer geometry. */
  designs: Design[];
  optimization: MultiDesignOptimizationResult;
  quote: QuoteResult;
}

/**
 * Dev-only debug panel for the guided /quote flow. Surfaces the
 * underlying carving stats (mirrors the expert flow's per-layer
 * detail) and the pricing computation breakdown so we can verify
 * what the optimizer is producing without leaving the guided UI.
 *
 * Tree-shaken in production: `process.env.NODE_ENV` is statically
 * inlined by Next.js at build time, so the early-return strips the
 * entire body and helpers from production bundles.
 */
export default function DebugInfoPanel({ boardConfig, designs, optimization, quote }: DebugInfoPanelProps) {
  if (process.env.NODE_ENV !== 'development') return null;

  return (
    <details className="bg-slate-900 border border-amber-700/40 rounded-lg p-3 text-xs">
      <summary className="text-sm font-semibold text-amber-300 cursor-pointer select-none">
        🔧 Debug info (dev only)
      </summary>

      <div className="mt-3 space-y-3 font-mono text-[11px]">
        <div className="flex flex-wrap gap-2">
          <CopyJsonButton boardConfig={boardConfig} optimization={optimization} quote={quote} />
          <DownloadZipButton boardConfig={boardConfig} designs={designs} optimization={optimization} quote={quote} />
        </div>
        <DesignsSection optimization={optimization} />
        <CarvingSection optimization={optimization} />
        <PricingSection boardConfig={boardConfig} optimization={optimization} quote={quote} />
        <SettingsSection optimization={optimization} />
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function CopyJsonButton({ boardConfig, optimization, quote }: Omit<DebugInfoPanelProps, 'designs'>) {
  const handleCopy = async () => {
    // Strip typed-array masks (~50KB each, don't survive JSON round-trip)
    // and Maps (need serialization). Replace with summarized placeholders.
    const replacer = (_key: string, value: unknown): unknown => {
      if (value instanceof Uint8Array) return `<Uint8Array len=${value.length}>`;
      if (value instanceof Map) return Object.fromEntries(value);
      // Drop overlay PNG dataURLs — they're megabytes each.
      if (typeof value === 'string' && value.startsWith('data:image/')) {
        return `<dataURL bytes=${value.length}>`;
      }
      return value;
    };
    const blob = JSON.stringify({ boardConfig, optimization, quote }, replacer, 2);
    try {
      await navigator.clipboard.writeText(blob);
    } catch {
      // Older browsers fall back to a textarea + execCommand path. Skip
      // for the dev panel — the user can manually copy from devtools.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="px-3 py-1.5 rounded text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
    >
      Copy debug JSON
    </button>
  );
}

function DesignsSection({ optimization }: { optimization: MultiDesignOptimizationResult }) {
  return (
    <Section label="Designs">
      {optimization.perDesign.map(d => (
        <details key={d.designId} className="ml-2 mt-1">
          <summary className="cursor-pointer text-slate-200">
            {d.vector.fileName} · {d.side} · {d.vector.layers.length} layer{d.vector.layers.length === 1 ? '' : 's'}
          </summary>
          <KvTable
            rows={[
              ['id', d.designId],
              ['side', d.side],
              ['file', `${d.vector.fileName} (${d.vector.fileType})`],
              ['natural', `${d.vector.naturalWidth.toFixed(2)} × ${d.vector.naturalHeight.toFixed(2)}`],
              ['detected colors', d.vector.detectedColors.join(' · ')],
              ['placement (in)', `x=${d.placement.offsetXInches.toFixed(2)}, y=${d.placement.offsetYInches.toFixed(2)}, w=${d.placement.designWidthInches.toFixed(2)}${d.placement.rotationDegrees ? `, rot=${d.placement.rotationDegrees}°` : ''}`],
              ['applied fill?', d.appliedFill ? 'yes' : 'no'],
              ['bit plan', d.bitPlan
                ? `strategy=[${d.bitPlan.strategyDiameters.join(', ')}], cutting=${d.bitPlan.cuttingTimeMinutes.toFixed(1)}m + tc=${d.bitPlan.toolChangeOverheadMinutes.toFixed(1)}m = ${d.bitPlan.totalTimeMinutes.toFixed(1)}m`
                : 'NONE (no feasible angle)'],
              ['woods', d.woodConfigs.map(w => `${w.colorHex}→${w.species}`).join(', ')],
            ]}
          />
        </details>
      ))}
    </Section>
  );
}

function CarvingSection({ optimization }: { optimization: MultiDesignOptimizationResult }) {
  return (
    <Section label="Carving (per-design per-layer)">
      {optimization.perDesign.map(d => (
        <PerDesignCarving key={d.designId} design={d} />
      ))}
    </Section>
  );
}

function PerDesignCarving({ design }: { design: DesignOptimizationResult }) {
  const { result, woodConfigs, bitPlan } = design;
  return (
    <details className="ml-2 mt-1" open>
      <summary className="cursor-pointer text-slate-200">
        {design.vector.fileName} ({design.side})
      </summary>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead className="text-slate-400">
            <tr>
              <th className="pr-2 py-0.5">color</th>
              <th className="pr-2 py-0.5">species</th>
              <th className="pr-2 py-0.5">v-bit°</th>
              <th className="pr-2 py-0.5">pocket pass?</th>
              <th className="pr-2 py-0.5">pocket fd%</th>
              <th className="pr-2 py-0.5">pocket prob%</th>
              <th className="pr-2 py-0.5">pocket iso?</th>
              <th className="pr-2 py-0.5">plug pass?</th>
              <th className="pr-2 py-0.5">plug fd%</th>
              <th className="pr-2 py-0.5">plug prob%</th>
              <th className="pr-2 py-0.5">plug iso?</th>
              <th className="pr-2 py-0.5">align#</th>
              <th className="pr-2 py-0.5">filled holes</th>
              <th className="pr-2 py-0.5">layer min</th>
            </tr>
          </thead>
          <tbody>
            {result.woods.map((w, i) => {
              const wc = woodConfigs.find(c => c.colorHex === w.colorHex);
              const angle = bitPlan?.perLayerVbitAngles[i];
              return (
                <tr key={w.colorHex} className="text-slate-300 border-t border-slate-800">
                  <td className="pr-2 py-0.5">
                    <span className="inline-block w-3 h-3 rounded-sm border border-slate-700 mr-1 align-middle"
                          style={{ background: w.colorHex }} />
                    {w.colorHex}
                  </td>
                  <td className="pr-2 py-0.5">{wc?.species ?? '—'}</td>
                  <td className="pr-2 py-0.5">{angle != null ? `${angle}°` : '—'}</td>
                  <td className={`pr-2 py-0.5 ${w.pocket.passed ? 'text-emerald-300' : 'text-red-300'}`}>{w.pocket.passed ? '✓' : '✗'}</td>
                  <td className="pr-2 py-0.5">{w.pocket.fullDepthPercent.toFixed(1)}</td>
                  <td className="pr-2 py-0.5">{w.pocket.problemAreaPercent.toFixed(1)}</td>
                  <td className={`pr-2 py-0.5 ${w.pocket.hasIsolatedUnreachableComponent ? 'text-red-300' : ''}`}>{w.pocket.hasIsolatedUnreachableComponent ? '⚠' : ''}</td>
                  <td className={`pr-2 py-0.5 ${w.plug.passed ? 'text-emerald-300' : 'text-red-300'}`}>{w.plug.passed ? '✓' : '✗'}</td>
                  <td className="pr-2 py-0.5">{w.plug.fullDepthPercent.toFixed(1)}</td>
                  <td className="pr-2 py-0.5">{w.plug.problemAreaPercent.toFixed(1)}</td>
                  <td className={`pr-2 py-0.5 ${w.plug.hasIsolatedUnreachableComponent ? 'text-red-300' : ''}`}>{w.plug.hasIsolatedUnreachableComponent ? '⚠' : ''}</td>
                  <td className="pr-2 py-0.5">{w.alignmentIssues.length}</td>
                  <td className="pr-2 py-0.5">{w.fillableHoleCount}</td>
                  <td className="pr-2 py-0.5">{Number.isFinite(w.layerMachineTimeMinutes) ? w.layerMachineTimeMinutes.toFixed(2) : 'NaN'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <KvTable
        className="mt-2"
        rows={[
          ['canvas px', `${result.canvasW} × ${result.canvasH} @ ${result.pixelsPerInch.toFixed(1)} ppi`],
          ['v-bit cut width (in)', result.vbitCutWidthInches.toFixed(4)],
          ['full-depth radius (in)', result.fullDepthRadiusInches.toFixed(4)],
          ['thin-wall threshold (in)', result.thinWallThresholdInches.toFixed(4)],
          ['alignment threshold (in)', result.alignmentThresholdInches.toFixed(4)],
          ['Step2 display angle°', String(result.step2DisplayAngleDegrees ?? 'none feasible')],
          ['Step2 suggestion angle°', String(result.step2SuggestionAngleDegrees ?? 'none')],
          ['total machine min', Number.isFinite(result.totalMachineTimeMinutes) ? result.totalMachineTimeMinutes.toFixed(2) : 'NaN'],
        ]}
      />
    </details>
  );
}

function PricingSection({ boardConfig, optimization, quote }: Omit<DebugInfoPanelProps, 'designs'>) {
  const { perSide, noFeasibleAngle } = optimization.aggregated;
  const sumSpecies = perSide.top.uniqueSpeciesCount + perSide.bottom.uniqueSpeciesCount;

  const grooveSides =
    boardConfig.juiceGroove === 'both' ? 2 :
    boardConfig.juiceGroove === 'none' ? 0 : 1;
  const handlesMinutes =
    boardConfig.handles === 'inset'     ? MACHINE_MIN_INSET_HANDLES :
    boardConfig.handles === 'underside' ? MACHINE_MIN_UNDERSIDE_HANDLES :
    0;

  const inlayLineItemsForSide = (s: typeof perSide.top, sideLabel: string): [string, string][] => {
    const out: [string, string][] = [];
    for (const [species, usage] of s.plugStockUsageBySpecies) {
      const fullPrice = INLAY_WOOD_PRICE[species] ?? 0;
      const utilization = usage / INLAY_SHEET_AREA_SQ_IN;
      const charged = utilization > INLAY_PACKING_THRESHOLD ? fullPrice : utilization * fullPrice;
      out.push([
        `inlay ${sideLabel} ${species}`,
        `usage=${usage.toFixed(1)} in² (${(utilization * 100).toFixed(1)}% of sheet), full=$${fullPrice}, charged=$${charged.toFixed(2)} (${utilization > INLAY_PACKING_THRESHOLD ? 'full' : 'prorated'})`,
      ]);
    }
    return out;
  };

  return (
    <Section label="Pricing">
      <KvTable
        rows={[
          ['noFeasibleAngle', noFeasibleAngle ? 'true (approximate quote)' : 'false'],
          ['—', ''],
          ['top side cutting min', perSide.top.totalCuttingMinutes.toFixed(2)],
          ['top side tool-change min', perSide.top.jointToolChangeMinutes.toFixed(2)],
          ['top species count', String(perSide.top.uniqueSpeciesCount)],
          ['bottom side cutting min', perSide.bottom.totalCuttingMinutes.toFixed(2)],
          ['bottom side tool-change min', perSide.bottom.jointToolChangeMinutes.toFixed(2)],
          ['bottom species count', String(perSide.bottom.uniqueSpeciesCount)],
          ['sum species (per-side counted)', String(sumSpecies)],
          ['—', ''],
          ['base board', `${boardConfig.wood} → $${BASE_BOARD_PRICE[boardConfig.wood]}`],
          ...inlayLineItemsForSide(perSide.top,    'top'),
          ...inlayLineItemsForSide(perSide.bottom, 'bottom'),
          ['materials $ (sum)', `$${quote.breakdown.materialsDollars.toFixed(2)}`],
          ['—', ''],
          ['cutting min (top+bot)', (perSide.top.totalCuttingMinutes + perSide.bottom.totalCuttingMinutes).toFixed(2)],
          ['tool-change min (top+bot)', (perSide.top.jointToolChangeMinutes + perSide.bottom.jointToolChangeMinutes).toFixed(2)],
          ['per-inlay machining', `${MACHINE_MIN_PER_INLAY} × ${sumSpecies} = ${(MACHINE_MIN_PER_INLAY * sumSpecies).toFixed(0)} min`],
          ['groove machining', `${MACHINE_MIN_PER_GROOVE_SIDE} × ${grooveSides} = ${(MACHINE_MIN_PER_GROOVE_SIDE * grooveSides).toFixed(0)} min`],
          ['handles machining', `${handlesMinutes} min (handles=${boardConfig.handles})`],
          ['machine total min', quote.breakdown.machineMinutes.toFixed(2)],
          ['machine $', `${quote.breakdown.machineMinutes.toFixed(2)} / 60 × $${MACHINE_HOURLY} = $${quote.breakdown.machineDollars.toFixed(2)}`],
          ['—', ''],
          ['labor setup min', String(LABOR_MIN_SETUP)],
          ['labor per-inlay', `${LABOR_MIN_PER_INLAY} × ${sumSpecies} = ${(LABOR_MIN_PER_INLAY * sumSpecies).toFixed(0)} min`],
          ['labor finishing min', String(LABOR_MIN_FINISHING)],
          ['labor total min', quote.breakdown.laborMinutes.toFixed(2)],
          ['labor $', `${quote.breakdown.laborMinutes.toFixed(2)} / 60 × $${LABOR_HOURLY} = $${quote.breakdown.laborDollars.toFixed(2)}`],
          ['—', ''],
          ['add-on (feet)', boardConfig.sided === 'feet' ? `+$${ADDON_FEET}` : '—'],
          ['add-on $', `$${quote.breakdown.addOnDollars.toFixed(2)}`],
          ['—', ''],
          ['total estimate', `$${quote.breakdown.totalEstimate.toFixed(2)}`],
          ['low (×0.90 →$10)', `$${quote.lowDollars}`],
          ['high (×1.25 →$10)', `$${quote.highDollars}`],
        ]}
      />
    </Section>
  );
}

function SettingsSection({ optimization }: { optimization: MultiDesignOptimizationResult }) {
  // Pull settings from the first design's analysis result. All designs
  // run with the same guided settings.
  const first = optimization.perDesign[0];
  if (!first) return null;
  const r = first.result;
  return (
    <Section label="Settings">
      <KvTable
        rows={[
          ['analysis canvas', `${r.canvasW} × ${r.canvasH} @ ${r.pixelsPerInch.toFixed(1)} ppi`],
          ['clearance bit dia (in)', r.clearanceBitDiameterInches.toFixed(3)],
          ['clearance bit MRR (in³/min)', r.clearanceMRR.toFixed(2)],
          ['v-bit MRR (in³/min)', Number.isFinite(r.vbitMRR) ? r.vbitMRR.toFixed(2) : 'NaN'],
          ['v-bit feed (in/min)', Number.isFinite(r.vbitFeed) ? r.vbitFeed.toFixed(2) : 'NaN'],
        ]}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// ZIP download
// ---------------------------------------------------------------------------

const ZIP_RASTER_WIDTH = 1200;

function DownloadZipButton({ boardConfig, designs, optimization, quote }: DebugInfoPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Lazy-load JSZip — keeps the dev panel's helper code out of the
      // initial route bundle, and prod never reaches this code path
      // because the panel early-returns at `process.env.NODE_ENV`.
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();

      // Top-level board manifest. `codeVersion` is bumped on every
      // source edit (see `src/lib/codeVersion.ts`) so a stale dev
      // bundle is immediately spottable in the exported archive.
      zip.file('manifest.json', JSON.stringify({
        codeVersion: CODE_VERSION,
        codeVersionNote: CODE_VERSION_NOTE,
        boardConfig,
        quote,
        noFeasibleAngle: optimization.aggregated.noFeasibleAngle,
        capturedAt: new Date().toISOString(),
      }, null, 2));

      // Per-design content.
      for (let dIdx = 0; dIdx < optimization.perDesign.length; dIdx++) {
        const final = optimization.perDesign[dIdx];
        const original = designs.find(d => d.id === final.designId);
        const designSlug = `${String(dIdx + 1).padStart(2, '0')}-${slug(final.vector.fileName)}`;
        const dir = zip.folder(designSlug)!;

        dir.file('design.json', JSON.stringify({
          id: final.designId,
          side: final.side,
          fileName: final.vector.fileName,
          fileType: final.vector.fileType,
          naturalWidth:  final.vector.naturalWidth,
          naturalHeight: final.vector.naturalHeight,
          viewBox: final.vector.viewBox,
          placement: final.placement,
          appliedFill: final.appliedFill,
          woodConfigs: final.woodConfigs,
          detectedColors: final.vector.detectedColors,
          bitPlan: final.bitPlan,
          analysisCanvas: { w: final.result.canvasW, h: final.result.canvasH, ppi: final.result.pixelsPerInch },
        }, null, 2));

        // Per-layer raster comparison + analysis overlays.
        for (let lIdx = 0; lIdx < final.vector.layers.length; lIdx++) {
          const finalLayer = final.vector.layers[lIdx];
          const originalLayer = original?.vector.layers.find(l => l.colorHex === finalLayer.colorHex) ?? null;
          const wood = final.result.woods.find(w => w.colorHex === finalLayer.colorHex);
          const layerSlug = `layer-${String(lIdx + 1).padStart(2, '0')}-${finalLayer.colorHex.slice(1)}`;
          const layerDir = dir.folder(layerSlug)!;

          // Original + final + diff PNGs at our standard raster size.
          // Sized to design aspect; renders both layers identically so
          // pixel comparison is meaningful.
          const aspect = final.vector.naturalHeight / final.vector.naturalWidth;
          const w = ZIP_RASTER_WIDTH;
          const h = Math.max(1, Math.round(w * aspect));

          const finalPng = await rasterizeLayer(finalLayer, final.vector.viewBox, final.vector.naturalWidth, final.vector.naturalHeight, w, h);
          layerDir.file('final.png', finalPng);
          layerDir.file('final.svg', layerToStandaloneSvg(finalLayer, final.vector.viewBox, final.vector.naturalWidth, final.vector.naturalHeight));

          if (originalLayer) {
            const origPng = await rasterizeLayer(originalLayer, final.vector.viewBox, final.vector.naturalWidth, final.vector.naturalHeight, w, h);
            layerDir.file('original.png', origPng);
            layerDir.file('original.svg', layerToStandaloneSvg(originalLayer, final.vector.viewBox, final.vector.naturalWidth, final.vector.naturalHeight));

            const diffBlob = await diffPng(originalLayer, finalLayer, final.vector.viewBox, final.vector.naturalWidth, final.vector.naturalHeight, w, h);
            layerDir.file('diff.png', diffBlob);
          } else {
            // Layer is new (e.g., the inlaid stroke layer added at parse) — record that fact.
            layerDir.file('original.txt', 'Layer not present in original input (e.g., synthesized stroke layer or hull-fill addition).');
          }

          // Analysis overlays + depth maps from the cached AnalysisResult.
          if (wood) {
            await writeDataUrlIfPresent(layerDir, 'pocket-overlay.png', wood.pocket.overlayDataUrl);
            await writeDataUrlIfPresent(layerDir, 'pocket-suggestion.png', wood.pocket.suggestionOverlayDataUrl);
            await writeDataUrlIfPresent(layerDir, 'pocket-depthmap.png', wood.pocket.depthMapDataUrl);
            await writeDataUrlIfPresent(layerDir, 'plug-overlay.png', wood.plug.overlayDataUrl);
            await writeDataUrlIfPresent(layerDir, 'plug-suggestion.png', wood.plug.suggestionOverlayDataUrl);
            await writeDataUrlIfPresent(layerDir, 'plug-depthmap.png', wood.plug.depthMapDataUrl);

            // Annotated problem-area images: same overlay PNG with the
            // expert flow's issue-locator badges (numbered translucent
            // discs) burned in, so tiny flagged regions are easy to
            // find at a glance.
            const pocketProblems = await overlayWithBadges(
              wood.pocket.overlayDataUrl, wood.pocket.problemComponents,
              final.result.canvasW, final.result.canvasH,
            );
            if (pocketProblems) layerDir.file('pocket-problem-areas.png', pocketProblems);
            const plugProblems = await overlayWithBadges(
              wood.plug.overlayDataUrl, wood.plug.problemComponents,
              final.result.canvasW, final.result.canvasH,
            );
            if (plugProblems) layerDir.file('plug-problem-areas.png', plugProblems);
            layerDir.file('analysis.json', JSON.stringify({
              colorHex: wood.colorHex,
              pocket: {
                passed: wood.pocket.passed,
                fullDepthPercent: wood.pocket.fullDepthPercent,
                problemAreaPercent: wood.pocket.problemAreaPercent,
                hasIsolatedUnreachableComponent: wood.pocket.hasIsolatedUnreachableComponent,
                vbitAngleWarning: wood.pocket.vbitAngleWarning,
                thinWallPixelCount: wood.pocket.thinWallPixelCount,
                problemComponents: wood.pocket.problemComponents,
              },
              plug: {
                passed: wood.plug.passed,
                fullDepthPercent: wood.plug.fullDepthPercent,
                problemAreaPercent: wood.plug.problemAreaPercent,
                hasIsolatedUnreachableComponent: wood.plug.hasIsolatedUnreachableComponent,
                vbitAngleWarning: wood.plug.vbitAngleWarning,
                thinWallPixelCount: wood.plug.thinWallPixelCount,
                problemComponents: wood.plug.problemComponents,
              },
              alignmentIssues: wood.alignmentIssues,
              fillableHoleCount: wood.fillableHoleCount,
              fillableHoleAreaSqIn: wood.fillableHoleAreaSqIn,
              clearanceAreaSqIn: wood.clearanceAreaSqIn,
              vbitAreaSqIn: wood.vbitAreaSqIn,
              perimeterIn: wood.perimeterIn,
              pocketMachineTimeMinutes: wood.pocketMachineTimeMinutes,
              plugMachineTimeMinutes: wood.plugMachineTimeMinutes,
              layerMachineTimeMinutes: wood.layerMachineTimeMinutes,
            }, null, 2));
          }
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inlay-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="px-3 py-1.5 rounded text-[11px] font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 disabled:opacity-50"
      >
        {busy ? 'Building ZIP…' : 'Download per-layer ZIP'}
      </button>
      {error && <span className="text-[11px] text-red-300 self-center">{error}</span>}
    </>
  );
}

/** Rasterize a single layer's standalone SVG to a PNG `Blob`. */
async function rasterizeLayer(
  layer: Layer,
  viewBox: string,
  naturalWidth: number,
  naturalHeight: number,
  w: number,
  h: number,
): Promise<Blob> {
  const oc = await renderLayer(layer, viewBox, naturalWidth, naturalHeight, w, h);
  return oc.convertToBlob({ type: 'image/png' });
}

/** Render two layers' standalone SVGs at the same raster size and emit a
 *  diff PNG: red = pixels lost (in original, missing in final),
 *  green = pixels gained (added by optimization), gray = unchanged. */
async function diffPng(
  originalLayer: Layer,
  finalLayer: Layer,
  viewBox: string,
  naturalWidth: number,
  naturalHeight: number,
  w: number,
  h: number,
): Promise<Blob> {
  const [origCanvas, finalCanvas] = await Promise.all([
    renderLayer(originalLayer, viewBox, naturalWidth, naturalHeight, w, h),
    renderLayer(finalLayer,    viewBox, naturalWidth, naturalHeight, w, h),
  ]);
  const origData  = origCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const finalData = finalCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;

  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const inOrig  = isLayerPixel(origData,  o);
    const inFinal = isLayerPixel(finalData, o);
    if (inOrig && inFinal)        { d[o] = 96; d[o+1] = 96; d[o+2] = 96; d[o+3] = 200; } // unchanged: gray
    else if (inOrig && !inFinal)  { d[o] = 220; d[o+1] = 40; d[o+2] = 40; d[o+3] = 230; } // removed: red
    else if (!inOrig && inFinal)  { d[o] = 40; d[o+1] = 200; d[o+2] = 80; d[o+3] = 230; } // added: green
    else                           { d[o] = 0;  d[o+1] = 0;  d[o+2] = 0;  d[o+3] = 0; }   // background: transparent
  }
  ctx.putImageData(img, 0, 0);
  return out.convertToBlob({ type: 'image/png' });
}

/** Same threshold the rest of the analysis pipeline uses. */
function isLayerPixel(data: Uint8ClampedArray, offset: number): boolean {
  const r = data[offset], g = data[offset + 1], b = data[offset + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b < 220;
}

async function renderLayer(
  layer: Layer,
  viewBox: string,
  naturalWidth: number,
  naturalHeight: number,
  w: number,
  h: number,
): Promise<OffscreenCanvas> {
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  const svg = layerToStandaloneSvg(layer, viewBox, naturalWidth, naturalHeight);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, w, h); resolve(); };
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return oc;
}

/**
 * Render the problem-area overlay PNG with issue-locator badges
 * burned in — same numbered translucent red discs the expert flow
 * shows over tiny problem regions in `IssueLocatorBadges`. Returns
 * `null` if the overlay PNG is empty (no analysis yet).
 *
 * Component filtering / capping mirrors the runtime badge component:
 * skip components larger than 5% of the source area (they're easy
 * to spot on their own), keep the smallest 10 (most likely to be
 * missed without a marker), renumber in scan order.
 */
async function overlayWithBadges(
  overlayDataUrl: string,
  components: readonly { cx: number; cy: number; areaPx: number }[],
  sourceWidth: number,
  sourceHeight: number,
): Promise<Blob | null> {
  if (!overlayDataUrl) return null;
  if (components.length === 0) {
    // No problem regions — emit the unannotated overlay as-is so the
    // file exists at a predictable name.
    const m = /^data:[^;]+;base64,(.+)$/.exec(overlayDataUrl);
    if (!m) return null;
    const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
    return new Blob([bytes], { type: 'image/png' });
  }

  const img = await loadHtmlImage(overlayDataUrl);
  const oc = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const totalArea = sourceWidth * sourceHeight;
  const LARGE_AREA_FRACTION = 0.05;
  const MAX_BADGES = 10;
  const filtered = components.filter(c => c.areaPx / totalArea <= LARGE_AREA_FRACTION);
  const limited = [...filtered].sort((a, b) => a.areaPx - b.areaPx).slice(0, MAX_BADGES);
  // Renumber in scan order so labels read top→bottom, left→right.
  const ordered = [...limited].sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  const radius = Math.max(16, Math.round(img.naturalWidth * 0.018));
  ctx.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, radius, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(220, 70, 70, 0.95)';
    ctx.fill();
    ctx.lineWidth = Math.max(2, Math.round(radius * 0.15));
    ctx.strokeStyle = 'white';
    ctx.stroke();
    ctx.fillStyle = 'white';
    ctx.fillText(String(i + 1), c.cx, c.cy);
  }
  return oc.convertToBlob({ type: 'image/png' });
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

/** Decode a `data:image/png;base64,…` URL into bytes and add to the zip. Skips when empty. */
async function writeDataUrlIfPresent(
  dir: import('jszip'),
  filename: string,
  dataUrl: string,
): Promise<void> {
  if (!dataUrl) return;
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl);
  if (!m) return;
  // JSZip understands base64 directly via the `base64: true` option.
  // Cast: dir is JSZip subfolder (same API as JSZip root).
  (dir as unknown as { file: (name: string, content: string, opts: { base64: boolean }) => void })
    .file(filename, m[1], { base64: true });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details open className="bg-slate-950/50 border border-slate-800 rounded p-2">
      <summary className="text-slate-100 font-semibold cursor-pointer select-none">{label}</summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

function KvTable({ rows, className = '' }: { rows: [string, string][]; className?: string }) {
  return (
    <table className={`w-full text-left border-collapse ${className}`}>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i} className={k === '—' ? '' : 'border-t border-slate-800'}>
            <td className="pr-3 py-0.5 text-slate-400 align-top whitespace-nowrap">{k === '—' ? '' : k}</td>
            <td className="py-0.5 text-slate-200 break-words">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
