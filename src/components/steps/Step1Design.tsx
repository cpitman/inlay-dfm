'use client';

import type { DFMSettings, VectorData, WoodConfig, WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES, WOOD_SPECIES_ORDER } from '@/lib/woodSpecies';
import FileUpload from '../FileUpload';
import DesignSettingsPanel from '../DesignSettingsPanel';
import AdvancedSettingsPanel from '../AdvancedSettingsPanel';
import PlugFitPanel from '../PlugFitPanel';
import WoodList from '../WoodList';
import CompositeView from '../CompositeView';
import { StepNav } from '../StepperBar';

interface Step1DesignProps {
  vector: VectorData | null;
  fileName?: string;
  onFile: (file: File) => void;
  parsing: boolean;

  settings: DFMSettings;
  onSettingsChange: (s: DFMSettings) => void;

  woodConfigs: WoodConfig[];
  onUpdateWoodConfig: (colorHex: string, patch: Partial<WoodConfig>) => void;
  onMoveWood: (index: number, dir: -1 | 1) => void;

  backgroundSpecies: WoodSpeciesKey;
  onBackgroundSpeciesChange: (s: WoodSpeciesKey) => void;

  compositeDataUrl: string | null;
  compositeGenerating: boolean;
  onCommitPlacement: (offsetX: number, offsetY: number, designWidth: number) => void;

  // Step navigation
  canAdvance: boolean;
  nextLabel: string;
  onNext: () => void;
}

/**
 * Step 1 — Design.
 *
 * Captures everything about the *desired* inlay (not how it'll be carved):
 * file, board size, design width/depth, grain direction, wood species per
 * layer + background, inlay z-order, and placement on the board.
 *
 * Two-pane layout: controls on the left, composite preview on the right.
 * The Next button doubles as "Run Analysis →" — the user's signal that
 * they're done designing and ready to evaluate manufacturing.
 */
export default function Step1Design({
  vector, fileName, onFile, parsing,
  settings, onSettingsChange,
  woodConfigs, onUpdateWoodConfig, onMoveWood,
  backgroundSpecies, onBackgroundSpeciesChange,
  compositeDataUrl, compositeGenerating, onCommitPlacement,
  canAdvance, nextLabel, onNext,
}: Step1DesignProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] gap-6 flex-1 min-h-0">
        {/* Controls column */}
        <div className="space-y-6 overflow-y-auto pr-2 min-h-0">
          <section>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Design File
            </h2>
            <FileUpload onFile={onFile} fileName={fileName} />
            {parsing && (
              <p className="text-xs text-slate-400 mt-2 text-center animate-pulse">Parsing file…</p>
            )}
          </section>

          {vector && (
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Geometry
              </h2>
              <DesignSettingsPanel settings={settings} onChange={onSettingsChange} />
            </section>
          )}

          {vector && (
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Plug Fit
              </h2>
              <PlugFitPanel settings={settings} onChange={onSettingsChange} />
            </section>
          )}

          {vector && (
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Base Board
              </h2>
              <div className="flex items-center gap-2">
                <span
                  className="w-5 h-5 rounded shrink-0 border border-slate-600"
                  style={{ background: WOOD_SPECIES[backgroundSpecies].baseHex }}
                />
                <select
                  value={backgroundSpecies}
                  onChange={e => onBackgroundSpeciesChange(e.target.value as WoodSpeciesKey)}
                  className="flex-1 bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {WOOD_SPECIES_ORDER.map(key => (
                    <option key={key} value={key}>{WOOD_SPECIES[key].name}</option>
                  ))}
                </select>
              </div>
            </section>
          )}

          {vector && woodConfigs.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                Inlay Layers <span className="ml-1 text-slate-500 normal-case font-normal">(carved bottom-up)</span>
              </h2>
              <WoodList
                woodConfigs={woodConfigs}
                onUpdate={onUpdateWoodConfig}
                onMove={onMoveWood}
              />
            </section>
          )}

          {vector && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5 select-none">
                <span className="transition-transform group-open:rotate-90">▸</span>
                Advanced
              </summary>
              <div className="pt-3">
                <AdvancedSettingsPanel settings={settings} onChange={onSettingsChange} />
              </div>
            </details>
          )}
        </div>

        {/* Preview column */}
        <div className="min-h-0 flex flex-col">
          {vector ? (
            <div className="flex-1 min-h-0">
              <CompositeView
                dataUrl={compositeDataUrl}
                generating={compositeGenerating}
                woodConfigs={woodConfigs}
                backgroundSpecies={backgroundSpecies}
                vector={vector}
                boardWidthInches={settings.boardWidthInches}
                boardHeightInches={settings.boardHeightInches}
                designWidthInches={settings.designWidthInches}
                designOffsetXInches={settings.designOffsetXInches}
                designOffsetYInches={settings.designOffsetYInches}
                onCommitPlacement={onCommitPlacement}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex items-center justify-center bg-slate-800/40 border border-dashed border-slate-700 rounded-lg p-8 text-center">
              <div className="max-w-md text-slate-400 text-sm space-y-2">
                <p className="font-semibold text-slate-300">Upload a design file to begin</p>
                <p>Each distinct fill color is treated as a separate wood species. Use the controls on the left after upload.</p>
                <p className="text-xs text-slate-500">SVG and DXF supported. Everything runs in your browser — files are not uploaded anywhere.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <StepNav
        currentStep={1}
        canAdvance={canAdvance}
        nextLabel={nextLabel}
        onNext={onNext}
      />
    </div>
  );
}
