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
export const CODE_VERSION = '2026-05-08.17';

/** One-line description of the most recent change. Free-form. */
export const CODE_VERSION_NOTE =
  'splitSvgIntoLayers now applies asymmetric z-order-aware subtractions: lower layers keep their full color-union (preserving artist hole-fill optimizations); upper layers carve out lower colors\' source-visible regions. Fixes nested-color SVGs where a color is interleaved with other colors at multiple z-positions (e.g., chessboard\'s alternating dark-red / white / pink / white squares were collapsing to wrong rendering). Painter\'s-algorithm pass over post-bake paint events computes source-visible per color; bottom-up walk subtracts from upper layers.';
