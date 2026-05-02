'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VectorData, WoodConfig } from '@/types';
import type { BoardConfig } from '@/types/board';
import { hasTopGroove, TOP_GROOVE_INLAY_MARGIN_INCHES } from '@/types/board';
import { renderBoardWithFeatures } from '@/lib/boardFeatures';
import FileUpload from '../FileUpload';
import InlayColorPicker from './InlayColorPicker';
import { StepNav } from '../StepperBar';

export interface Placement {
  offsetXInches: number;
  offsetYInches: number;
  designWidthInches: number;
}

interface Step2ArtPlacementProps {
  boardConfig: BoardConfig;
  vector: VectorData | null;
  parsing: boolean;
  errorMsg: string;
  onFile: (file: File) => void;
  woodConfigs: WoodConfig[];
  onUpdateWoodConfig: (colorHex: string, patch: Partial<WoodConfig>) => void;
  placement: Placement;
  onPlacementChange: (next: Placement) => void;
  designCompositeUrl: string | null;
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
}

/**
 * Step 2 of the guided quote experience. The user uploads their art and
 * places it on the board (drag, resize, auto-center) and assigns one of
 * the priced inlay species to each detected color.
 *
 * On upload the design is auto-fit to the largest size that lands inside
 * the placeable area (full board, minus a 1" margin around the perimeter
 * if a top juice groove is selected) and centered. The placeable area is
 * also enforced as a clamp during drag/resize.
 */
