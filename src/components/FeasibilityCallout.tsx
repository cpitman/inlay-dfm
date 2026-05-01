'use client';

import type { AnalysisResult } from '@/types';

interface FeasibilityCalloutProps {
  result: AnalysisResult;
}

/**
 * Top-of-Step-2 prominent display of the design's feasibility ceiling: the
 * largest preset v-bit angle that can carve the whole design cleanly. This
 * is one of the most important pieces of information on this page — it
 * tells the user, before they pick a bit, what their design supports today.
 *
 * Three states:
 *   1. Feasible with an upgrade path: green callout naming the largest
 *      feasible angle and the next-wider angle's promise (faster carving
 *      if the teal regions on the canvas are widened).
 *   2. Feasible at the widest preset (120°): green callout, no upgrade.
 *   3. No feasible angle at any preset: red error. The artist must widen
 *      the red regions on the canvas before manufacturing is possible.
 */
export default function FeasibilityCallout({ result }: FeasibilityCalloutProps) {
  const display = result.step2DisplayAngleDegrees;
  const suggestion = result.step2SuggestionAngleDegrees;

  // No feasible angle — irreducible problems. Red error state.
  if (display === null) {
    return (
      <section className="bg-red-900/40 border-2 border-red-700 rounded-lg p-5">
        <div className="flex items-start gap-4">
          <span className="text-3xl shrink-0 leading-none text-red-300">✗</span>
          <div className="space-y-1">
            <p className="text-lg font-bold text-red-200">No feasible v-bit</p>
            <p className="text-sm text-red-100">
              Even a {15}° v-bit (the sharpest preset) cannot carve every feature in this design.
              The red regions below cannot be reached by any preset v-bit — widen or
              remove those features before this design can be manufactured.
            </p>
          </div>
        </div>
      </section>
    );
  }

  // Feasible. Pronounced green callout naming the angle.
  return (
    <section className="bg-emerald-900/40 border-2 border-emerald-700 rounded-lg p-5">
      <div className="flex items-start gap-4">
        <span className="text-3xl shrink-0 leading-none text-emerald-300">✓</span>
        <div className="flex-1 space-y-1">
          <div className="flex items-baseline gap-3 flex-wrap">
            <p className="text-sm font-semibold text-emerald-300 uppercase tracking-wider">
              Largest feasible v-bit
            </p>
            <p className="text-3xl font-bold text-white leading-none">
              {display}°
            </p>
          </div>
          <p className="text-sm text-emerald-100">
            {suggestion !== null
              ? <>
                  This design carves cleanly with a {display}° v-bit.
                  Widen the <span className="inline-block w-2.5 h-2.5 rounded align-middle mx-0.5" style={{ background: 'rgb(40,200,210)' }} />{' '}
                  teal regions to enable a <strong className="text-white">{suggestion}° v-bit</strong>, which would carve faster.
                </>
              : <>
                  This design carves cleanly with the widest preset v-bit. No widening
                  changes would unlock a faster bit — the design is already as bit-friendly
                  as the preset ladder allows.
                </>}
          </p>
        </div>
      </div>
    </section>
  );
}
