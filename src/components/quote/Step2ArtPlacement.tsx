'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Design, Placement, RotationDegrees, WoodConfig } from '@/types';
import {
  effectivePlacementAabb, isQuarterTurn, rotateLeft, rotateRight,
} from '@/lib/rotation';
import type { BoardConfig } from '@/types/board';
import {
  hasTopGroove, hasBottomGroove,
  TOP_GROOVE_INLAY_MARGIN_INCHES, BOTTOM_GROOVE_INLAY_MARGIN_INCHES,
  feetAabbs, undersideHandleAabbs,
  type FeatureAabb,
} from '@/types/board';
import { renderBoardWithFeatures } from '@/lib/boardFeatures';
import { boxesOverlap, type AABB } from '@/lib/aabb';
import FileUpload from '../FileUpload';
import InlayColorPicker from './InlayColorPicker';
import BoardFlipView from '../BoardFlipView';
import { StepNav } from '../StepperBar';

// Re-export so existing imports of `Placement` from this module keep working.
export type { Placement };

interface Step2ArtPlacementProps {
  boardConfig: BoardConfig;
  designs: Design[];
  /** Per-design composite PNG dataURL, keyed by design id. */
  compositeUrls: Map<string, string>;
  parsing: boolean;
  errorMsg: string;
  /** True when at least one design overlaps another design or a fixed
   *  back-side feature. Disables Next + shows banner. */
  overlapping: boolean;
  /** Which face the user is currently viewing. New uploads go here. */
  currentSide: 'top' | 'bottom';
  onChangeSide: (next: 'top' | 'bottom') => void;
  onAddDesign: (file: File) => void;
  onRemoveDesign: (id: string) => void;
  onUpdateDesignPlacement: (id: string, next: Placement) => void;
  onUpdateDesignWoodConfig: (designId: string, colorHex: string, patch: Partial<WoodConfig>) => void;
  /** Open the text-design dialog in "create" mode. */
  onRequestAddText: () => void;
  /** Open the text-design dialog in "edit" mode for the given design. */
  onRequestEditText: (designId: string) => void;
  /** Open the clipart picker. */
  onRequestAddClipart: () => void;
  onBack: () => void;
  onNext: () => void;
  canAdvance: boolean;
}

const MIN_DESIGN_WIDTH_INCHES = 0.25;
type DragMode = 'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br';

interface DragStart {
  mouseX: number;
  mouseY: number;
  offsetX: number;
  offsetY: number;
  designWidth: number;
  mode: DragMode;
  designId: string;
}

/** AABB derived from a placement + the design's natural dimensions. */
function aabbFromPlacement(p: Placement, naturalW: number, naturalH: number): AABB {
  return effectivePlacementAabb(p, naturalW, naturalH);
}

/**
 * Step 2 of the guided quote experience. The user uploads one or more
 * designs and places each on the board. Each design has its own
 * color→wood mapping and lives on either the top or bottom face. Two
 * designs on the SAME side cannot overlap; touching is allowed.
 * Back-side designs additionally cannot overlap fixed features (feet,
 * underside handle pockets).
 *
 * Layout: a left-side card list (filtered to the current side) + a
 * right-side board preview that flips between front and back via a 3D
 * card-flip animation.
 */
