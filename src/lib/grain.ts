import type { GrainDirection } from '@/types';

/**
 * True for grain directions where there's a meaningful "across the grain"
 * axis — i.e. horizontal or vertical, but NOT end-grain (which is
 * isotropic at this level of analysis). Several UI checks and the
 * thin-wall analysis branch on this distinction; centralizing the
 * predicate keeps callers in lockstep if more grain modes appear.
 */
export function isSideGrain(direction: GrainDirection): boolean {
  return direction !== 'end';
}
