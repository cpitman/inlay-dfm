'use client';

import type { MachiningTimeMatrix } from '@/types';
import { formatMinutes, findFastestFeasibleCell, totalCellTime } from '@/lib/machiningTime';

interface BitMatrixTableProps {
  matrix: MachiningTimeMatrix;
  /** Currently-active clearance strategy diameters (descending). Empty = v-bit only. */
  currentStrategyDiameters: number[];
  /** Currently-active V-bit angle, in degrees. */
  currentVbitAngle: number;
  /**
   * Tool-change overhead per bit load/swap, in minutes. Each cell shows
   * `cuttingTime + bitCount × toolChangeMinutes` so the matrix reflows
   * instantly when the user toggles ATC vs Manual.
   */
  toolChangeMinutes: number;
  /**
   * Optional cell click handler — when provided, cells become buttons that
   * switch the user's settings to that combination. Receives the strategy
   * diameters array (descending) and v-bit angle.
   */
  onSelectCombination?: (strategyDiameters: number[], vbitAngle: number) => void;
}

function diametersMatch(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export default function BitMatrixTable({
  matrix, currentStrategyDiameters, currentVbitAngle, toolChangeMinutes,
  onSelectCombination,
}: BitMatrixTableProps) {
  const fastest = findFastestFeasibleCell(matrix, toolChangeMinutes);
  const minSi = fastest?.strategyIdx ?? -1;
  const minVi = fastest?.vbitIdx ?? -1;

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700 text-xs text-slate-400">
        Total machining time per (clearance strategy × V-bit) combination — pocket + plug across all layers, including tool-change overhead.
        {' '}<span className="text-emerald-400">Green</span> = fastest.
        {' '}<span className="text-blue-300">Blue</span> = current selection.
        {' '}<span className="text-slate-500">N/A</span> means the V-bit angle is infeasible (&gt;10% problem area on some layer, or an isolated unreachable piece).
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-900/40 text-slate-300">
            <th className="text-left px-3 py-2 font-medium">Strategy ↓ / V-bit →</th>
            {matrix.vbits.map(v => (
              <th
                key={v.angleDegrees}
                className={`px-3 py-2 font-medium text-center ${v.feasible ? '' : 'text-slate-500'}`}
                title={v.feasible ? undefined : 'V-bit angle is infeasible: >10% problem area on some layer, or an isolated piece of a layer cannot be carved at all'}
              >
                <div>{v.angleDegrees}°{!v.feasible && ' ⚠'}</div>
                <div className="text-slate-500 text-[10px] font-normal">
                  {v.mrr.toFixed(3)} in³/min · {v.feed} ipm
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.strategies.map((s, si) => (
            <tr key={s.label} className="border-t border-slate-700">
              <td className="px-3 py-2 text-slate-300">
                <div className="font-medium">{s.label}</div>
                <div className="text-slate-500 text-[10px]">
                  {s.bitCount} bit{s.bitCount === 1 ? '' : 's'} (+{(s.bitCount * toolChangeMinutes).toFixed(1)} min change)
                </div>
              </td>
              {matrix.vbits.map((v, vi) => {
                const t = totalCellTime(matrix, si, vi, toolChangeMinutes);
                const isCurrent = diametersMatch(s.diameters, currentStrategyDiameters)
                               && v.angleDegrees === currentVbitAngle;
                const isFastest = si === minSi && vi === minVi;
                const naCell = !v.feasible || !isFinite(t);

                const baseClass = 'px-3 py-2 text-center transition-colors';
                let colorClass: string;
                if (naCell) {
                  colorClass = 'text-slate-600';
                } else if (isCurrent) {
                  colorClass = 'bg-blue-700/40 text-blue-100 ring-1 ring-blue-500';
                } else if (isFastest) {
                  colorClass = 'bg-emerald-900/30 text-emerald-200';
                } else {
                  colorClass = 'text-slate-200';
                }
                const clickable = onSelectCombination && !naCell;
                const interactive = clickable ? 'cursor-pointer hover:bg-slate-700/50' : '';

                const content = naCell ? 'N/A' : formatMinutes(t);
                if (clickable) {
                  return (
                    <td
                      key={v.angleDegrees}
                      className={`${baseClass} ${colorClass} ${interactive}`}
                      onClick={() => onSelectCombination(s.diameters, v.angleDegrees)}
                      title={`Switch to ${s.label} clearance + ${v.angleDegrees}° V-bit`}
                    >
                      {content}
                    </td>
                  );
                }
                return (
                  <td
                    key={v.angleDegrees}
                    className={`${baseClass} ${colorClass}`}
                    title={naCell ? 'V-bit angle is infeasible for this design' : undefined}
                  >
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
