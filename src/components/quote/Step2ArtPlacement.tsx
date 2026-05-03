'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Design, Placement, WoodConfig } from '@/types';
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

/** AABB derived from a placement + design aspect. */
function aabbFromPlacement(p: Placement, aspect: number): AABB {
  return {
    x: p.offsetXInches,
    y: p.offsetYInches,
    w: p.designWidthInches,
    h: p.designWidthInches * aspect,
  };
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

  // Clamp a placement to the placeable rectangle (margin band) for a given aspect.
  const clampToPlaceable = useCallback((next: Placement, aspect: number): Placement => {
    const maxByX = placeableW;
    const maxByY = placeableH / aspect;
    const minW = Math.min(MIN_DESIGN_WIDTH_INCHES, maxByX, maxByY);
    const dw = Math.max(minW, Math.min(next.designWidthInches, maxByX, maxByY));
    const dh = dw * aspect;
    const ox = Math.max(margin, Math.min(next.offsetXInches, margin + placeableW - dw));
    const oy = Math.max(margin, Math.min(next.offsetYInches, margin + placeableH - dh));
    return { offsetXInches: ox, offsetYInches: oy, designWidthInches: dw };
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
      const maxByX = sidePlaceableW;
      const maxByY = sidePlaceableH / aspect;
      const minW = Math.min(MIN_DESIGN_WIDTH_INCHES, maxByX, maxByY);
      const dw = Math.max(minW, Math.min(d.placement.designWidthInches, maxByX, maxByY));
      const dh = dw * aspect;
      const ox = Math.max(sideMargin, Math.min(d.placement.offsetXInches, sideMargin + sidePlaceableW - dw));
      const oy = Math.max(sideMargin, Math.min(d.placement.offsetYInches, sideMargin + sidePlaceableH - dh));
      if (ox !== d.placement.offsetXInches || oy !== d.placement.offsetYInches || dw !== d.placement.designWidthInches) {
        onUpdateDesignPlacement(d.id, { offsetXInches: ox, offsetYInches: oy, designWidthInches: dw });
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
    // Only same-side designs are "others" for collision purposes.
    const others: AABB[] = designs
      .filter(d => d.id !== drag.designId && d.side === dragged.side)
      .map(d => aabbFromPlacement(d.placement, d.vector.naturalHeight / d.vector.naturalWidth));
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
      const startH = start.designWidth * aspect;

      const next = { offsetX: start.offsetX, offsetY: start.offsetY, dw: start.designWidth };
      switch (start.mode) {
        case 'move':
          next.offsetX = start.offsetX + dxInches;
          next.offsetY = start.offsetY + dyInches;
          break;
        case 'resize-br':
          next.dw = start.designWidth + dxInches;
          break;
        case 'resize-bl': {
          const fixedRight = start.offsetX + start.designWidth;
          next.dw = start.designWidth - dxInches;
          next.offsetX = fixedRight - next.dw;
          break;
        }
        case 'resize-tr': {
          const fixedBottom = start.offsetY + startH;
          next.dw = start.designWidth + dxInches;
          next.offsetY = fixedBottom - next.dw * aspect;
          break;
        }
        case 'resize-tl': {
          const fixedRight  = start.offsetX + start.designWidth;
          const fixedBottom = start.offsetY + startH;
          next.dw = start.designWidth - dxInches;
          next.offsetX = fixedRight  - next.dw;
          next.offsetY = fixedBottom - next.dw * aspect;
          break;
        }
      }
      const clamped = clampToPlaceable({
        offsetXInches: next.offsetX,
        offsetYInches: next.offsetY,
        designWidthInches: next.dw,
      }, aspect);
      const candidate = aabbFromPlacement(clamped, aspect);
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
          const designH = placement.designWidthInches * aspect;
          if (!compositeUrl) return null;
          const ringClass = isDragOverlapping ? 'outline outline-2 outline-red-500' : '';
          return (
            <div
              key={d.id}
              className="absolute"
              style={{
                left:   pctX(placement.offsetXInches),
                top:    pctY(placement.offsetYInches),
                width:  pctX(placement.designWidthInches),
                height: pctY(designH),
              }}
            >
              <img
                src={compositeUrl}
                alt={`Design ${d.vector.fileName}`}
                className={`absolute inset-0 w-full h-full select-none ${drag?.designId === d.id ? 'cursor-grabbing' : 'cursor-move'} ${ringClass}`}
                style={{ outlineOffset: isDragOverlapping ? '0' : undefined }}
                draggable={false}
                onMouseDown={isActive ? handleMouseDown(d.id, 'move') : undefined}
              />
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
              <FileUpload onFile={onAddDesign} fileName={undefined} />
            )}

            <div className="space-y-3">
              {sideDesigns.map(d => (
                <DesignCard
                  key={d.id}
                  design={d}
                  onRemove={() => onRemoveDesign(d.id)}
                  onUpdateWoodConfig={(colorHex, patch) => onUpdateDesignWoodConfig(d.id, colorHex, patch)}
                />
              ))}
            </div>

            {sideDesigns.length > 0 && (
              <div className="mt-3">
                <FileUpload onFile={onAddDesign} fileName={undefined} />
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
  onRemove,
  onUpdateWoodConfig,
}: {
  design: Design;
  onRemove: () => void;
  onUpdateWoodConfig: (colorHex: string, patch: Partial<WoodConfig>) => void;
}) {
  return (
    <div className="border border-slate-700 rounded-lg p-3 bg-slate-800/40 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-200 truncate" title={design.vector.fileName}>
          {design.vector.fileName}
        </p>
        <button
          onClick={onRemove}
          className="shrink-0 w-6 h-6 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-lg leading-none"
          aria-label={`Remove ${design.vector.fileName}`}
          title="Remove design"
        >×</button>
      </div>
      <InlayColorPicker
        woodConfigs={design.woodConfigs}
        onUpdate={onUpdateWoodConfig}
      />
    </div>
  );
}
