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
export const CODE_VERSION = '2026-05-08.13';

/** One-line description of the most recent change. Free-form. */
export const CODE_VERSION_NOTE =
  'Per-component small-corner tolerance in polygonProblemStats: components whose problem area is below 5% of their own carved area drop out of the problem region. Recovers v-bit-aware corner forgiveness lost when the bitmap monotonic-ascent rule was retired; isolated (= no-FD-seed) components still get flagged because their per-component problem ratio is 100%.';
