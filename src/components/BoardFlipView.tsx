'use client';

import { useState, type ReactNode } from 'react';

export type BoardSide = 'top' | 'bottom';

interface BoardFlipViewProps {
  side: BoardSide;
  onFlip: (next: BoardSide) => void;
  /** Two faces of the board. Each is rendered into its own absolutely-
   *  positioned face container; the wrapper rotates between them in 3D. */
  faces: { top: ReactNode; bottom: ReactNode };
  /** Width / height of the board image in CSS pixels — drives the
   *  flipper's bounding box. Both faces are absolutely-positioned to
   *  fill it. The caller's existing fit-to-container logic continues
   *  to compute these. */
  width: number;
  height: number;
  /** Optional: hide the flip button (e.g. while a drag is in flight,
   *  to avoid mid-gesture flips). */
  flipDisabled?: boolean;
  /** Optional class for the outer wrapper (positioning / shadows). */
  className?: string;
}

/**
 * 3D card-flip wrapper around a board preview. The board has two faces
 * (top + bottom); the user toggles between them via a button overlaid on
 * the preview. The flip is purely visual — both faces render in the
 * same coordinate system, so designs placed on the back use the same
 * top-left origin as the front.
 *
 *   - `perspective` on the outer container gives the rotation depth.
 *   - `transform-style: preserve-3d` on the inner so children sit in
 *     the same 3D space.
 *   - `backface-visibility: hidden` on each face so only the front-
 *     facing one is visible at any rotation.
 *   - `transition` on `transform` smooths the 0° ↔ 180° toggle.
 */
export default function BoardFlipView({
  side, onFlip, faces, width, height, flipDisabled, className,
}: BoardFlipViewProps) {
  // Track whether a flip is in-flight purely for the button label —
  // the actual flip animation runs on the inner div via CSS transition.
  const [flipping, setFlipping] = useState(false);

  const rotate = side === 'bottom' ? 180 : 0;

  const handleFlip = () => {
    if (flipDisabled) return;
    setFlipping(true);
    onFlip(side === 'top' ? 'bottom' : 'top');
    // Match the transition duration (CSS).
    setTimeout(() => setFlipping(false), 650);
  };

  return (
    <div
      className={`relative ${className ?? ''}`}
      style={{ width, height, perspective: '1200px' }}
    >
      <div
        className="relative"
        style={{
          width: '100%',
          height: '100%',
          transformStyle: 'preserve-3d',
          transform: `rotateY(${rotate}deg)`,
          transition: 'transform 0.6s cubic-bezier(.65,.05,.36,1)',
        }}
      >
        {/* Front face */}
        <div
          aria-hidden={side !== 'top'}
          style={{
            position: 'absolute',
            inset: 0,
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            // Keep child interactions only on the visible face — guarantees
            // drag handles on the hidden face don't catch events through.
            pointerEvents: side === 'top' && !flipping ? 'auto' : 'none',
          }}
        >
          {faces.top}
        </div>
        {/* Back face — rotated 180° so it faces forward when the wrapper is at 180°. */}
        <div
          aria-hidden={side !== 'bottom'}
          style={{
            position: 'absolute',
            inset: 0,
            transform: 'rotateY(180deg)',
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            pointerEvents: side === 'bottom' && !flipping ? 'auto' : 'none',
          }}
        >
          {faces.bottom}
        </div>
      </div>

      {/* Flip button — positioned outside the rotating div so it
          doesn't flip with the board. */}
      <button
        type="button"
        onClick={handleFlip}
        disabled={flipDisabled}
        title={side === 'top' ? 'Show the back of the board' : 'Show the front of the board'}
        className={`absolute top-2 right-2 z-10 px-2.5 py-1 rounded-md text-xs font-medium shadow border transition-colors
          ${flipDisabled
            ? 'bg-slate-800/60 border-slate-700 text-slate-500 cursor-not-allowed'
            : 'bg-slate-800/90 border-slate-600 text-slate-200 hover:bg-slate-700 hover:border-slate-500'}`}
      >
        ↻ Flip to {side === 'top' ? 'back' : 'front'}
      </button>

      {/* Side label */}
      <span
        aria-live="polite"
        className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-slate-900/70 text-slate-300 border border-slate-700"
      >
        {side === 'top' ? 'Front' : 'Back'}
      </span>
    </div>
  );
}
