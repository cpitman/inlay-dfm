'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * Provided by `<HoverMagnifier>`; consumed by overlay layers that
 * should yield to the lens (e.g. `<IssueLocatorBadges>`). When `true`,
 * the lens is currently visible — badges should hide so they don't
 * cover the very issue the magnifier is trying to reveal, and so the
 * cloned lens content (in DOM mode) doesn't show magnified badges
 * either.
 */
const MagnifierActiveContext = createContext<boolean>(false);

export function useMagnifierActive(): boolean {
  return useContext(MagnifierActiveContext);
}

interface HoverMagnifierProps {
  /**
   * In `canvas` mode, the lens samples pixels from this canvas via
   * `drawImage`, which gives a crisp full-resolution view regardless of
   * how the visible canvas is CSS-scaled. The wrapped child should be
   * the same canvas (or rendered from it) so the visible preview and the
   * lens stay consistent.
   *
   * Omit (or leave null) to use `dom` mode, where the children are
   * cloned into a circular clip and CSS-transformed for the magnified
   * view. Suitable for `<img>` stacks where there's no source canvas.
   */
  sourceCanvasRef?: RefObject<HTMLCanvasElement | null>;
  /** Magnification factor (default 3). Higher = tighter zoom. */
  zoom?: number;
  /** Lens diameter in pixels (default 160). */
  lensSize?: number;
  /**
   * Optional pinned focus position in display-pixel coordinates of the
   * children (i.e., relative to the bounding box of the wrapper). When
   * set, the lens stays at that position regardless of cursor location;
   * useful for "click a badge to focus the lens here." Cleared by
   * passing null.
   */
  pinPosition?: { x: number; y: number } | null;
  className?: string;
  children: ReactNode;
}

/**
 * Wrap an analysis preview to give the user a circular hover loupe.
 *
 * - **Canvas mode**: pass `sourceCanvasRef` pointing at the rendered
 *   `<canvas>`. The lens is its own canvas; on mouse move it samples
 *   the source via `drawImage`, so we get full-resolution pixels even
 *   when the visible canvas is CSS-scaled to fit a thumbnail.
 *
 * - **DOM mode**: omit `sourceCanvasRef`. The children are rendered
 *   twice — once as the visible preview, once cloned inside a circular
 *   clip-path with `transform: scale(zoom) translate(...)` chasing the
 *   cursor. The transform is updated imperatively (no React re-render
 *   per move event) for smooth tracking.
 *
 * Touch users see no lens; the parent should rely on
 * `<IssueLocatorBadges>` (always-visible) to surface flagged regions
 * for them.
 */
