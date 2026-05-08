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
export const CODE_VERSION = '2026-05-08.16';

/** One-line description of the most recent change. Free-form. */
export const CODE_VERSION_NOTE =
  'svgFlatten now clamps the SVG\'s width/height to viewBox-numeric values before getCTM(). Fixes Inkscape-output SVGs with CSS-unit dimensions ("190.5mm", "10in", etc.): the browser was rendering into a device-pixel viewport whose getCTM matrices were in pixel space, not viewBox space, so the bake landed geometry outside the stored viewBox. With width/height pinned to viewBox numerics, the viewport-to-viewBox scale is 1:1 and CTMs reflect just the matrix transforms. Width/height are restored after bake. Re-screened catalog drops bad-face + seven-pointed-star (true DFM fails surfaced now that geometry parses at correct scale); net 93/183.';
