'use client';

import { useEffect, useRef, useState } from 'react';
import type { VectorData } from '@/types';

interface DesignCanvasProps {
  vector: VectorData | null;
  /** Pass the overlay data URL to show it; null shows the plain SVG preview. */
  overlayDataUrl: string | null;
  /** Optional standalone SVG string to render instead of vector.svgString (for per-layer views). */
  svgOverride?: string;
}

export default function DesignCanvas({ vector, overlayDataUrl, svgOverride }: DesignCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!vector) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    setLoading(true);
    let objectUrl: string | null = null;

    const src = overlayDataUrl ?? (() => {
      const svg = svgOverride ?? vector.svgString;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      objectUrl = URL.createObjectURL(blob);
      return objectUrl;
    })();

    const img = new Image();
    img.onload = () => {
      canvas.width  = img.naturalWidth  || 800;
      canvas.height = img.naturalHeight || 600;
      ctx.fillStyle = '#f8f8f4';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setLoading(false);
    };
    img.onerror = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); setLoading(false); };
    img.src = src;
  }, [vector, overlayDataUrl, svgOverride]);

  if (!vector) {
    return (
      <div className="flex flex-col items-center justify-center min-h-48 rounded-lg border-2 border-dashed border-slate-700 bg-slate-800/30">
        <svg className="w-10 h-10 text-slate-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
            d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M9 9.75h.008v.008H9V9.75zm6 0h.008v.008H15V9.75zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-slate-500 text-xs">Upload a design</p>
      </div>
    );
  }

  return (
    <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-slate-50">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 z-10">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-auto"
        style={{ imageRendering: 'crisp-edges' }}
      />
    </div>
  );
}