export default function Step2ArtPlacement(props: Step2ArtPlacementProps) {
  const {
    boardConfig, vector, parsing, errorMsg, onFile,
    woodConfigs, onUpdateWoodConfig,
    placement, onPlacementChange, designCompositeUrl,
    onBack, onNext, canAdvance,
  } = props;

  const margin = hasTopGroove(boardConfig.juiceGroove) ? TOP_GROOVE_INLAY_MARGIN_INCHES : 0;
  const placeableW = boardConfig.widthInches  - 2 * margin;
  const placeableH = boardConfig.heightInches - 2 * margin;

  const aspect = vector ? vector.naturalHeight / vector.naturalWidth : 1;

  // Effective placement: live drag overrides the committed placement so the
  // visual updates 60Hz without re-running effects.
  const [drag, setDrag] = useState<Placement | null>(null);
  const dragStart = useRef<DragStart | null>(null);
  const eff = drag ?? placement;
  const designHeight = eff.designWidthInches * aspect;

  // Fit-area clamp: design must sit inside the placeable rectangle (i.e.
  // inside the margin band when a top juice groove is selected).
  const clampPlacement = useCallback((next: Placement): Placement => {
    const maxByX = placeableW;
    const maxByY = placeableH / aspect;
    const minW = Math.min(MIN_DESIGN_WIDTH_INCHES, maxByX, maxByY);
    const dw = Math.max(minW, Math.min(next.designWidthInches, maxByX, maxByY));
    const dh = dw * aspect;
    const ox = Math.max(margin, Math.min(next.offsetXInches, margin + placeableW - dw));
    const oy = Math.max(margin, Math.min(next.offsetYInches, margin + placeableH - dh));
    return { offsetXInches: ox, offsetYInches: oy, designWidthInches: dw };
  }, [aspect, margin, placeableW, placeableH]);

  // Re-clamp when the placeable area shrinks (e.g., user toggled a top
  // groove on after placing the design).
  useEffect(() => {
    if (!vector) return;
    const c = clampPlacement(placement);
    if (c.offsetXInches !== placement.offsetXInches
     || c.offsetYInches !== placement.offsetYInches
     || c.designWidthInches !== placement.designWidthInches) {
      onPlacementChange(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vector, margin, placeableW, placeableH]);

  const handleMouseDown = useCallback((mode: DragMode) => (e: React.MouseEvent) => {
    if (!vector) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      offsetX: placement.offsetXInches,
      offsetY: placement.offsetYInches,
      designWidth: placement.designWidthInches,
      mode,
    };
    setDrag({ ...placement });
  }, [vector, placement]);

  // Global mouse listeners while dragging — same pattern as CompositeView.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      const container = containerRef.current;
      if (!start || !container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dxInches = ((e.clientX - start.mouseX) / rect.width)  * boardConfig.widthInches;
      const dyInches = ((e.clientY - start.mouseY) / rect.height) * boardConfig.heightInches;
      const startH = start.designWidth * aspect;

      let nextOff = { offsetX: start.offsetX, offsetY: start.offsetY, dw: start.designWidth };
      switch (start.mode) {
        case 'move':
          nextOff.offsetX = start.offsetX + dxInches;
          nextOff.offsetY = start.offsetY + dyInches;
          break;
        case 'resize-br':
          nextOff.dw = start.designWidth + dxInches;
          break;
        case 'resize-bl': {
          const fixedRight = start.offsetX + start.designWidth;
          nextOff.dw = start.designWidth - dxInches;
          nextOff.offsetX = fixedRight - nextOff.dw;
          break;
        }
        case 'resize-tr': {
          const fixedBottom = start.offsetY + startH;
          nextOff.dw = start.designWidth + dxInches;
          nextOff.offsetY = fixedBottom - nextOff.dw * aspect;
          break;
        }
        case 'resize-tl': {
          const fixedRight  = start.offsetX + start.designWidth;
          const fixedBottom = start.offsetY + startH;
          nextOff.dw = start.designWidth - dxInches;
          nextOff.offsetX = fixedRight  - nextOff.dw;
          nextOff.offsetY = fixedBottom - nextOff.dw * aspect;
          break;
        }
      }
      setDrag(clampPlacement({
        offsetXInches: nextOff.offsetX,
        offsetYInches: nextOff.offsetY,
        designWidthInches: nextOff.dw,
      }));
    };
    const onUp = () => {
      const final = drag;
      dragStart.current = null;
      setDrag(null);
      if (final) onPlacementChange(final);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [drag, aspect, boardConfig.widthInches, boardConfig.heightInches, clampPlacement, onPlacementChange]);

  // Auto-center actions.
  const centerH = () => {
    if (!vector) return;
    const dh = placement.designWidthInches * aspect;
    onPlacementChange(clampPlacement({
      ...placement,
      offsetYInches: margin + (placeableH - dh) / 2,
    }));
  };
  const centerV = () => {
    if (!vector) return;
    onPlacementChange(clampPlacement({
      ...placement,
      offsetXInches: margin + (placeableW - placement.designWidthInches) / 2,
    }));
  };
  const centerBoth = () => {
    if (!vector) return;
    const dh = placement.designWidthInches * aspect;
    onPlacementChange(clampPlacement({
      offsetXInches: margin + (placeableW - placement.designWidthInches) / 2,
      offsetYInches: margin + (placeableH - dh) / 2,
      designWidthInches: placement.designWidthInches,
    }));
  };

  // Render the board PNG locally so we can position the design overlay
  // in the same coordinate space.
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boardPx, setBoardPx] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useEffect(() => {
    let cancelled = false;
    renderBoardWithFeatures(boardConfig).then(url => {
      if (!cancelled) setBoardUrl(url);
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

  const pctX = (inches: number) => `${(inches / boardConfig.widthInches)  * 100}%`;
  const pctY = (inches: number) => `${(inches / boardConfig.heightInches) * 100}%`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-6 flex-1 min-h-0">
        {/* Left column */}
        <div className="space-y-5 overflow-y-auto pr-2 min-h-0">
          <section>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Your art
            </h2>
            <FileUpload onFile={onFile} fileName={vector?.fileName} />
            {parsing && (
              <p className="text-xs text-slate-400 mt-2 text-center animate-pulse">Parsing file…</p>
            )}
            {errorMsg && (
              <p className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded p-2 mt-2">{errorMsg}</p>
            )}
          </section>

          {vector && woodConfigs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Inlay woods
              </h2>
              <InlayColorPicker
                woodConfigs={woodConfigs}
                onUpdate={onUpdateWoodConfig}
              />
            </section>
          )}

          {vector && (
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Center on board
              </h2>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={centerH}
                  className="px-2 py-1.5 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200"
                >Vertical</button>
                <button
                  onClick={centerV}
                  className="px-2 py-1.5 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200"
                >Horizontal</button>
                <button
                  onClick={centerBoth}
                  className="px-2 py-1.5 rounded-md text-xs font-medium bg-blue-700 hover:bg-blue-600 text-white"
                >Both</button>
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                Drag the design to reposition or pull a corner to scale (aspect locked).
              </p>
            </section>
          )}
        </div>

        {/* Preview column */}
        <div ref={wrapRef} className="min-h-0 flex items-center justify-center bg-slate-950 rounded-lg">
          {boardUrl && (
            <div
              ref={containerRef}
              className="relative shadow-xl"
              style={{ width: boardPx.width, height: boardPx.height }}
            >
              <img
                src={boardUrl}
                alt={`${boardConfig.wood} board preview`}
                className="absolute inset-0 w-full h-full object-cover rounded select-none pointer-events-none"
                draggable={false}
              />

              {vector && designCompositeUrl && (
                <div
                  className="absolute"
                  style={{
                    left:   pctX(eff.offsetXInches),
                    top:    pctY(eff.offsetYInches),
                    width:  pctX(eff.designWidthInches),
                    height: pctY(designHeight),
                  }}
                >
                  <img
                    src={designCompositeUrl}
                    alt="Design"
                    className={`absolute inset-0 w-full h-full select-none ${drag ? 'cursor-grabbing' : 'cursor-move'}`}
                    style={{ outline: '1px dashed rgba(96, 165, 250, 0.55)' }}
                    draggable={false}
                    onMouseDown={handleMouseDown('move')}
                  />
                  {(['resize-tl', 'resize-tr', 'resize-bl', 'resize-br'] as DragMode[]).map(mode => {
                    const top    = mode === 'resize-tl' || mode === 'resize-tr' ? '-5px' : 'auto';
                    const bottom = mode === 'resize-bl' || mode === 'resize-br' ? '-5px' : 'auto';
                    const left   = mode === 'resize-tl' || mode === 'resize-bl' ? '-5px' : 'auto';
                    const right  = mode === 'resize-tr' || mode === 'resize-br' ? '-5px' : 'auto';
                    const cursor = (mode === 'resize-tl' || mode === 'resize-br') ? 'nwse-resize' : 'nesw-resize';
                    return (
                      <div
                        key={mode}
                        onMouseDown={handleMouseDown(mode)}
                        style={{ top, bottom, left, right, cursor, position: 'absolute', width: 10, height: 10, background: 'rgba(96,165,250,0.9)', border: '1px solid white', borderRadius: 2 }}
                        aria-label={`Resize from ${mode.replace('resize-', '')}`}
                      />
                    );
                  })}
                </div>
              )}
            </div>
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
