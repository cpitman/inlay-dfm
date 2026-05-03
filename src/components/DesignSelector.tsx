'use client';

interface DesignSelectorItem {
  id: string;
  fileName: string;
}

interface DesignSelectorProps {
  designs: DesignSelectorItem[];
  activeDesignId: string | null;
  onSelect: (id: string) => void;
  /** Optional: when provided, an "+ Add design" button appears at the
   *  end of the row and triggers a file picker via this callback. */
  onAdd?: (file: File) => void;
  /** Optional: when provided, each tab gets a "×" remove button. */
  onRemove?: (id: string) => void;
  /** Hide entirely when there's only one design and no add/remove
   *  affordances. Default false (always render so layout is stable). */
  hideWhenSingle?: boolean;
}

/**
 * Horizontal tab strip used by both the expert and guided flows to
 * switch which design is "active" — i.e. which design's analysis,
 * placement, or per-color settings are currently shown. The strip
 * appears at the top of each step; clicking a tab swaps state without
 * re-running analysis (results are cached per design).
 */
export default function DesignSelector({
  designs, activeDesignId, onSelect, onAdd, onRemove, hideWhenSingle = false,
}: DesignSelectorProps) {
  if (hideWhenSingle && designs.length <= 1 && !onAdd) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mb-3">
      {designs.map(d => {
        const active = d.id === activeDesignId;
        return (
          <div
            key={d.id}
            className={`inline-flex items-stretch rounded-md overflow-hidden border
              ${active ? 'border-blue-500 bg-blue-600/20' : 'border-slate-700 bg-slate-800 hover:bg-slate-700/60'}`}
          >
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              className={`px-3 py-1.5 text-xs font-medium truncate max-w-[14rem]
                ${active ? 'text-blue-100' : 'text-slate-300'}`}
              title={d.fileName}
              aria-pressed={active}
            >
              {d.fileName}
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(d.id)}
                aria-label={`Remove ${d.fileName}`}
                title="Remove this design"
                className="px-2 text-slate-500 hover:text-red-300 hover:bg-slate-700/50 border-l border-slate-700"
              >×</button>
            )}
          </div>
        );
      })}
      {onAdd && (
        <label className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium border border-dashed border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500 cursor-pointer">
          + Add design
          <input
            type="file"
            accept=".svg,.dxf"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) onAdd(f);
              e.currentTarget.value = '';
            }}
          />
        </label>
      )}
    </div>
  );
}
