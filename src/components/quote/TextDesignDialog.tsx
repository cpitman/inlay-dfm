'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import type { WoodSpeciesKey } from '@/types';
import { WOOD_SPECIES } from '@/lib/woodSpecies';
import { INLAY_WOOD_OPTIONS, INLAY_WOOD_PRICE } from '@/lib/pricing';
import {
  TEXT_FONT_FAMILIES,
  type TextFontStyle,
  type TextSpec,
} from '@/lib/textVector';

interface TextDesignDialogProps {
  /** When non-null, dialog is open and pre-populated with this spec
   *  (edit mode). When the prop is `'new'`, the dialog is open in
   *  "create" mode with default values. When null, dialog is closed. */
  initial: TextSpec | 'new' | null;
  onCancel: () => void;
  onSave: (spec: TextSpec) => void;
}

const DEFAULT_FAMILY = 'Inter';

/** Compose a (family, bold, italic) selection into the catalog's
 *  `TextFontStyle` enum. */
function styleFromToggles(bold: boolean, italic: boolean): TextFontStyle {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}
function togglesFromStyle(style: TextFontStyle): { bold: boolean; italic: boolean } {
  return {
    bold:   style === 'bold' || style === 'boldItalic',
    italic: style === 'italic' || style === 'boldItalic',
  };
}

/**
 * Modal for adding or editing a text-based design element. Captures
 * content + font + style + inlay species; the QuoteApp converts
 * these into a full `Design` via `textToVectorData`. Only one of each
 * (catalog, species set) is allowed in the v1 UI.
 */
export default function TextDesignDialog({ initial, onCancel, onSave }: TextDesignDialogProps) {
  const editing = initial !== null && initial !== 'new';

  const initSpec: TextSpec = editing
    ? initial
    : { content: '', fontFamily: DEFAULT_FAMILY, fontStyle: 'regular', species: 'cherry' };

  const [content, setContent] = useState(initSpec.content);
  const [family, setFamily] = useState<string>(initSpec.fontFamily);
  const initToggles = togglesFromStyle(initSpec.fontStyle);
  const [bold, setBold] = useState(initToggles.bold);
  const [italic, setItalic] = useState(initToggles.italic);
  const [species, setSpecies] = useState<WoodSpeciesKey>(initSpec.species);

  // Datalist needs a stable per-instance id so multiple dialogs (or
  // re-mounts) don't collide.
  const fontListId = useId();

  // Picker options: every catalog family with a category-tagged label
  // shown next to the family name in the datalist dropdown.
  const fontOptions = useMemo(() => TEXT_FONT_FAMILIES.map(f => ({
    family: f.family,
    label: `${f.category}${f.bundled ? ' · bundled' : ''}`,
  })), []);

  // Re-initialize when the dialog reopens for a different design.
  useEffect(() => {
    if (initial === null) return;
    const fresh: TextSpec = initial === 'new'
      ? { content: '', fontFamily: DEFAULT_FAMILY, fontStyle: 'regular', species: 'cherry' }
      : initial;
    setContent(fresh.content);
    setFamily(fresh.fontFamily);
    const tg = togglesFromStyle(fresh.fontStyle);
    setBold(tg.bold);
    setItalic(tg.italic);
    setSpecies(fresh.species);
  }, [initial]);

  if (initial === null) return null;

  const trimmed = content.trim();
  const canSave = trimmed.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      content: trimmed,
      fontFamily: family,
      fontStyle: styleFromToggles(bold, italic),
      species,
    });
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-slate-950/70 flex items-center justify-center p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">
            {editing ? 'Edit text' : 'Add text'}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-lg leading-none"
            aria-label="Close"
          >×</button>
        </div>

        {/* Text content */}
        <label className="block">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
            Text
          </span>
          <input
            type="text"
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Type your text…"
            autoFocus
            maxLength={64}
            className="w-full bg-slate-700 border border-slate-600 text-slate-100 text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>

        {/* Font + style */}
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <label className="block">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
              Font
            </span>
            {/*
              Native combobox. The browser handles search-as-you-type
              filtering, accessibility, and keyboard nav for free.
              ~290 catalog entries — bigger than what'd be reasonable
              in a `<select>` but well within `<datalist>` UX bounds.
              Bundled families are listed first, then the rest sorted
              alphabetically (see `textFontCatalog.ts`).
            */}
            <input
              list={fontListId}
              value={family}
              onChange={e => setFamily(e.target.value)}
              placeholder="Type to filter…"
              className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded px-2 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <datalist id={fontListId}>
              {fontOptions.map(opt => (
                <option key={opt.family} value={opt.family} label={opt.label} />
              ))}
            </datalist>
          </label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setBold(b => !b)}
              aria-pressed={bold}
              title="Bold"
              className={`w-9 h-9 rounded text-sm font-bold border ${
                bold
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'
              }`}
            >B</button>
            <button
              type="button"
              onClick={() => setItalic(i => !i)}
              aria-pressed={italic}
              title="Italic"
              className={`w-9 h-9 rounded text-sm italic border ${
                italic
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'
              }`}
            >I</button>
          </div>
        </div>

        {/* Inlay wood */}
        <label className="block">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
            Inlay wood
          </span>
          <div className="flex items-center gap-2">
            <span
              className="w-4 h-4 rounded shrink-0 border border-slate-600"
              style={{ background: WOOD_SPECIES[species].baseHex }}
              title={WOOD_SPECIES[species].name}
            />
            <select
              value={species}
              onChange={e => setSpecies(e.target.value as WoodSpeciesKey)}
              className="flex-1 bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {INLAY_WOOD_OPTIONS.map(key => (
                <option key={key} value={key}>
                  {WOOD_SPECIES[key as WoodSpeciesKey].name}
                  {INLAY_WOOD_PRICE[key] !== undefined ? ` — $${INLAY_WOOD_PRICE[key]}` : ''}
                </option>
              ))}
            </select>
          </div>
        </label>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-sm text-slate-300 hover:text-white hover:bg-slate-700"
          >Cancel</button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >{editing ? 'Save' : 'Add'}</button>
        </div>

        <p className="text-xs text-slate-500">
          Text is rasterized through the same DFM analysis as uploaded
          designs. Glyph paths are vectorized at design time so the
          downloaded SVG stays portable for CAM software.
        </p>
      </div>
    </div>
  );
}
