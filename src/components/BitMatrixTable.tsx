'use client';

import type { MachiningTimeMatrix } from '@/types';
import { formatMinutes } from '@/lib/machiningTime';

interface BitMatrixTableProps {
  matrix: MachiningTimeMatrix;
  /** Currently-active clearance bit diameter, in inches. */
  currentClearanceDiameter: number;
  /** Currently-active V-bit angle, in degrees. */
  currentVbitAngle: number;
  /**
   * Optional cell click handler — when provided, cells become buttons that
   * switch the user's settings to that bit combination. The V-bit angles in
   * the matrix are always presets, so the clearance + angle uniquely identify
   * the selection.
   */
  onSelectCombination?: (clearanceDiameter: number, vbitAngle: number) => void;
}

function clearanceLabel(diameter: number): string {
  if (diameter === 0.125) return '1/8"';
  if (diameter === 0.25)  return '1/4"';
  if (diameter === 0.5)   return '1/2"';
  return `${diameter.toFixed(3)}"`;
}

export default function BitMatrixTable({
  matrix, currentClearanceDiameter, currentVbitAngle, onSelectCombination,
}: BitMatrixTableProps) {
  // Find min total time across feasible cells only.
  let minTime = Infinity, minCi = -1, minVi = -1;
  for (let ci = 0; ci < matrix.times.length; ci++) {
    for (let vi = 0; vi < matrix.times[ci].length; vi++) {
      if (!matrix.vbits[vi].feasible) continue;
      const t = matrix.times[ci][vi];
      if (isFinite(t) && t < minTime) { minTime = t; minCi = ci; minVi = vi; }
    }
  }

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700 text-xs text-slate-400">
        Total machining time per (clearance bit × V-bit) combination — pocket + plug across all layers.
        {' '}<span className="text-emerald-400">Green</span> = fastest.
        {' '}<span className="text-blue-300">Blue</span> = current selection.
        {' '}<span className="text-slate-500">N/A</span> means the V-bit angle either leaves &gt;10% problem area on some layer, or some piece of a layer can't be carved at all (an isolated region with no full-depth coverage).
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-900/40 text-slate-300">
            <th className="text-left px-3 py-2 font-medium">Clearance ↓ / V-bit →</th>
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
          {matrix.clearanceBits.map((c, ci) => (
            <tr key={c.diameterInches} className="border-t border-slate-700">
              <td className="px-3 py-2 text-slate-300">
                <div className="font-medium">{clearanceLabel(c.diameterInches)}</div>
                <div className="text-slate-500 text-[10px]">{c.mrr.toFixed(2)} in³/min</div>
              </td>
              {matrix.vbits.map((v, vi) => {
                const t = matrix.times[ci][vi];
                const isCurrent = c.diameterInches === currentClearanceDiameter
                               && v.angleDegrees   === currentVbitAngle;
                const isFastest = ci === minCi && vi === minVi;
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
                      onClick={() => onSelectCombination(c.diameterInches, v.angleDegrees)}
                      title={`Switch to ${clearanceLabel(c.diameterInches)} clearance + ${v.angleDegrees}° V-bit`}
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
