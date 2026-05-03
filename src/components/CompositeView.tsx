'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Placement, RotationDegrees, VectorData, WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from '@/lib/woodSpecies';
import { renderBoardSurface } from '@/lib/woodGrain';
import { isQuarterTurn } from '@/lib/rotation';
import { RotateToolbar } from './quote/Step2ArtPlacement';

/** A read-only ghost of another design painted under the active one. */
export interface OtherDesign {
  id: string;
  vector: VectorData;
  compositeUrl: string | null;
  placement: Placement;
}

interface CompositeViewProps {
  dataUrl: string | null;
  generating: boolean;
  woodConfigs: WoodConfig[];
  backgroundSpecies: WoodSpeciesKey;
  vector: VectorData | null;

  /** Board / placement settings (composite-view-only). */
  boardWidthInches: number;
  boardHeightInches: number;
  designWidthInches: number;
  designOffsetXInches: number;
  designOffsetYInches: number;
  /**
   * 90°-step rotation around the design's center. Default `0` when not
   * provided. Drag/resize and ghosts of other designs honor each
   * design's own rotation.
   */
  designRotationDegrees?: RotationDegrees;

  /**
   * Commit drag/resize back to settings. Called once at mouseup so an
   * in-progress drag doesn't trigger downstream invalidations on every
   * frame.
   */
  onCommitPlacement: (offsetX: number, offsetY: number, designWidth: number) => void;
  /** Commit a rotation change (separate from drag/resize). */
  onCommitRotation?: (next: RotationDegrees) => void;

  /**
   * Optional: other designs on the same board, rendered read-only at
   * their committed placements so the user can see the whole layout
   * while editing one design at a time. Active design is drawn on top
   * (last), gets the dashed outline + drag handles. Empty / undefined
   * is the single-design case.
   */
  otherDesigns?: OtherDesign[];
}

/** OBB-aware visible-AABB helpers, mirroring `lib/rotation.ts`. */
function visibleW(designWidth: number, aspect: number, rotation: RotationDegrees | undefined): number {
  return isQuarterTurn(rotation) ? designWidth * aspect : designWidth;
}
function visibleH(designWidth: number, aspect: number, rotation: RotationDegrees | undefined): number {
  return isQuarterTurn(rotation) ? designWidth          : designWidth * aspect;
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
}

interface DragLive {
  offsetX: number;
  offsetY: number;
  designWidth: number;
}

function Swatch({ hex, label }: { hex: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="w-5 h-5 rounded shrink-0 border border-slate-600"
        style={{ background: hex }}
      />
      <span className="text-slate-300">{label}</span>
    </div>
  );
}

