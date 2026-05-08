'use client';

import { useEffect, useState } from 'react';
import type { DFMSettings } from '@/types';
import { parseSvg } from '@/lib/vectorParser';
import { runDfmAnalysis } from '@/lib/dfmAnalysis';

/**
 * Internal route used by the clipart-scrape script. Once mounted, it
 * exposes `window.__screenClipart(svgString)` — a function the
 * Playwright driver calls to push each candidate through
 * `runDfmAnalysis` at a fixed "8-inch wide, mid-of-the-road preset"
 * configuration. The screening verdict is the same one users see at
 * runtime; no parallel implementation to keep in sync.
 *
 * Not linked from anywhere in the app; users hitting this route
 * directly see only "ready" status text.
 */

interface ScreenResult {
  ok: boolean;
  /** True iff every (layer × side) pair passed at the chosen preset. */
  allPassed: boolean;
  /** Worst pocket-or-plug `problemAreaPercent` across all layers. */
  worstProblemAreaPercent: number;
  /** True iff any layer has an isolated unreachable component. */
  hasIsolatedUnreachableComponent: boolean;
  /** Total alignment-issue affectedPercent (sum across layers). */
  totalAlignmentAffectedPercent: number;
  /** Vector metadata captured during parse. */
  colorCount: number;
  colors: string[];
  aspectRatio: number;
  /** Optional reason string when ok=false. */
  reason?: string;
}

const SCREENING_SETTINGS: DFMSettings = {
  // 8" wide × ~6" tall mid-of-the-road config.
  designWidthInches: 8,
  vbitAngleDegrees: 60,
  inlayDepthInches: 0.125,
  grainDirection: 'horizontal',
  clearanceBitDiameterInches: 0.25,
  clearanceStrategy: [0.25],
  toolChangeMinutes: 5,
  plugStockMarginInches: 0.5,
  plugGlueGapInches: 0,
  plugSurfaceGapInches: 0,
  boardWidthInches: 12,
  boardHeightInches: 9,
  designOffsetXInches: 2,
  designOffsetYInches: 1.5,
};

/** Lower-resolution canvas keeps batch screening time bounded. 1200/2 = 600px wide. */
const SCREENING_CANVAS_WIDTH = 600;

declare global {
  interface Window {
    __screenClipart?: (svgString: string) => Promise<ScreenResult>;
    __screenClipartReady?: boolean;
  }
}

export default function ScreenClipartPage() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    window.__screenClipart = async (svgString: string): Promise<ScreenResult> => {
      try {
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const file = new File([blob], 'candidate.svg', { type: 'image/svg+xml' });
        const vector = await parseSvg(file);

        const colors = vector.detectedColors;
        const aspectRatio = vector.naturalWidth / vector.naturalHeight;

        if (colors.length === 0) {
          return {
            ok: false,
            allPassed: false,
            worstProblemAreaPercent: 0,
            hasIsolatedUnreachableComponent: false,
            totalAlignmentAffectedPercent: 0,
            colorCount: 0,
            colors,
            aspectRatio,
            reason: 'No colored regions detected',
          };
        }

        const result = await runDfmAnalysis(
          vector,
          SCREENING_SETTINGS,
          colors,
          SCREENING_CANVAS_WIDTH,
          { produceOverlays: false, useBinarySearchFeasibility: true },
        );

        let allPassed = true;
        let worstProblemAreaPercent = 0;
        let hasIsolated = false;
        let totalAlignmentAffectedPercent = 0;
        for (const w of result.woods) {
          if (!w.pocket.passed || !w.plug.passed) allPassed = false;
          worstProblemAreaPercent = Math.max(
            worstProblemAreaPercent,
            w.pocket.problemAreaPercent,
            w.plug.problemAreaPercent,
          );
          if (w.pocket.hasIsolatedUnreachableComponent || w.plug.hasIsolatedUnreachableComponent) {
            hasIsolated = true;
          }
          for (const a of w.alignmentIssues) totalAlignmentAffectedPercent += a.affectedPercent;
        }

        return {
          ok: allPassed && !hasIsolated,
          allPassed,
          worstProblemAreaPercent,
          hasIsolatedUnreachableComponent: hasIsolated,
          totalAlignmentAffectedPercent,
          colorCount: colors.length,
          colors,
          aspectRatio,
        };
      } catch (e) {
        return {
          ok: false,
          allPassed: false,
          worstProblemAreaPercent: 0,
          hasIsolatedUnreachableComponent: false,
          totalAlignmentAffectedPercent: 0,
          colorCount: 0,
          colors: [],
          aspectRatio: 1,
          reason: (e as Error).message,
        };
      } finally {
        setCount(c => c + 1);
      }
    };
    window.__screenClipartReady = true;
    return () => {
      delete window.__screenClipart;
      delete window.__screenClipartReady;
    };
  }, []);

  return (
    <div className="p-6 font-mono text-sm bg-slate-900 text-slate-200 min-h-screen">
      <h1 className="text-base font-semibold text-slate-100 mb-2">Clipart screening route</h1>
      <p className="text-slate-400">
        Internal route. Drives <code>window.__screenClipart(svgString)</code> from the scrape script.
      </p>
      <p className="text-slate-500 mt-4">Processed: {count}</p>
    </div>
  );
}