export default function Step2ArtPlacement(props: Step2ArtPlacementProps) {
  const {
    boardConfig, designs, compositeUrls, parsing, errorMsg, overlapping,
    currentSide, onChangeSide,
    onAddDesign, onRemoveDesign, onUpdateDesignPlacement, onUpdateDesignWoodConfig,
    onRequestAddText, onRequestEditText, onRequestAddClipart,
    onBack, onNext, canAdvance,
  } = props;

  // Per-side placeable rect — depends on which side's groove is in play.
  const grooveOnSide = currentSide === 'top'
    ? hasTopGroove(boardConfig.juiceGroove)
    : hasBottomGroove(boardConfig.juiceGroove);
  const margin = grooveOnSide
    ? (currentSide === 'top' ? TOP_GROOVE_INLAY_MARGIN_INCHES : BOTTOM_GROOVE_INLAY_MARGIN_INCHES)
    : 0;
  const placeableW = boardConfig.widthInches  - 2 * margin;
  const placeableH = boardConfig.heightInches - 2 * margin;

  // Fixed-feature AABBs the active side's designs must avoid (back side
  // only — feet + underside handles).
  const sideFixedFeatures: FeatureAabb[] = useMemo(
    () => currentSide === 'bottom'
      ? [...feetAabbs(boardConfig), ...undersideHandleAabbs(boardConfig)]
      : [],
    [currentSide, boardConfig],
  );

  // Designs filtered to the active side — these are the only ones the
  // card list renders + the only ones the active face shows.
  const sideDesigns = useMemo(
    () => designs.filter(d => d.side === currentSide),
    [designs, currentSide],
  );

  // Per-design original-colors data URLs. Used as a thumbnail above
  // each design's wood-picker so the user can correlate detected
  // colors to design regions. Computed once per design (svgString is
  // immutable post-parse) — keyed by design id.
  const originalSvgUrls = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of designs) {
      // Encode the SVG text as a data URL. encodeURIComponent handles
      // any non-ASCII / reserved chars in the SVG.
      m.set(d.id, `data:image/svg+xml;utf8,${encodeURIComponent(d.vector.svgString)}`);
    }
    return m;
  }, [designs]);

  // Which color (per design) is currently being interacted with in
  // its wood-picker. Drives the outline highlight overlay in the
  // larger preview so the user can see which region a row maps to.
  const [focusedColor, setFocusedColor] = useState<Record<string, string | null>>({});
  const onFocusColor = useCallback((designId: string, colorHex: string | null) => {
    setFocusedColor(prev => {
      if (prev[designId] === colorHex) return prev;
      return { ...prev, [designId]: colorHex };
    });
  }, []);

  // Drag state — at most one design is dragged at a time.
  const [drag, setDrag] = useState<{ designId: string; placement: Placement; overlapping: boolean } | null>(null);
  const dragStart = useRef<DragStart | null>(null);

  // Render the board PNGs (front + back) so we can position the
  // designs over them. Two faces, two PNGs.
  const [topBoardUrl,    setTopBoardUrl]    = useState<string | null>(null);
  const [bottomBoardUrl, setBottomBoardUrl] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardPx, setBoardPx] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      renderBoardWithFeatures(boardConfig, 100, 'top'),
      renderBoardWithFeatures(boardConfig, 100, 'bottom'),
    ]).then(([top, bottom]) => {
      if (cancelled) return;
      setTopBoardUrl(top);
      setBottomBoardUrl(bottom);
    }).catch(() => { /* surfaced elsewhere */ });
    return () => { cancelled = true; };
  }, [boardConfig]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const a = boardConfig.heightInches / boardConfig.widthInches;
    const update = () => {
      const r = wrap.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const widthFromHeight = r.height / a;
      const heightFromWidth = r.width  * a;
      const fitW = widthFromHeight  <= r.width  ? widthFromHeight  : r.width;
      const fitH = widthFromHeight  <= r.width  ? r.height         : heightFromWidth;
      setBoardPx({ width: fitW, height: fitH });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [boardConfig.widthInches, boardConfig.heightInches]);

  // Clamp a placement to the placeable rectangle (margin band) using the
  // *visible* AABB (rotation-aware). designWidthInches is the unrotated
  // horizontal extent; for 90°/270° the visible width and height swap.
  const clampToPlaceable = useCallback((next: Placement, aspect: number): Placement => {
    const turned = isQuarterTurn(next.rotationDegrees);
    // The visible AABB's max dimensions are the placeable rect itself.
    // Translate back to designWidth: visW = (turned ? designW*aspect : designW).
    const maxVisW = placeableW;
    const maxVisH = placeableH;
    const maxDesignW = turned
      ? Math.min(maxVisW / aspect, maxVisH)        // visW = dw*aspect ≤ pW;  visH = dw ≤ pH
      : Math.min(maxVisW,          maxVisH / aspect); // visW = dw ≤ pW;       visH = dw*aspect ≤ pH
    const minW = Math.min(MIN_DESIGN_WIDTH_INCHES, maxDesignW);
    const dw = Math.max(minW, Math.min(next.designWidthInches, maxDesignW));
    const visW = turned ? dw * aspect : dw;
    const visH = turned ? dw          : dw * aspect;
    const ox = Math.max(margin, Math.min(next.offsetXInches, margin + placeableW - visW));
    const oy = Math.max(margin, Math.min(next.offsetYInches, margin + placeableH - visH));
    return {
      offsetXInches: ox,
      offsetYInches: oy,
      designWidthInches: dw,
      ...(next.rotationDegrees !== undefined ? { rotationDegrees: next.rotationDegrees } : {}),
    };
  }, [margin, placeableW, placeableH]);

  // Re-clamp every design's placement on its OWN side when that side's
  // placeable area changes (groove toggled, etc.). Top-side margin
  // changes only re-clamp top designs and vice versa.
  useEffect(() => {
    for (const d of designs) {
      const sideMargin = d.side === 'top'
        ? (hasTopGroove(boardConfig.juiceGroove)    ? TOP_GROOVE_INLAY_MARGIN_INCHES    : 0)
        : (hasBottomGroove(boardConfig.juiceGroove) ? BOTTOM_GROOVE_INLAY_MARGIN_INCHES : 0);
      const sidePlaceableW = boardConfig.widthInches  - 2 * sideMargin;
      const sidePlaceableH = boardConfig.heightInches - 2 * sideMargin;
      const aspect = d.vector.naturalHeight / d.vector.naturalWidth;
      const turned = isQuarterTurn(d.placement.rotationDegrees);
      const maxDesignW = turned
        ? Math.min(sidePlaceableW / aspect, sidePlaceableH)
        : Math.min(sidePlaceableW,          sidePlaceableH / aspect);
      const minW = Math.min(MIN_DESIGN_WIDTH_INCHES, maxDesignW);
      const dw = Math.max(minW, Math.min(d.placement.designWidthInches, maxDesignW));
      const visW = turned ? dw * aspect : dw;
      const visH = turned ? dw          : dw * aspect;
      const ox = Math.max(sideMargin, Math.min(d.placement.offsetXInches, sideMargin + sidePlaceableW - visW));
      const oy = Math.max(sideMargin, Math.min(d.placement.offsetYInches, sideMargin + sidePlaceableH - visH));
      if (ox !== d.placement.offsetXInches || oy !== d.placement.offsetYInches || dw !== d.placement.designWidthInches) {
        onUpdateDesignPlacement(d.id, {
          offsetXInches: ox,
          offsetYInches: oy,
          designWidthInches: dw,
          ...(d.placement.rotationDegrees !== undefined ? { rotationDegrees: d.placement.rotationDegrees } : {}),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardConfig.juiceGroove, boardConfig.widthInches, boardConfig.heightInches]);

  // Begin a drag for the given design.
  const handleMouseDown = useCallback(
    (designId: string, mode: DragMode) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const d = designs.find(x => x.id === designId);
      if (!d) return;
      dragStart.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        offsetX: d.placement.offsetXInches,
        offsetY: d.placement.offsetYInches,
        designWidth: d.placement.designWidthInches,
        mode,
        designId,
      };
      setDrag({ designId, placement: { ...d.placement }, overlapping: false });
    }, [designs]);

  // Global mouse listeners while dragging.
  useEffect(() => {
    if (!drag) return;
    const dragged = designs.find(d => d.id === drag.designId);
    if (!dragged) return;
    const aspect = dragged.vector.naturalHeight / dragged.vector.naturalWidth;
    const rotation = dragged.placement.rotationDegrees;
    const turned = isQuarterTurn(rotation);
    // Only same-side designs are "others" for collision purposes.
    const others: AABB[] = designs
      .filter(d => d.id !== drag.designId && d.side === dragged.side)
      .map(d => aabbFromPlacement(d.placement, d.vector.naturalWidth, d.vector.naturalHeight));
    // On the back side, fixed features (feet + handles) also count.
    const fixed: AABB[] = dragged.side === 'bottom' ? sideFixedFeatures : [];
    const obstacles: AABB[] = [...others, ...fixed];

    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      const container = containerRef.current;
      if (!start || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dxInches = ((e.clientX - start.mouseX) / rect.width)  * boardConfig.widthInches;
      const dyInches = ((e.clientY - start.mouseY) / rect.height) * boardConfig.heightInches;

      // Resize handles operate on the visible AABB. Translate visW/H ↔
      // designWidth via the aspect (designH = designW × aspect; for 90°/
      // 270° the visible axes are swapped). Drag handle anchors the
      // *opposite* corner of the visible AABB.
      const startVisW = turned ? start.designWidth * aspect : start.designWidth;
      const startVisH = turned ? start.designWidth          : start.designWidth * aspect;
      const visToDesignW = (vw: number) => (turned ? vw / aspect : vw);

      const next = { offsetX: start.offsetX, offsetY: start.offsetY, dw: start.designWidth };
      switch (start.mode) {
        case 'move':
          next.offsetX = start.offsetX + dxInches;
          next.offsetY = start.offsetY + dyInches;
          break;
        case 'resize-br': {
          const newVisW = startVisW + dxInches;
          next.dw = visToDesignW(newVisW);
          break;
        }
        case 'resize-bl': {
          const fixedRight = start.offsetX + startVisW;
          const newVisW = startVisW - dxInches;
          next.dw = visToDesignW(newVisW);
          next.offsetX = fixedRight - newVisW;
          break;
        }
        case 'resize-tr': {
          const fixedBottom = start.offsetY + startVisH;
          const newVisW = startVisW + dxInches;
          next.dw = visToDesignW(newVisW);
          const newVisH = turned ? newVisW : newVisW * aspect;
          next.offsetY = fixedBottom - newVisH;
          break;
        }
        case 'resize-tl': {
          const fixedRight  = start.offsetX + startVisW;
          const fixedBottom = start.offsetY + startVisH;
          const newVisW = startVisW - dxInches;
          next.dw = visToDesignW(newVisW);
          const newVisH = turned ? newVisW : newVisW * aspect;
          next.offsetX = fixedRight  - newVisW;
          next.offsetY = fixedBottom - newVisH;
          break;
        }
      }
      const clamped = clampToPlaceable({
        offsetXInches: next.offsetX,
        offsetYInches: next.offsetY,
        designWidthInches: next.dw,
        ...(rotation !== undefined ? { rotationDegrees: rotation } : {}),
      }, aspect);
      const candidate = aabbFromPlacement(clamped, dragged.vector.naturalWidth, dragged.vector.naturalHeight);
      const overlaps = obstacles.some(o => boxesOverlap(candidate, o));
      setDrag({ designId: drag.designId, placement: clamped, overlapping: overlaps });
    };

    const onUp = () => {
      const final = drag;
      dragStart.current = null;
      setDrag(null);
      if (final && !final.overlapping) {
        onUpdateDesignPlacement(final.designId, final.placement);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [drag, designs, sideFixedFeatures, boardConfig.widthInches, boardConfig.heightInches, clampToPlaceable, onUpdateDesignPlacement]);

  const pctX = (inches: number) => `${(inches / boardConfig.widthInches)  * 100}%`;
  const pctY = (inches: number) => `${(inches / boardConfig.heightInches) * 100}%`;

  // Rotate around the design's center: keep the visible AABB's center
  // pinned and recompute the new top-left from the new visible
  // dimensions, then clamp to the placeable area. Re-clamp may shift
  // the design if rotation pushes a long axis past a board edge.
  const commitRotation = useCallback((d: Design, next: RotationDegrees) => {
    const aspect = d.vector.naturalHeight / d.vector.naturalWidth;
    const oldTurned = isQuarterTurn(d.placement.rotationDegrees);
    const newTurned = isQuarterTurn(next);
    const oldVisW = oldTurned ? d.placement.designWidthInches * aspect : d.placement.designWidthInches;
    const oldVisH = oldTurned ? d.placement.designWidthInches          : d.placement.designWidthInches * aspect;
    const newVisW = newTurned ? d.placement.designWidthInches * aspect : d.placement.designWidthInches;
    const newVisH = newTurned ? d.placement.designWidthInches          : d.placement.designWidthInches * aspect;
    const cx = d.placement.offsetXInches + oldVisW / 2;
    const cy = d.placement.offsetYInches + oldVisH / 2;
    const candidate: Placement = {
      offsetXInches: cx - newVisW / 2,
      offsetYInches: cy - newVisH / 2,
      designWidthInches: d.placement.designWidthInches,
      rotationDegrees: next,
    };
    onUpdateDesignPlacement(d.id, clampToPlaceable(candidate, aspect));
  }, [clampToPlaceable, onUpdateDesignPlacement]);

  // For each design on the active side, compute the live placement
  // (drag override or committed). Other-side designs render in the
  // hidden face exactly at their committed placements.
  const renderableDesignsForSide = (side: 'top' | 'bottom') =>
    designs
      .filter(d => d.side === side)
      .map(d => {
        if (drag && drag.designId === d.id) {
          return { d, placement: drag.placement, isDragOverlapping: drag.overlapping };
        }
        return { d, placement: d.placement, isDragOverlapping: false };
      });

  // One face's content. Wrapped in a function so the same JSX runs for
  // both sides with their own boardUrl + design list.
  const renderFace = (side: 'top' | 'bottom') => {
    const boardUrl = side === 'top' ? topBoardUrl : bottomBoardUrl;
    const placedDesigns = renderableDesignsForSide(side);
    const isActive = side === currentSide;
    return boardUrl ? (
      <div
        ref={isActive ? containerRef : undefined}
        className="relative shadow-xl w-full h-full"
      >
        <img
          src={boardUrl}
          alt={`${boardConfig.wood} board ${side === 'top' ? 'front' : 'back'}`}
          className="absolute inset-0 w-full h-full object-cover rounded select-none pointer-events-none"
          draggable={false}
        />
        {placedDesigns.map(({ d, placement, isDragOverlapping }) => {
          const aspect = d.vector.naturalHeight / d.vector.naturalWidth;
          const compositeUrl = compositeUrls.get(d.id);
          if (!compositeUrl) return null;
          const rotation = placement.rotationDegrees ?? 0;
          const turned = isQuarterTurn(rotation);
          // Outer container = visible AABB on the board. Inner img is
          // sized to the *unrotated* dimensions, centered in the
          // container, and rotated via CSS transform — so the rotation
          // doesn't stretch the image content.
          const visW = turned ? placement.designWidthInches * aspect : placement.designWidthInches;
          const visH = turned ? placement.designWidthInches          : placement.designWidthInches * aspect;
          const innerWidthPct  = turned ? 100 / aspect : 100;
          const innerHeightPct = turned ? 100 * aspect : 100;
          const ringClass = isDragOverlapping ? 'outline outline-2 outline-red-500' : '';
          return (
            <div
              key={d.id}
              className="absolute"
              style={{
                left:   pctX(placement.offsetXInches),
                top:    pctY(placement.offsetYInches),
                width:  pctX(visW),
                height: pctY(visH),
              }}
            >
              <img
                src={compositeUrl}
                alt={`Design ${d.vector.fileName}`}
                className={`absolute select-none ${drag?.designId === d.id ? 'cursor-grabbing' : 'cursor-move'} ${ringClass}`}
                style={{
                  left: '50%',
                  top:  '50%',
                  width:  `${innerWidthPct}%`,
                  height: `${innerHeightPct}%`,
                  // Tailwind's preflight applies `max-width: 100%` to
                  // every <img>; without this override the 200% inner
                  // width on a quarter-turned wide design would clamp,
                  // squashing the image into a too-narrow layout box.
                  maxWidth: 'none',
                  maxHeight: 'none',
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  transformOrigin: 'center center',
                  outlineOffset: isDragOverlapping ? '0' : undefined,
                }}
                draggable={false}
                onMouseDown={isActive ? handleMouseDown(d.id, 'move') : undefined}
              />
              {focusedColor[d.id] && (() => {
                const layer = d.vector.layers.find(l => l.colorHex === focusedColor[d.id]);
                if (!layer) return null;
                // Stroke-only render of the focused color's geometry,
                // overlaid on the composite. The CSS is scoped to a
                // unique class so it doesn't leak to other SVGs on the
                // page (inline SVG `<style>` matches against the whole
                // document — without scoping, the FileUpload icon and
                // any other SVGs would also fill: none + paint amber).
                // Stroke kept thin (1.5 px) so it doesn't visually
                // mask wood-color changes happening underneath.
                const html =
                  `<style>.icp-outline-highlight * { fill: none !important; stroke: #fbbf24; stroke-width: 1.5; vector-effect: non-scaling-stroke; }</style>` +
                  `<g class="icp-outline-highlight">${layer.svgFragment}</g>`;
                return (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox={d.vector.viewBox}
                    preserveAspectRatio="none"
                    className="absolute pointer-events-none"
                    style={{
                      left: '50%', top: '50%',
                      width:  `${innerWidthPct}%`,
                      height: `${innerHeightPct}%`,
                      maxWidth: 'none', maxHeight: 'none',
                      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                      transformOrigin: 'center center',
                      overflow: 'visible',
                      filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.8))',
                    }}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                );
              })()}
              {isActive && (['resize-tl', 'resize-tr', 'resize-bl', 'resize-br'] as DragMode[]).map(mode => {
                const top    = mode === 'resize-tl' || mode === 'resize-tr' ? '-5px' : 'auto';
                const bottom = mode === 'resize-bl' || mode === 'resize-br' ? '-5px' : 'auto';
                const left   = mode === 'resize-tl' || mode === 'resize-bl' ? '-5px' : 'auto';
                const right  = mode === 'resize-tr' || mode === 'resize-br' ? '-5px' : 'auto';
                const cursor = (mode === 'resize-tl' || mode === 'resize-br') ? 'nwse-resize' : 'nesw-resize';
                return (
                  <div
                    key={mode}
                    onMouseDown={handleMouseDown(d.id, mode)}
                    style={{ top, bottom, left, right, cursor, position: 'absolute', width: 10, height: 10, background: 'rgba(96,165,250,0.9)', border: '1px solid white', borderRadius: 2 }}
                    aria-label={`Resize ${d.vector.fileName} from ${mode.replace('resize-', '')}`}
                  />
                );
              })}
              {isActive && (
                <RotateToolbar
                  rotation={rotation}
                  onRotate={(next) => commitRotation(d, next)}
                  onReset={rotation === 0 ? undefined : () => commitRotation(d, 0)}
                />
              )}
            </div>
          );
        })}
      </div>
    ) : null;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-6 flex-1 min-h-0">
        {/* Left column: design list + add */}
        <div className="space-y-4 overflow-y-auto pr-2 min-h-0">
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Designs ({currentSide === 'top' ? 'front' : 'back'})
              </h2>
              <span className="text-[11px] text-slate-500">{sideDesigns.length} placed</span>
            </div>

            {sideDesigns.length === 0 && (
              <div className="space-y-2">
                <FileUpload onFile={onAddDesign} fileName={undefined} />
                <button
                  type="button"
                  onClick={onRequestAddText}
                  className="w-full px-3 py-2 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                >+ Add text</button>
                <button
                  type="button"
                  onClick={onRequestAddClipart}
                  className="w-full px-3 py-2 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                >+ Add clipart</button>
              </div>
            )}

            <div className="space-y-3">
              {sideDesigns.map(d => (
                <DesignCard
                  key={d.id}
                  design={d}
                  originalSvgUrl={originalSvgUrls.get(d.id)}
                  onRemove={() => onRemoveDesign(d.id)}
                  onUpdateWoodConfig={(colorHex, patch) => onUpdateDesignWoodConfig(d.id, colorHex, patch)}
                  onEditText={d.textSpec ? () => onRequestEditText(d.id) : undefined}
                  onFocusColor={hex => onFocusColor(d.id, hex)}
                />
              ))}
            </div>

            {sideDesigns.length > 0 && (
              <div className="mt-3 space-y-2">
                <FileUpload onFile={onAddDesign} fileName={undefined} />
                <button
                  type="button"
                  onClick={onRequestAddText}
                  className="w-full px-3 py-2 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                >+ Add text</button>
                <button
                  type="button"
                  onClick={onRequestAddClipart}
                  className="w-full px-3 py-2 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                >+ Add clipart</button>
              </div>
            )}

            {parsing && (
              <p className="text-xs text-slate-400 mt-2 text-center animate-pulse">Parsing file…</p>
            )}
            {errorMsg && (
              <p className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded p-2 mt-2">{errorMsg}</p>
            )}
            {overlapping && (
              <p className="text-xs text-amber-200 bg-amber-900/30 border border-amber-800 rounded p-2 mt-2">
                Some designs overlap each other or a back-side feature (feet / handle pocket). Drag them apart so the bounding boxes don't intersect — touching is fine.
              </p>
            )}
          </section>

          {sideDesigns.length > 0 && (
            <p className="text-[11px] text-slate-500">
              Drag any design to reposition or pull a corner to scale (aspect locked).
              Designs can't overlap; you'll see a red ring while dragging if they would.
              Use the flip control on the right to add designs to the {currentSide === 'top' ? 'back' : 'front'}.
            </p>
          )}
        </div>

        {/* Preview column */}
        <div ref={wrapRef} className="min-h-0 flex items-center justify-center bg-slate-950 rounded-lg">
          {boardPx.width > 0 && boardPx.height > 0 && (topBoardUrl || bottomBoardUrl) && (
            <BoardFlipView
              side={currentSide}
              onFlip={onChangeSide}
              flipDisabled={drag !== null}
              width={boardPx.width}
              height={boardPx.height}
              faces={{ top: renderFace('top'), bottom: renderFace('bottom') }}
            />
          )}
        </div>
      </div>

      <StepNav
        currentStep={2}
        canAdvance={canAdvance}
        nextLabel="Get my quote →"
        totalSteps={3}
        onBack={onBack}
        onNext={onNext}
      />
    </div>
  );
}

/**
 * One card in the design list — shows the filename, color→wood
 * mapping, and a remove button. Position/scale lives in the board
 * preview's drag handles, not here.
 */
function DesignCard({
  design,
  originalSvgUrl,
  onRemove,
  onUpdateWoodConfig,
  onEditText,
  onFocusColor,
}: {
  design: Design;
  /** Data URL of the design's original-colors SVG, for the wood-picker
   *  thumbnail. Skipped for text designs (single-color, no thumbnail
   *  needed). */
  originalSvgUrl?: string;
  onRemove: () => void;
  onUpdateWoodConfig: (colorHex: string, patch: Partial<WoodConfig>) => void;
  /** Defined for text designs only — opens the edit dialog. */
  onEditText?: () => void;
  /** Called when a wood-picker row is hovered/focused. */
  onFocusColor?: (colorHex: string | null) => void;
}) {
  const isTextDesign = !!design.textSpec;
  const displayName = isTextDesign && design.textSpec
    ? `“${design.textSpec.content}”`
    : design.vector.fileName;
  return (
    <div className="border border-slate-700 rounded-lg p-3 bg-slate-800/40 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-200 truncate" title={displayName}>
          {displayName}
        </p>
        <div className="shrink-0 flex items-center gap-1">
          {onEditText && (
            <button
              onClick={onEditText}
              className="text-xs px-2 py-1 rounded text-slate-300 hover:text-white hover:bg-slate-700 border border-slate-600"
              title="Edit text"
            >Edit</button>
          )}
          <button
            onClick={onRemove}
            className="w-6 h-6 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-lg leading-none"
            aria-label={`Remove ${displayName}`}
            title="Remove design"
          >×</button>
        </div>
      </div>
      {!isTextDesign && (
        <InlayColorPicker
          woodConfigs={design.woodConfigs}
          onUpdate={onUpdateWoodConfig}
          originalSvgUrl={originalSvgUrl}
          thumbnailAspect={design.vector.naturalWidth / design.vector.naturalHeight}
          onFocusColor={onFocusColor}
        />
      )}
      {isTextDesign && design.textSpec && (
        <p className="text-[11px] text-slate-500">
          {design.textSpec.fontFamily} · {design.textSpec.fontStyle} · {design.woodConfigs[0]?.label ?? '—'}
        </p>
      )}
    </div>
  );
}

/**
 * Floating toolbar attached to the bottom-right of an active design's
 * visible AABB. Rotate-left, rotate-right, and an optional reset
 * button (shown only when the design has a non-zero rotation).
 *
 * Shared between the guided and expert flows — see CompositeView.
 */
export function RotateToolbar({
  rotation,
  onRotate,
  onReset,
}: {
  rotation: RotationDegrees;
  onRotate: (next: RotationDegrees) => void;
  onReset?: () => void;
}) {
  return (
    <div
      className="absolute flex gap-1"
      style={{ right: 0, top: '-32px' }}
      onMouseDown={(e) => { e.stopPropagation(); }}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRotate(rotateLeft(rotation)); }}
        className="w-7 h-7 rounded bg-slate-700/90 hover:bg-slate-600 text-slate-100 text-base flex items-center justify-center border border-slate-500 shadow"
        title="Rotate 90° counter-clockwise"
        aria-label="Rotate 90° counter-clockwise"
      >↺</button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRotate(rotateRight(rotation)); }}
        className="w-7 h-7 rounded bg-slate-700/90 hover:bg-slate-600 text-slate-100 text-base flex items-center justify-center border border-slate-500 shadow"
        title="Rotate 90° clockwise"
        aria-label="Rotate 90° clockwise"
      >↻</button>
      {onReset && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          className="h-7 px-2 rounded bg-slate-700/90 hover:bg-slate-600 text-slate-100 text-xs flex items-center justify-center border border-slate-500 shadow"
          title="Reset rotation to 0°"
          aria-label="Reset rotation"
        >0°</button>
      )}
    </div>
  );
}