export default function CompositeView({
  dataUrl, generating, woodConfigs, backgroundSpecies,
  vector,
  boardWidthInches, boardHeightInches, designWidthInches,
  designOffsetXInches, designOffsetYInches,
  designRotationDegrees,
  onCommitPlacement, onCommitRotation,
  otherDesigns = [],
}: CompositeViewProps) {
  const rotation = designRotationDegrees ?? 0;
  const turned = isQuarterTurn(rotation);
  const bg = WOOD_SPECIES[backgroundSpecies];
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<DragStart | null>(null);

  const [boardSurfaceUrl, setBoardSurfaceUrl] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragLive | null>(null);
  const [boardPx, setBoardPx] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Compute the largest board-aspect-ratio rectangle that fits inside the
  // wrapper element, so the composite view never overflows the viewport.
  // ResizeObserver keeps it correct on window/sidebar resizes.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const aspect = boardWidthInches / boardHeightInches;
      // Fit inside the wrap while preserving aspect: pick the smaller of
      // (rect.width, rect.height * aspect) for the board's display width.
      let w = rect.width, h = rect.height;
      if (w / h > aspect) {
        // Height-limited.
        w = h * aspect;
      } else {
        h = w / aspect;
      }
      // Round to whole pixels to avoid sub-pixel rendering glitches.
      setBoardPx({ width: Math.floor(w), height: Math.floor(h) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [boardWidthInches, boardHeightInches]);

  // Render the board's wood-grain surface once per (species, dimensions).
  useEffect(() => {
    let cancelled = false;
    renderBoardSurface(backgroundSpecies, boardWidthInches, boardHeightInches, 100)
      .then(url => { if (!cancelled) setBoardSurfaceUrl(url); })
      .catch(() => { if (!cancelled) setBoardSurfaceUrl(null); });
    return () => { cancelled = true; };
  }, [backgroundSpecies, boardWidthInches, boardHeightInches]);

  // Aspect of the loaded design (height/width). 1 if no vector.
  const aspect = vector ? vector.naturalHeight / vector.naturalWidth : 1;

  // Effective placement: drag state overrides committed settings during a
  // mousedown→mouseup interaction so the visual updates 60 Hz without
  // touching settings (which would invalidate analysis cache, etc.).
  const eff: DragLive = drag ?? {
    offsetX: designOffsetXInches,
    offsetY: designOffsetYInches,
    designWidth: designWidthInches,
  };
  const visW = visibleW(eff.designWidth, aspect, rotation);
  const visH = visibleH(eff.designWidth, aspect, rotation);

  // Strict-fit clamp: design must always sit fully inside the board.
  // Rotation swaps the visible-AABB axes, so the maximum design width
  // is reduced when the design is rotated to a quarter turn.
  const clampPlacement = useCallback((next: DragLive): DragLive => {
    const maxDesignW = turned
      ? Math.min(boardWidthInches  / aspect, boardHeightInches)
      : Math.min(boardWidthInches,           boardHeightInches / aspect);
    const minW = Math.min(MIN_DESIGN_WIDTH_INCHES, maxDesignW);
    const dw = Math.max(minW, Math.min(next.designWidth, maxDesignW));
    const vw = visibleW(dw, aspect, rotation);
    const vh = visibleH(dw, aspect, rotation);
    const ox = Math.max(0, Math.min(next.offsetX, boardWidthInches  - vw));
    const oy = Math.max(0, Math.min(next.offsetY, boardHeightInches - vh));
    return { offsetX: ox, offsetY: oy, designWidth: dw };
  }, [aspect, boardWidthInches, boardHeightInches, rotation, turned]);

  const handleMouseDown = useCallback((mode: DragMode) => (e: React.MouseEvent) => {
    if (!vector) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      offsetX: designOffsetXInches,
      offsetY: designOffsetYInches,
      designWidth: designWidthInches,
      mode,
    };
    setDrag({
      offsetX: designOffsetXInches,
      offsetY: designOffsetYInches,
      designWidth: designWidthInches,
    });
  }, [vector, designOffsetXInches, designOffsetYInches, designWidthInches]);

  // Global mouse listeners while dragging. Track starts in a ref so we can
  // read consistent baselines without recreating handlers each frame.
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      const container = containerRef.current;
      if (!start || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dxInches = ((e.clientX - start.mouseX) / rect.width)  * boardWidthInches;
      const dyInches = ((e.clientY - start.mouseY) / rect.height) * boardHeightInches;

      // Resize handles operate in *visible*-AABB space (the box the
      // user sees and drags). Translate visW ↔ designWidth via aspect
      // for 90°/270° rotations, and use visible H to anchor the
      // opposite-corner pivot for resize-tr / resize-tl.
      const startVisW = visibleW(start.designWidth, aspect, rotation);
      const startVisH = visibleH(start.designWidth, aspect, rotation);
      const visToDesignW = (vw: number) => (turned ? vw / aspect : vw);

      let next: DragLive = { ...start };
      switch (start.mode) {
        case 'move':
          next.offsetX = start.offsetX + dxInches;
          next.offsetY = start.offsetY + dyInches;
          break;
        case 'resize-br': {
          const newVisW = startVisW + dxInches;
          next.designWidth = visToDesignW(newVisW);
          break;
        }
        case 'resize-bl': {
          const fixedRight = start.offsetX + startVisW;
          const newVisW = startVisW - dxInches;
          next.designWidth = visToDesignW(newVisW);
          next.offsetX = fixedRight - newVisW;
          break;
        }
        case 'resize-tr': {
          const fixedBottom = start.offsetY + startVisH;
          const newVisW = startVisW + dxInches;
          next.designWidth = visToDesignW(newVisW);
          const newVisH = visibleH(next.designWidth, aspect, rotation);
          next.offsetY = fixedBottom - newVisH;
          break;
        }
        case 'resize-tl': {
          const fixedRight  = start.offsetX + startVisW;
          const fixedBottom = start.offsetY + startVisH;
          const newVisW = startVisW - dxInches;
          next.designWidth = visToDesignW(newVisW);
          const newVisH = visibleH(next.designWidth, aspect, rotation);
          next.offsetX = fixedRight  - newVisW;
          next.offsetY = fixedBottom - newVisH;
          break;
        }
      }
      setDrag(clampPlacement(next));
    };

    const onUp = () => {
      const final = drag;
      dragStart.current = null;
      setDrag(null);
      if (final) onCommitPlacement(final.offsetX, final.offsetY, final.designWidth);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [drag, aspect, boardWidthInches, boardHeightInches, rotation, turned, clampPlacement, onCommitPlacement]);

  // Conversions for inline styles — percentages of the board container.
  const pctX = (inches: number) => `${(inches / boardWidthInches)  * 100}%`;
  const pctY = (inches: number) => `${(inches / boardHeightInches) * 100}%`;

  return (
    <div className="flex flex-col h-full min-h-0 space-y-3">
      {/* Legend */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 bg-slate-800 rounded-lg px-4 py-3 shrink-0">
        <Swatch hex={bg.baseHex} label={`Board — ${bg.name} (${boardWidthInches}" × ${boardHeightInches}")`} />
        {woodConfigs.map((wc, i) => {
          const sp = WOOD_SPECIES[wc.species];
          return (
            <Swatch
              key={wc.colorHex}
              hex={sp.baseHex}
              label={`${i + 1}. ${wc.label} — ${sp.name}`}
            />
          );
        })}
      </div>

      {/* Hint */}
      <p className="text-xs text-slate-500 shrink-0">
        Drag the design to reposition it on the board, or pull a corner to scale it (aspect locked).
        Scaling updates the Design Width parameter in the sidebar.
        Current design: {visW.toFixed(2)}" × {visH.toFixed(2)}"{rotation !== 0 ? ` (rotated ${rotation}°)` : ''}.
      </p>

      {/* Board canvas — fills the remaining space, board itself fits inside while preserving aspect. */}
      <div
        ref={wrapRef}
        className="flex-1 min-h-0 flex items-center justify-center rounded-lg overflow-hidden border border-slate-700 bg-slate-900"
      >
        <div
          ref={containerRef}
          className="relative"
          style={{ width: boardPx.width, height: boardPx.height }}
        >
          {/* Board surface */}
          {boardSurfaceUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={boardSurfaceUrl}
              alt=""
              className="absolute inset-0 w-full h-full select-none pointer-events-none"
              draggable={false}
            />
          )}

          {/* Other (non-active) designs — read-only ghosts beneath the active one */}
          {otherDesigns.map(o => {
            if (!o.compositeUrl) return null;
            const aspectO = o.vector.naturalHeight / o.vector.naturalWidth;
            const oRotation = o.placement.rotationDegrees ?? 0;
            const oTurned = isQuarterTurn(oRotation);
            const oVisW = visibleW(o.placement.designWidthInches, aspectO, oRotation);
            const oVisH = visibleH(o.placement.designWidthInches, aspectO, oRotation);
            const oInnerW = oTurned ? 100 / aspectO : 100;
            const oInnerH = oTurned ? 100 * aspectO : 100;
            return (
              <div
                key={o.id}
                className="absolute pointer-events-none"
                style={{
                  left:   pctX(o.placement.offsetXInches),
                  top:    pctY(o.placement.offsetYInches),
                  width:  pctX(oVisW),
                  height: pctY(oVisH),
                  opacity: 0.55,
                }}
                title={o.vector.fileName}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={o.compositeUrl}
                  alt=""
                  className="absolute select-none"
                  style={{
                    left: '50%',
                    top:  '50%',
                    width:  `${oInnerW}%`,
                    height: `${oInnerH}%`,
                    // See note on the active design's img below — the
                    // inner width can exceed 100% on a quarter-turned
                    // wide design, so we have to defeat Tailwind's
                    // default `max-width: 100%` rule.
                    maxWidth: 'none',
                    maxHeight: 'none',
                    transform: `translate(-50%, -50%) rotate(${oRotation}deg)`,
                    transformOrigin: 'center center',
                    outline: '1px dotted rgba(148, 163, 184, 0.4)',
                  }}
                  draggable={false}
                />
              </div>
            );
          })}

          {/* Design composite — positioned and scaled */}
          {dataUrl && vector && (() => {
            const innerW = turned ? 100 / aspect : 100;
            const innerH = turned ? 100 * aspect : 100;
            return (
            <div
              className="absolute"
              style={{
                left:   pctX(eff.offsetX),
                top:    pctY(eff.offsetY),
                width:  pctX(visW),
                height: pctY(visH),
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={dataUrl}
                alt="Composite design preview"
                className={`absolute select-none ${drag === null ? 'cursor-move' : 'cursor-grabbing'}`}
                style={{
                  left: '50%',
                  top:  '50%',
                  width:  `${innerW}%`,
                  height: `${innerH}%`,
                  // Tailwind's preflight applies `max-width: 100%` to
                  // every <img>; without this override the 200% inner
                  // width on a quarter-turned wide design would clamp,
                  // squashing the image into a too-narrow layout box.
                  maxWidth: 'none',
                  maxHeight: 'none',
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  transformOrigin: 'center center',
                  outline: '1px dashed rgba(96, 165, 250, 0.55)',
                }}
                draggable={false}
                onMouseDown={handleMouseDown('move')}
              />
              {/* Corner resize handles — at corners of the *visible* AABB. */}
              {(
                [
                  ['resize-tl', '0 0 auto auto', 'nwse-resize'],
                  ['resize-tr', '0 0 auto auto', 'nesw-resize'],
                  ['resize-bl', '0 0 auto auto', 'nesw-resize'],
                  ['resize-br', '0 0 auto auto', 'nwse-resize'],
                ] as [DragMode, string, string][]
              ).map(([mode, , cursor]) => {
                const top    = mode === 'resize-tl' || mode === 'resize-tr' ? '-5px' : 'auto';
                const bottom = mode === 'resize-bl' || mode === 'resize-br' ? '-5px' : 'auto';
                const left   = mode === 'resize-tl' || mode === 'resize-bl' ? '-5px' : 'auto';
                const right  = mode === 'resize-tr' || mode === 'resize-br' ? '-5px' : 'auto';
                return (
                  <div
                    key={mode}
                    className="absolute w-2.5 h-2.5 bg-blue-500 border border-white rounded-sm hover:bg-blue-400"
                    style={{ top, bottom, left, right, cursor }}
                    onMouseDown={handleMouseDown(mode)}
                  />
                );
              })}
              {onCommitRotation && (
                <RotateToolbar
                  rotation={rotation}
                  onRotate={onCommitRotation}
                  onReset={rotation === 0 ? undefined : () => onCommitRotation(0)}
                />
              )}
            </div>
            );
          })()}

          {/* Generating overlay */}
          {generating && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/70 z-10">
              <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-slate-400">Rendering composite…</p>
            </div>
          )}

          {/* Empty state */}
          {!dataUrl && !generating && !vector && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              Upload a design to place it on the board
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