export default function HoverMagnifier({
  sourceCanvasRef,
  zoom = 3,
  lensSize = 160,
  pinPosition = null,
  className,
  children,
}: HoverMagnifierProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lensCanvasRef = useRef<HTMLCanvasElement>(null);
  const lensInnerRef  = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // Track the wrapper's pixel size so the cloned lens content (DOM mode)
  // can be sized to MATCH it, not the lens. If the inner div were 100%
  // of the lens (e.g. 180×180), `scale(zoom)` would only ever show the
  // top-left 180×180 of the actual content — that's the bug we're
  // working around here.
  const [wrapperSize, setWrapperSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setWrapperSize({ w: width, h: height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mode: 'canvas' | 'dom' = sourceCanvasRef ? 'canvas' : 'dom';

  // Decide which position drives the lens — pin (if set), else cursor.
  const focus = pinPosition ?? cursor;
  const visible = (hovering || pinPosition !== null) && focus !== null;

  // Canvas-mode redraw: sample the source canvas into the lens whenever
  // the focus point changes (or the source itself updates).
  useEffect(() => {
    if (mode !== 'canvas') return;
    if (!visible || !focus) return;
    const wrapper = wrapperRef.current;
    const lensCanvas = lensCanvasRef.current;
    const sourceCanvas = sourceCanvasRef?.current;
    if (!wrapper || !lensCanvas || !sourceCanvas) return;

    // Map the focus point (in wrapper-display pixels) to source canvas
    // pixels. `sourceCanvas.width/height` is the natural pixel grid;
    // its bounding rect is the on-screen rendered size.
    const srcRect = sourceCanvas.getBoundingClientRect();
    if (srcRect.width === 0 || srcRect.height === 0) return;
    const wrapRect = wrapper.getBoundingClientRect();
    // Convert focus from wrapper-relative to source-canvas-relative.
    const offsetX = srcRect.left - wrapRect.left;
    const offsetY = srcRect.top  - wrapRect.top;
    const focusInSrcDisplayX = focus.x - offsetX;
    const focusInSrcDisplayY = focus.y - offsetY;
    // Convert from source-display pixels to source natural pixels.
    const sxPerDispX = sourceCanvas.width  / srcRect.width;
    const syPerDispY = sourceCanvas.height / srcRect.height;
    const cx = focusInSrcDisplayX * sxPerDispX;
    const cy = focusInSrcDisplayY * syPerDispY;

    // We want a (lensSize / zoom) display-pixel window centered on the
    // cursor. Translate that to source-pixel sample dimensions.
    const sampleDisplayW = lensSize / zoom;
    const sampleDisplayH = lensSize / zoom;
    const sw = sampleDisplayW * sxPerDispX;
    const sh = sampleDisplayH * syPerDispY;
    const sx = cx - sw / 2;
    const sy = cy - sh / 2;

    // Render at devicePixelRatio for a crisp lens.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (lensCanvas.width  !== lensSize * dpr) lensCanvas.width  = lensSize * dpr;
    if (lensCanvas.height !== lensSize * dpr) lensCanvas.height = lensSize * dpr;
    const ctx = lensCanvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, lensCanvas.width, lensCanvas.height);
    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, lensCanvas.width, lensCanvas.height);
  }, [mode, sourceCanvasRef, focus, lensSize, zoom, visible]);

  // DOM-mode transform: imperative update on every move.
  useEffect(() => {
    if (mode !== 'dom') return;
    const inner = lensInnerRef.current;
    if (!inner || !focus) return;
    const tx = -focus.x * zoom + lensSize / 2;
    const ty = -focus.y * zoom + lensSize / 2;
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    inner.style.transformOrigin = '0 0';
  }, [mode, focus, lensSize, zoom]);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  // Lens position: clamp inside the wrapper so the loupe doesn't
  // "fall off" near the edges.
  let lensLeft = 0, lensTop = 0;
  if (visible && focus && wrapperRef.current) {
    const rect = wrapperRef.current.getBoundingClientRect();
    lensLeft = Math.max(0, Math.min(rect.width  - lensSize, focus.x - lensSize / 2));
    lensTop  = Math.max(0, Math.min(rect.height - lensSize, focus.y - lensSize / 2));
  }

  return (
    <div
      ref={wrapperRef}
      className={`relative ${className ?? ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onMouseMove={handleMouseMove}
    >
      <MagnifierActiveContext.Provider value={visible}>
        {children}
      </MagnifierActiveContext.Provider>

      {visible && (
        <div
          aria-hidden="true"
          className="absolute pointer-events-none rounded-full shadow-lg ring-2 ring-blue-400/70 bg-slate-900"
          style={{
            left: lensLeft,
            top: lensTop,
            width: lensSize,
            height: lensSize,
            overflow: 'hidden',
            // Native CSS clip for browsers that don't honor border-radius
            // on absolutely-positioned children of transformed parents.
            clipPath: `circle(${lensSize / 2}px at ${lensSize / 2}px ${lensSize / 2}px)`,
            zIndex: 30,
          }}
        >
          {mode === 'canvas' ? (
            <canvas
              ref={lensCanvasRef}
              style={{ width: lensSize, height: lensSize, display: 'block' }}
            />
          ) : (
            <div
              ref={lensInnerRef}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                // Size to the WRAPPER, not the lens — `scale(zoom)` is
                // applied to a copy of the full wrapper-content, which
                // the lens then circularly clips. 100% of the lens
                // would only show the top-left zoom-fraction of the
                // content.
                width: wrapperSize.w || undefined,
                height: wrapperSize.h || undefined,
                willChange: 'transform',
              }}
            >
              <MagnifierActiveContext.Provider value={true}>
                {children}
              </MagnifierActiveContext.Provider>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
