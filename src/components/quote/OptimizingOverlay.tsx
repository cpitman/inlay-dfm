'use client';

interface OptimizingOverlayProps {
  /** Status text — e.g. "Re-analyzing after fill…". */
  label: string;
}

/**
 * Full-screen overlay shown while the guided quote optimizer runs.
 * Mirrors the existing session-restore overlay's pattern (z-50, dim
 * backdrop, centered card with spinner). Status text is provided by
 * the caller and updates live as the optimizer advances through phases.
 */
export default function OptimizingOverlay({ label }: OptimizingOverlayProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center"
    >
      <div className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl px-6 py-5 flex items-center gap-4 max-w-md">
        <span className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
        <div>
          <p className="text-sm font-semibold text-slate-100">Optimizing your design…</p>
          <p className="text-xs text-slate-400 mt-0.5">{label}</p>
        </div>
      </div>
    </div>
  );
}
