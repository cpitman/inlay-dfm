'use client';

import { useEffect, useRef, useState } from 'react';
import { useMagnifierActive } from './HoverMagnifier';

/**
 * Severity / source category for a flagged region. The badge color
 * matches the underlying overlay PNG band so the disc and the splash
 * agree at a glance.
 *
 * - `pocketIrreducible` (red): a feature inside an inlay shape is too
 *   narrow for any v-bit. Fix: widen the feature.
 * - `plugIrreducible` (yellow): the gap between two inlays is too
 *   narrow for any v-bit. Fix: move the inlays apart.
 * - `pocketSuggestion` (teal): widening this feature would enable a
 *   faster bit (cost optimization, not a hard error).
 * - `plugSuggestion` (cyan): widening this gap would enable a faster
 *   bit (cost optimization, not a hard error).
 *
 * Default `pocketIrreducible` for back-compat with callers that
 * predate the variant axis.
 */
export type IssueVariant =
  | 'pocketIrreducible'
  | 'plugIrreducible'
  | 'pocketSuggestion'
  | 'plugSuggestion';

interface MaskComponent {
  cx: number;
  cy: number;
  areaPx: number;
  variant?: IssueVariant;
}

const VARIANT_CLASS: Record<IssueVariant, string> = {
  pocketIrreducible: 'bg-red-500/90 hover:bg-red-400',
  plugIrreducible:   'bg-yellow-500/95 hover:bg-yellow-400 text-slate-900',
  pocketSuggestion:  'bg-teal-500/90 hover:bg-teal-400',
  plugSuggestion:    'bg-cyan-400/95 hover:bg-cyan-300 text-slate-900',
};

interface IssueLocatorBadgesProps {
  /** Centroids in source-canvas pixel coordinates. */
  components: readonly MaskComponent[];
  /** Width of the source coordinate space (canvas natural width). */
  sourceWidth: number;
  /** Height of the source coordinate space. */
  sourceHeight: number;
  /**
   * Optional: called with `{ x, y }` in *display* pixels (relative to
   * this component's bounding box) when the user hovers a badge.
   * Pairs with `<HoverMagnifier pinPosition={...}>` to focus the lens
   * on the badge's position. Called with `null` on mouse-leave.
   */
  onPin?: (pos: { x: number; y: number } | null) => void;
  /**
   * Skip badges for components above this fraction of the total
   * source area — those are big enough to spot without a marker, and
   * adding badges over large highlighted regions just clutters the
   * view. Default: 5% of total area.
   */
  largeAreaFraction?: number;
  /**
   * Cap on the number of badges shown. Designs with many small
   * problem regions can get unreadable; the smallest are the
   * easiest to miss, so we keep those and drop the rest. Default: 10.
   */
  maxBadges?: number;
}

/**
 * Renders numbered translucent discs at each problem-component
 * centroid, scaled into the parent's bounding box. Use this overlaid
 * directly on top of an analysis preview (canvas or `<img>` stack).
 *
 * The discs are absolutely-positioned in percent units so the badges
 * track the underlying image regardless of how it's CSS-scaled.
 */
export default function IssueLocatorBadges({
  components,
  sourceWidth,
  sourceHeight,
  onPin,
  largeAreaFraction = 0.05,
  maxBadges = 10,
}: IssueLocatorBadgesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);
  const magnifierActive = useMagnifierActive();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({ w: width, h: height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (sourceWidth === 0 || sourceHeight === 0 || magnifierActive) {
    // Yield to the magnifier lens — keep the ref'd container mounted so
    // the ResizeObserver doesn't unhook, but skip rendering the badges
    // themselves while the lens is visible.
    return <div ref={containerRef} className="absolute inset-0 pointer-events-none" />;
  }

  const totalAreaPx = sourceWidth * sourceHeight;
  const filtered = components.filter(c => c.areaPx / totalAreaPx <= largeAreaFraction);
  // Keep the smallest first — those are the ones most worth pointing
  // out — but renumber in display order (top-left to bottom-right) so
  // numbering stays intuitive.
  const limited = [...filtered]
    .sort((a, b) => a.areaPx - b.areaPx)
    .slice(0, maxBadges)
    .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ pointerEvents: 'none' }}
    >
      {limited.map((c, i) => {
        const xPct = (c.cx / sourceWidth)  * 100;
        const yPct = (c.cy / sourceHeight) * 100;
        return (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            aria-label={`Issue ${i + 1}`}
            className={`absolute -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full ring-2 ring-white text-white text-[10px] font-bold flex items-center justify-center shadow-md hover:scale-110 transition-transform ${VARIANT_CLASS[c.variant ?? 'pocketIrreducible']}`}
            style={{
              left:  `${xPct}%`,
              top:   `${yPct}%`,
              pointerEvents: 'auto',
            }}
            onMouseEnter={() => {
              if (!onPin || !containerSize) return;
              onPin({
                x: (c.cx / sourceWidth)  * containerSize.w,
                y: (c.cy / sourceHeight) * containerSize.h,
              });
            }}
            onMouseLeave={() => onPin?.(null)}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}
