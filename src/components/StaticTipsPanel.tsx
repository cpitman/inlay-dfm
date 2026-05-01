'use client';

interface Tip {
  title: string;
  body: string;
}

const TIPS: Tip[] = [
  {
    title: 'Scale up to use a wider v-bit',
    body: 'A larger physical design can use a wider v-bit angle, which removes material faster. If your design is small and machining time is high, try doubling its size on Step 1 first.',
  },
  {
    title: 'Sharper angles reach corners but take longer',
    body: 'A 30° v-bit reaches deeper into narrow corners than a 90°, but it removes much less material per pass. Use a sharp angle only when the design has features you can\'t widen.',
  },
  {
    title: 'Avoid features narrower than the smallest feasible bit',
    body: 'If a thin region only fits the sharpest v-bit, you\'re paying for that bit\'s slow rate everywhere. Widening it lets a faster bit handle the whole design.',
  },
  {
    title: 'Mind opposing-grain walls',
    body: 'Walls that run perpendicular to the wood grain are weakest. The threshold overlay flags walls below 0.05" against the grain — widen them or rotate the design.',
  },
  {
    title: 'Stage layers so registration tolerates a small slip',
    body: 'When two inlays share a thin border, even 1–2 thou of registration error shows. Use the auto-improvements above to extend the lower inlay under the upper.',
  },
];

/**
 * Static general-purpose DFM tips. Always shown at the bottom of Step 2 — a
 * compact reference for the artist that doesn't depend on the current
 * design's analysis output.
 */
export default function StaticTipsPanel() {
  return (
    <section className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 space-y-3">
      <p className="text-sm font-semibold text-slate-200">General DFM tips</p>
      <ul className="space-y-2">
        {TIPS.map(tip => (
          <li key={tip.title} className="text-xs">
            <p className="font-semibold text-slate-300">{tip.title}</p>
            <p className="text-slate-400 leading-snug">{tip.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
