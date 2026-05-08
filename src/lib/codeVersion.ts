/**
 * Monotonically-increasing version stamp for the running source
 * tree. Surfaces in the debug archive's `manifest.json` (and any
 * other diagnostics that need to validate the running build) so a
 * stale dev-server / cached bundle is immediately spottable.
 *
 * **Bump this on every meaningful source edit.** Format:
 *
 *   YYYYMMDD.N — a date-counter where N starts at 1 each day and
 *                increments on each successive bump. Roll the date
 *                forward and reset N to 1 on the first bump of a
 *                new day.
 *
 * Update `lastChange` to a one-line description of what the bump
 * was for. The description is informational; the version number is
 * what's load-bearing.
 */
export const CODE_VERSION = '2026-05-07.20';

/** One-line description of the most recent change. Free-form. */
export const CODE_VERSION_NOTE =
  'Phase 4 per-side analyzeMask polygon-native: polygonProblemStats + polygonThinWalls (row/column-scan polygon edges) drive per-side stats + overlay PNG; per-side depth map renders polygon offset levels; bitmap dist1 retained only for machiningTimeForMask';
