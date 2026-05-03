'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardConfig } from '@/types/board';
import type { RotationDegrees } from '@/types';
import { renderBoardWithFeatures } from '@/lib/boardFeatures';

interface BoardPreviewProps {
  config: BoardConfig;
  /** Optional design composite (data URL) overlaid on top of the board. */
  designDataUrl?: string | null;
  /** Where the design sits on the board (inches from top-left). This is
   *  the *visible* AABB origin — when rotation is 90° or 270°, the
   *  rotated design's bounding box swaps width and height, and this
   *  offset is the top-left of the swapped box. */
  designOffsetXInches?: number;
  designOffsetYInches?: number;
  /** Visible width / height of the design in inches (after rotation). */
  designWidthInches?: number;
  designHeightInches?: number;
  /** 90°-step rotation; default 0. The image content rotates around
   *  its center inside the visible AABB so it doesn't stretch. */
  designRotationDegrees?: RotationDegrees;
}

/**
 * Renders the board surface with all selected features (edge bevel,
 * top juice groove, inset handles) plus an optional design overlay.
 *
 * The board PNG is regenerated whenever any feature setting changes —
 * this is a pixel-by-pixel render, but at the default 100 ppi it
 * comes back well under 100 ms for a 12×18 board, so live updates feel
 * instant.
 */
export default function BoardPreview({
  config,
  designDataUrl, designOffsetXInches, designOffsetYInches,
  designWidthInches, designHeightInches,
  designRotationDegrees,
}: BoardPreviewProps) {
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boardPx, setBoardPx] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Re-render the board PNG when any feature changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    renderBoardWithFeatures(config).then(url => {
      if (!cancelled) { setBoardUrl(url); setLoading(false); }
    }).catch(err => {
      if (cancelled) return;
      // eslint-disable-next-line no-console
      console.error('Board render failed:', err);
      setBoardUrl(null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [config]);

  // Fit the board image to the wrapping container while preserving the
  // 12:18 (or whatever) aspect ratio. ResizeObserver handles container
  // size changes (window resize, sidebar collapse, etc).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const aspect = config.heightInches / config.widthInches;
    const update = () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const widthFromHeight  = rect.height / aspect;
      const heightFromWidth  = rect.width  * aspect;
      const fitWidth  = widthFromHeight  <= rect.width  ? widthFromHeight  : rect.width;
      const fitHeight = widthFromHeight  <= rect.width  ? rect.height      : heightFromWidth;
      setBoardPx({ width: fitWidth, height: fitHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [config.widthInches, config.heightInches]);

  const inchesToPx = boardPx.width / config.widthInches;

  return (
    <div ref={wrapRef} className="w-full h-full flex items-center justify-center bg-slate-950 rounded-lg">
      {loading && !boardUrl && (
        <p className="text-xs text-slate-400 animate-pulse">Rendering board…</p>
      )}
      {boardUrl && (
        <div
          className="relative shadow-xl"
          style={{ width: boardPx.width, height: boardPx.height }}
        >
          <img
            src={boardUrl}
            alt={`${config.wood} cutting board preview`}
            className="absolute inset-0 w-full h-full object-cover rounded select-none pointer-events-none"
            draggable={false}
          />
          {designDataUrl
            && designWidthInches !== undefined
            && designHeightInches !== undefined
            && designOffsetXInches !== undefined
            && designOffsetYInches !== undefined
            && inchesToPx > 0 && (() => {
              const rotation = designRotationDegrees ?? 0;
              const turned = (rotation % 180) !== 0;
              // designWidthInches/designHeightInches are the *visible*
              // AABB dims. The img element is sized to the *unrotated*
              // dims (swapped from visible for 90°/270°) so its layout
              // box matches the design's natural aspect, then rotated
              // via CSS so the visual exactly fills the visible AABB.
              const innerW = turned ? designHeightInches : designWidthInches;
              const innerH = turned ? designWidthInches  : designHeightInches;
              return (
                <div
                  className="absolute"
                  style={{
                    left:   `${designOffsetXInches * inchesToPx}px`,
                    top:    `${designOffsetYInches * inchesToPx}px`,
                    width:  `${designWidthInches  * inchesToPx}px`,
                    height: `${designHeightInches * inchesToPx}px`,
                  }}
                >
                  <img
                    src={designDataUrl}
                    alt="Design overlay"
                    className="absolute select-none pointer-events-none"
                    draggable={false}
                    style={{
                      left: '50%',
                      top:  '50%',
                      width:  `${innerW * inchesToPx}px`,
                      height: `${innerH * inchesToPx}px`,
                      // BoardPreview uses pixel dims so Tailwind's
                      // `max-width: 100%` rule generally doesn't bite,
                      // but be explicit anyway for parity with the
                      // other rotation-aware overlays.
                      maxWidth: 'none',
                      maxHeight: 'none',
                      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                      transformOrigin: 'center center',
                    }}
                  />
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}
