import Link from 'next/link';

/**
 * Landing chooser. Two doors:
 *   - "Get a quote" → guided experience at /quote (artwork owners)
 *   - "Expert DFM"  → 4-step stepper at /expert  (sophisticated users)
 *
 * Kept intentionally bare. The header on each downstream route already
 * carries the app's branding; this page is just a pick-your-experience
 * fork.
 */
export default function Landing() {
  return (
    <div className="flex flex-col h-screen bg-slate-900">
      <header className="bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center gap-3 shrink-0">
        <svg className="w-6 h-6 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <h1 className="font-semibold text-slate-100 text-lg">Inlay DFM Analyzer</h1>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl w-full">
          <Link
            href="/quote"
            className="group bg-slate-800 hover:bg-slate-700 border-2 border-slate-700 hover:border-blue-500 rounded-xl p-8 transition-all"
          >
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl">🪵</span>
              <h2 className="text-xl font-semibold text-slate-100">Get a quote</h2>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed mb-4">
              Upload your artwork and get a price estimate for a custom inlaid
              cutting board. Pick the wood, board features, and inlay species —
              the system handles the rest.
            </p>
            <p className="text-xs text-blue-300 font-medium group-hover:text-blue-200">
              Best for artwork owners and customers →
            </p>
          </Link>

          <Link
            href="/expert"
            className="group bg-slate-800 hover:bg-slate-700 border-2 border-slate-700 hover:border-blue-500 rounded-xl p-8 transition-all"
          >
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl">⚙️</span>
              <h2 className="text-xl font-semibold text-slate-100">Expert DFM</h2>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed mb-4">
              Full design-for-manufacturability analysis: layer-by-layer
              feasibility, v-bit recommendation, machining-time matrix,
              auto-improvements, and SVG export.
            </p>
            <p className="text-xs text-blue-300 font-medium group-hover:text-blue-200">
              Best for makers and CNC operators →
            </p>
          </Link>
        </div>
      </main>
    </div>
  );
}
