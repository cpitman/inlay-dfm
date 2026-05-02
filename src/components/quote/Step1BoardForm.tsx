'use client';

import type { BoardConfig, BoardWoodKey, JuiceGroove, EdgeTreatment, HandleStyle, BoardSided } from '@/types/board';
import { BASE_BOARD_PRICE, ADDON_FEET } from '@/lib/pricing';
import BoardPreview from './BoardPreview';
import { StepNav } from '../StepperBar';

interface Step1BoardFormProps {
  config: BoardConfig;
  onChange: (next: BoardConfig) => void;
  onNext: () => void;
}

const BOARD_WOODS: { key: BoardWoodKey; label: string }[] = [
  { key: 'maple',  label: 'Maple'  },
  { key: 'walnut', label: 'Walnut' },
  { key: 'cherry', label: 'Cherry' },
];

const SIDED_OPTIONS: { key: BoardSided; label: string; hint: string }[] = [
  { key: 'feet', label: 'Feet on bottom', hint: 'Adds rubber feet (recommended for single-sided use).' },
  { key: 'dual', label: 'Dual-sided',     hint: 'Both sides finished; flip-friendly.' },
];

const GROOVE_OPTIONS: { key: JuiceGroove; label: string }[] = [
  { key: 'none',   label: 'None' },
  { key: 'top',    label: 'Top' },
  { key: 'bottom', label: 'Bottom' },
  { key: 'both',   label: 'Both' },
];

const EDGE_OPTIONS: { key: EdgeTreatment; label: string }[] = [
  { key: 'roundover', label: 'Roundover' },
  { key: 'chamfer',   label: 'Chamfer' },
];

const HANDLE_OPTIONS: { key: HandleStyle; label: string; hint: string }[] = [
  { key: 'none',      label: 'No handles',       hint: 'Plain edges.' },
  { key: 'inset',     label: 'Inset (sides)',    hint: 'Recessed grips in the sides of the board (not visible from the top).' },
  { key: 'underside', label: 'Underside pocket', hint: 'Hidden grips on the bottom face.' },
];

/**
 * Step 1 of the guided quote experience. The user picks the board's
 * physical features; a live preview reflects each choice immediately.
 * No price shown here — that's Step 3.
 */
export default function Step1BoardForm({ config, onChange, onNext }: Step1BoardFormProps) {
  const set = <K extends keyof BoardConfig>(k: K, v: BoardConfig[K]) =>
    onChange({ ...config, [k]: v });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-6 flex-1 min-h-0">
        {/* Form column */}
        <div className="space-y-5 overflow-y-auto pr-2 min-h-0">
          <FieldGroup label="Board size">
            <p className="text-sm text-slate-300">
              {config.widthInches}" × {config.heightInches}"
              <span className="text-xs text-slate-500 ml-2">(more sizes coming soon)</span>
            </p>
          </FieldGroup>

          <FieldGroup
            label="Wood"
            hint={`${BASE_BOARD_PRICE[config.wood] != null ? '$' + BASE_BOARD_PRICE[config.wood] + ' base material' : ''}`}
          >
            <ChoicePills
              options={BOARD_WOODS.map(w => ({ key: w.key, label: w.label }))}
              value={config.wood}
              onChange={v => set('wood', v as BoardWoodKey)}
            />
          </FieldGroup>

          <FieldGroup
            label="Sided"
            hint={config.sided === 'feet' ? `Adds rubber feet · +$${ADDON_FEET}` : 'No feet add-on.'}
          >
            <ChoiceList
              options={SIDED_OPTIONS}
              value={config.sided}
              onChange={v => set('sided', v as BoardSided)}
            />
          </FieldGroup>

          <FieldGroup
            label="Juice groove"
            hint={config.juiceGroove === 'top' || config.juiceGroove === 'both'
              ? 'Top groove requires a 1" margin around the inlay area.'
              : ''}
          >
            <ChoicePills
              options={GROOVE_OPTIONS}
              value={config.juiceGroove}
              onChange={v => set('juiceGroove', v as JuiceGroove)}
            />
          </FieldGroup>

          <FieldGroup label="Edge treatment">
            <ChoicePills
              options={EDGE_OPTIONS}
              value={config.edge}
              onChange={v => set('edge', v as EdgeTreatment)}
            />
          </FieldGroup>

          <FieldGroup label="Handles">
            <ChoiceList
              options={HANDLE_OPTIONS}
              value={config.handles}
              onChange={v => set('handles', v as HandleStyle)}
            />
          </FieldGroup>
        </div>

        {/* Preview column */}
        <div className="min-h-0">
          <BoardPreview config={config} />
        </div>
      </div>

      <StepNav
        currentStep={1}
        canAdvance={true}
        nextLabel="Next: upload art →"
        totalSteps={3}
        onNext={onNext}
      />
    </div>
  );
}

function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500 mt-1.5">{hint}</p>}
    </div>
  );
}

interface ChoiceOption { key: string; label: string }

function ChoicePills<K extends string>({
  options, value, onChange,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (v: K) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`flex-1 min-w-16 py-1.5 rounded-md text-sm font-medium border transition-colors
            ${value === o.key
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-400'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ChoiceList<K extends string>({
  options, value, onChange,
}: {
  options: readonly (ChoiceOption & { key: K; hint: string })[];
  value: K;
  onChange: (v: K) => void;
}) {
  return (
    <div className="space-y-1.5">
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`w-full text-left px-3 py-2 rounded-md border transition-colors
            ${value === o.key
              ? 'bg-blue-600/20 border-blue-500 text-blue-100'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'}`}
        >
          <div className="text-sm font-medium">{o.label}</div>
          <div className="text-xs text-slate-500 mt-0.5">{o.hint}</div>
        </button>
      ))}
    </div>
  );
}
