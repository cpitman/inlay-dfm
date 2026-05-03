'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardConfig } from '@/types/board';
import type { QuoteResult } from '@/lib/pricing';
import type { MultiDesignOptimizationResult } from '@/lib/quoteOptimizer';
import { WOOD_SPECIES } from '@/lib/woodSpecies';

interface RequestManufacturingDialogProps {
  open: boolean;
  onClose: () => void;
  /** Read-only order details summarized in the dialog body. */
  boardConfig: BoardConfig;
  /** Per-design optimizer output + aggregated cost inputs. The dialog
   *  surfaces a per-design summary so the customer can confirm what
   *  they're ordering. */
  optimization: MultiDesignOptimizationResult;
  quote: QuoteResult;
}

/**
 * Mock manufacturing-request dialog. Captures contact info + an order
 * summary the user can confirm. On submit, shows a "thanks" confirmation
 * — there's no backend yet, this is just a placeholder to validate the
 * shape of the future flow. If the user completes a few of these end-
 * to-end successfully we'll wire it up to a real submission endpoint.
 */
export default function RequestManufacturingDialog({
  open, onClose, boardConfig, optimization, quote,
}: RequestManufacturingDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Reset form whenever the dialog opens fresh.
  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setName('');
    setEmail('');
    setNotes('');
    // Focus first input on open.
    setTimeout(() => firstInputRef.current?.focus(), 0);
  }, [open]);

  // Escape closes (only useful when not already in the success state —
  // we keep the same behavior post-submit so the user can dismiss).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // No-op for now — just flip to the thanks state.
    setSubmitted(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-mfg-title"
      className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        {submitted ? (
          <ThanksPanel onClose={onClose} />
        ) : (
          <>
            <header className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
              <h2 id="request-mfg-title" className="text-lg font-semibold text-slate-100">
                Request manufacturing
              </h2>
              <button
                onClick={onClose}
                aria-label="Close dialog"
                className="text-slate-400 hover:text-white text-xl leading-none"
              >×</button>
            </header>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <OrderSummary boardConfig={boardConfig} optimization={optimization} quote={quote} />

              <div>
                <label htmlFor="rm-name" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Your name
                </label>
                <input
                  id="rm-name"
                  ref={firstInputRef}
                  type="text"
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label htmlFor="rm-email" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Email
                </label>
                <input
                  id="rm-email"
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-slate-500 mt-1">We'll use this to send confirmation and follow up.</p>
              </div>

              <div>
                <label htmlFor="rm-notes" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Notes (optional)
                </label>
                <textarea
                  id="rm-notes"
                  rows={3}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Anything you'd like the maker to know — special details, deadlines, etc."
                  className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200"
                >Cancel</button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-md text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white"
                >Submit request</button>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                This is a preview submission — no order is placed and no payment is taken. The maker will reach out to confirm details.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function OrderSummary({
  boardConfig, optimization, quote,
}: {
  boardConfig: BoardConfig;
  optimization: MultiDesignOptimizationResult;
  quote: QuoteResult;
}) {
  const grooveLabel = boardConfig.juiceGroove === 'none' ? 'None' :
    boardConfig.juiceGroove === 'top'  ? 'Top side' :
    boardConfig.juiceGroove === 'bottom' ? 'Bottom side' :
    'Both sides';
  const handlesLabel = boardConfig.handles === 'none' ? 'No handles' :
    boardConfig.handles === 'inset' ? 'Inset (sides)' :
    'Underside pocket';
  const sidedLabel = boardConfig.sided === 'feet' ? 'Feet on bottom' : 'Dual-sided';

  // Union of distinct species across all designs (matches the
  // pricing model — labor + machining are charged per-species).
  const speciesNames = [...new Set(
    optimization.perDesign.flatMap(d => d.woodConfigs.map(wc => WOOD_SPECIES[wc.species].name))
  )];

  return (
    <section className="bg-slate-900/60 border border-slate-700 rounded-md p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Order summary</p>
        <p className="text-base font-bold text-white">
          ${quote.lowDollars.toLocaleString()} – ${quote.highDollars.toLocaleString()}
        </p>
      </div>
      <dl className="text-xs text-slate-300 space-y-1">
        <SummaryRow k="Board" v={`${boardConfig.widthInches}"×${boardConfig.heightInches}" ${capitalize(boardConfig.wood)}`} />
        <SummaryRow k="Sided" v={sidedLabel} />
        <SummaryRow k="Edge"  v={capitalize(boardConfig.edge)} />
        <SummaryRow k="Juice groove" v={grooveLabel} />
        <SummaryRow k="Handles" v={handlesLabel} />
        <SummaryRow k="Inlay woods" v={speciesNames.join(', ')} />
        <SummaryRow k="Designs" v={`${optimization.perDesign.length}`} />
      </dl>
      {optimization.perDesign.length > 1 && (
        <ul className="text-[11px] text-slate-400 mt-2 space-y-0.5 pl-1">
          {optimization.perDesign.map(d => (
            <li key={d.designId} className="truncate">
              · {d.vector.fileName}
              <span className="text-slate-500"> — {d.placement.designWidthInches.toFixed(2)}" wide</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500 w-24 shrink-0">{k}</dt>
      <dd className="text-slate-200">{v}</dd>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ThanksPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="p-8 text-center space-y-4">
      <div className="w-16 h-16 mx-auto rounded-full bg-emerald-600/30 border-2 border-emerald-500 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-8 h-8 text-emerald-300">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <p className="text-lg font-semibold text-slate-100">Thanks — we'll be in touch.</p>
      <p className="text-sm text-slate-400 leading-relaxed">
        Your request has been received. The maker will email you within a couple of business days to confirm details and next steps.
      </p>
      <button
        onClick={onClose}
        className="mt-2 px-4 py-2 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200"
      >Close</button>
    </div>
  );
}
