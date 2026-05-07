'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Layer } from '@/types';
import { layerToStandaloneSvg } from '@/lib/svgLayers';

export type StrokeChoice = 'discard' | 'inlay';

interface StrokeHandlingDialogProps {
  /** When non-null, dialog is open. */
  prompt: null | {
    fileName: string;
    strokeLayer: Layer;
    viewBox: string;
    naturalWidth: number;
    naturalHeight: number;
  };
  onChoose: (choice: StrokeChoice) => void;
  onCancel: () => void;
}

/**
 * Modal asking the user how to handle visible strokes (line art /
 * outlines) on an uploaded design or clipart pick. Surfaced after
 * parse, before the design lands on the board.
 *
 * "Discard" continues with fill-only geometry (the prior default).
 * "Inlay strokes" prepends a synthesized stroke layer at index 0
 * (most-in-the-background) so the existing per-color wood UI lets
 * the user pick a wood for it like any other layer.
 */
export default function StrokeHandlingDialog({ prompt, onChoose, onCancel }: StrokeHandlingDialogProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const standaloneSvg = useMemo(() => {
    if (!prompt) return null;
    return layerToStandaloneSvg(
      prompt.strokeLayer,
      prompt.viewBox,
      prompt.naturalWidth,
      prompt.naturalHeight,
    );
  }, [prompt]);

  // Convert the standalone SVG to a blob URL for the preview <img>.
  // Using a blob URL (not a data URL) keeps the markup simple and
  // matches how the rest of the app feeds SVG to <img> tags.
  useEffect(() => {
    if (!standaloneSvg) {
      setPreviewUrl(null);
      return;
    }
    const blob = new Blob([standaloneSvg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [standaloneSvg]);

  if (!prompt) return null;

  return (
    <div
      className="fixed inset-0 z-30 bg-slate-950/70 flex items-center justify-center p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">Handle outlines?</h3>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-lg leading-none"
            aria-label="Close"
          >×</button>
        </div>

        <p className="text-sm text-slate-300">
          <span className="font-medium text-slate-100">{prompt.fileName}</span>{' '}
          uses visible strokes (line art / outlines) to define its shapes.
          We can either discard them or inlay them as their own background layer
          so you can pick a wood species for the outlines too.
        </p>

        {/* Stroke preview */}
        {previewUrl && (
          <div className="bg-slate-900 border border-slate-700 rounded p-2 flex items-center justify-center" style={{ minHeight: 120 }}>
            <img
              src={previewUrl}
              alt="Detected outline geometry"
              className="max-h-32 max-w-full object-contain"
              style={{ filter: 'invert(1)' }}
            />
          </div>
        )}

        <p className="text-[11px] text-slate-500">
          The outline layer is added at the back, behind every other inlay,
          so colored regions in front cover the outlines wherever they overlap.
        </p>

        {/* Choices */}
        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            onClick={() => onChoose('inlay')}
            className="w-full px-4 py-2 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white"
          >Inlay outlines as a background layer</button>
          <button
            type="button"
            onClick={() => onChoose('discard')}
            className="w-full px-4 py-2 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
          >Discard outlines</button>
        </div>
      </div>
    </div>
  );
}
