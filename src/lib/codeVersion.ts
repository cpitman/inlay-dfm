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
export const CODE_VERSION = '2026-05-08.11';

/** One-line description of the most recent change. Free-form. */
export const CODE_VERSION_NOTE =
  'Hardcode canvas resolution to 1200 px everywhere; remove the analysisResolution setting, AnalysisResolution type, AdvancedSettingsPanel resolution UI, and GUIDED_PIXELS_PER_INCH / LITE_PIXELS_PER_INCH from quoteOptimizer (after the polygon migration the canvas resolution affects only overlay PNG appearance, not analysis numbers). Cut dead px constants + buildDepthMap function from dfmAnalysis.ts.';
