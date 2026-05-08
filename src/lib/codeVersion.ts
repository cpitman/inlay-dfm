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
export const CODE_VERSION = '2026-05-08.1';

/** One-line description of the most recent change. Free-form. */
export const CODE_VERSION_NOTE =
  'Machining time polygon-native: per-bit covered area = inwardArea + perimeter × R (Steiner minus the π R² corner-cap term); incremental subtraction across bits drives clearance + v-bit time. Plug stock = polygon convex hull + outward offset. Bitmap dist1 fully retired from per-layer pipeline.';
