/**
 * Approximate material removal rates and feed rates for common bits.
 * Used by the machining-time estimator. These are deliberately rough — real
 * MRR depends on material, spindle speed, depth-per-pass, and bit condition.
 * The intent is to give the user a comparable estimate across designs and
 * bit choices, not a reliable wall-clock prediction.
 */

export type ClearanceBitDiameter = 0.125 | 0.25 | 0.5;

/** Material removal rate, in cubic inches per minute. */
export const CLEARANCE_BIT_MRR: Record<ClearanceBitDiameter, number> = {
  0.125: 0.23,  // 1/8" — small, slower
  0.25:  1.35,  // 1/4" — typical workhorse
  0.5:   7.0,   // 1/2" — aggressive, fast
};

export const CLEARANCE_BIT_OPTIONS: ClearanceBitDiameter[] = [0.125, 0.25, 0.5];

export interface VbitRates {
  /** Material removal rate in cubic inches per minute. */
  mrr: number;
  /** Linear feed rate (used for the perimeter-tracing pass) in inches per minute. */
  feed: number;
}

/**
 * V-bit rates by included angle (degrees). Larger angles support more
 * aggressive cuts because the cutting edges engage less steeply; smaller
 * delicate angles like 15° require slower removal and feed.
 */
export const VBIT_RATES: Record<number, VbitRates> = {
  15:  { mrr: 0.005, feed: 35  },
  30:  { mrr: 0.015, feed: 40  },
  45:  { mrr: 0.045, feed: 50  },
  60:  { mrr: 0.10,  feed: 60  },
  90:  { mrr: 0.30,  feed: 90  },
  120: { mrr: 0.85,  feed: 120 },
};

export const VBIT_PRESET_ANGLES: number[] = Object.keys(VBIT_RATES)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * Resolve V-bit rates for a given angle. Preset angles use the table above.
 * Custom angles return user-supplied values; if those are missing, the
 * caller (typically the analyzer) should treat the time estimate as
 * unavailable.
 */
export function getVbitRates(
  angleDegrees: number,
  customMRR: number | undefined,
  customFeed: number | undefined,
): VbitRates | null {
  const preset = VBIT_RATES[angleDegrees];
  if (preset) return preset;
  if (typeof customMRR === 'number' && customMRR > 0 &&
      typeof customFeed === 'number' && customFeed > 0) {
    return { mrr: customMRR, feed: customFeed };
  }
  return null;
}

export function isVbitPresetAngle(angleDegrees: number): boolean {
  return angleDegrees in VBIT_RATES;
}
