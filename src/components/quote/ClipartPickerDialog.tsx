'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  loadClipartCatalog, searchCatalog, type ClipartManifestEntry,
} from '@/lib/clipartCatalog';

interface ClipartPickerDialogProps {
  /** When true, dialog is open. */
  open: boolean;
  onCancel: () => void;
  /** Called when the user picks an entry. The QuoteApp converts this
   *  into a Design via `clipartToVectorData` + auto-placement. */
  onSelect: (entry: ClipartManifestEntry) => void;
}

const PAGE_SIZE = 50;

/**
 * Modal for picking a clipart entry from the bundled `/clipart/`
 * library. Search by title or tag; double-click a tile (or single-
 * click + Add) to drop it onto the board with auto-placement and
 * default per-color wood species — the rest of Step 2 takes over for
 * positioning + species swapping.
 */
export default function ClipartPickerDialog({ open, onCancel, onSelect }: ClipartPickerDialogProps) {
  const [catalog, setCatalog] = useState<ClipartManifestEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [pageCount, setPageCount] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Lazy-load the manifest on first open.
  useEffect(() => {
    if (!open || catalog !== null) return;
    let cancelled = false;
    loadClipartCatalog().then(c => {
      if (cancelled) return;
      setCatalog(c);
      if (c.length === 0) {
        setLoadError('Clipart library is empty. The catalog scrape has not run yet.');
      }
    }).catch(err => {
      if (cancelled) return;
      setLoadError((err as Error).message);
      setCatalog([]);
    });
    return () => { cancelled = true; };
  }, [open, catalog]);

  // Debounce search input so typing doesn't re-render on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Reset paging + selection when the query changes.
  useEffect(() => {
    setPageCount(1);
    setSelectedId(null);
  }, [debouncedQuery]);

  // Reset everything when the dialog closes so reopening starts fresh.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setDebouncedQuery('');
    setPageCount(1);
    setSelectedId(null);
  }, [open]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    return searchCatalog(catalog, debouncedQuery);
  }, [catalog, debouncedQuery]);

  const visible = filtered.slice(0, pageCount * PAGE_SIZE);
  const hasMore = filtered.length > visible.length;

  const selected = filtered.find(e => e.id === selectedId) ?? null;

  if (!open) return null;

  const handlePick = (entry: ClipartManifestEntry) => {
    onSelect(entry);
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
        className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3 shrink-0">
          <h3 className="text-base font-semibold text-slate-100">Add clipart</h3>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-lg leading-none"
            aria-label="Close"
          >×</button>
        </div>

        {/* Search */}
        <div className="px-5 pb-3 shrink-0">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by title or tag (e.g. fox, tree, heart)…"
            autoFocus
            className="w-full bg-slate-700 border border-slate-600 text-slate-100 text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto px-5 pb-3 min-h-0">
          {catalog === null && (
            <p className="text-sm text-slate-400 text-center py-12">Loading…</p>
          )}
          {catalog !== null && loadError && (
            <p className="text-sm text-amber-200 bg-amber-900/30 border border-amber-800 rounded p-3">{loadError}</p>
          )}
          {catalog !== null && !loadError && filtered.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-12">
              No matches for &ldquo;{debouncedQuery}&rdquo;.
            </p>
          )}
          {catalog !== null && filtered.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-3">
                {visible.map(entry => {
                  const isSelected = entry.id === selectedId;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      onDoubleClick={() => handlePick(entry)}
                      className={`group flex flex-col rounded border text-left overflow-hidden transition ${
                        isSelected
                          ? 'border-blue-500 ring-2 ring-blue-500/50 bg-slate-700'
                          : 'border-slate-700 hover:border-slate-500 bg-slate-900/40'
                      }`}
                      title={`${entry.title} · double-click to add`}
                    >
                      <div className="aspect-[4/3] bg-slate-950 flex items-center justify-center p-2">
                        <img
                          src={`/clipart/${entry.id}.png`}
                          alt={entry.title}
                          loading="lazy"
                          className="max-w-full max-h-full object-contain"
                          style={{ maxWidth: '100%', maxHeight: '100%' }}
                          onError={(e) => {
                            // Fall back to the SVG when the PNG thumbnail
                            // isn't generated yet (test catalog ships
                            // without PNGs; the scrape pipeline produces
                            // them in production).
                            const img = e.currentTarget;
                            const svgUrl = `/clipart/${entry.id}.svg`;
                            if (img.src.endsWith(svgUrl)) return;
                            img.src = svgUrl;
                          }}
                        />
                      </div>
                      <div className="px-2 py-1.5">
                        <p className="text-xs text-slate-200 truncate">{entry.title}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
              {hasMore && (
                <div className="text-center pt-4">
                  <button
                    type="button"
                    onClick={() => setPageCount(p => p + 1)}
                    className="px-4 py-1.5 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                  >
                    Load more ({filtered.length - visible.length} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 p-5 pt-3 border-t border-slate-700 shrink-0">
          <p className="text-xs text-slate-500 truncate">
            {selected
              ? `${selected.title} · ${selected.colorCount} color${selected.colorCount === 1 ? '' : 's'}`
              : 'Pick an item then click Add — or double-click any tile.'}
          </p>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded text-sm text-slate-300 hover:text-white hover:bg-slate-700"
            >Cancel</button>
            <button
              type="button"
              onClick={() => selected && handlePick(selected)}
              disabled={!selected}
              className="px-4 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}
