import Link from 'next/link';

/**
 * Placeholder for the guided "Get a quote" experience.
 *
 * Subsequent PRs add the real flow:
 *   - PR B: Step 1 (board form) + extended renderBoardWithFeatures
 *   - PR C: Step 2 (upload + placement + per-color wood selector)
 *   - PR D: Background optimization + Step 3 quote display
 *   - PR E: Mock "Request manufacturing" submission + polish
 *
 * Until then, this page just announces what's coming and points users
 * to the working expert experience.
 */
export default function QuotePagePlaceholder() {
  return (
    <div className="flex flex-col h-screen bg-slate-900">
      <header className="bg-slate-800/80 border-b border-slate-700 px-6 py-3 flex items-center gap-3 shrink-0">
        <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">← Home</Link>
        <h1 className="font-semibold text-slate-100 text-lg ml-2">Get a quote</h1>
      </header>
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <p className="text-2xl">🚧</p>
          <p className="text-slate-200 font-semibold">Coming soon</p>
          <p className="text-sm text-slate-400">
            The guided quote experience is under construction. In the meantime,
            you can use the{' '}
            <Link href="/expert" className="text-blue-400 hover:text-blue-300 underline">
              Expert DFM analyzer
            </Link>
            {' '}to upload and analyze your design.
          </p>
        </div>
      </main>
    </div>
  );
}
