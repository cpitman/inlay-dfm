@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Next.js dev server (default :3000; if taken, use 3001)
npm run build    # Production build (also catches type errors via Next's pipeline)
npm run lint     # eslint (eslint-config-next)
npm test         # vitest run (one-shot, all suites)
npx tsc --noEmit # TypeScript-only check (faster feedback than `npm run build`)
```

Run a single test file or filter by name:

```bash
npx vitest run src/lib/rotation.test.ts
npx vitest run -t "binary search"   # filter by `it(...)` description
```

The standard verification gate before committing: `npx tsc --noEmit && npm test -- --run && npx next build` clean, plus a smoke check of `/quote` and `/expert` (HTTP 200).

After every meaningful source edit, bump `CODE_VERSION` in `src/lib/codeVersion.ts` (and update `CODE_VERSION_NOTE` to a one-line description of the change). The version stamps into the debug archive's `manifest.json` so the user can validate which build is actually running — a stale dev server / cached bundle is otherwise indistinguishable from "the change had no effect."

## High-level architecture

Browser-only Next.js app — every CNC analysis stage runs in the user's tab via `OffscreenCanvas` and a separable 4-pass approximate EDT. There is no server logic.

### Two user flows, one pipeline

- **`/quote`** (`src/components/quote/`) — guided 3-step pricing experience for end-customers. `Step1BoardForm` → `Step2ArtPlacement` → `Step3QuoteDisplay`. The Step 3 page is driven by a multi-design optimizer.
- **`/expert`** (`src/app/expert/page.tsx` + `src/components/steps/`) — 4-step DFM tool for sophisticated users. Renders the per-preset machining-time matrix, depth maps, and per-side overlays at full fidelity.

Both flows consume the same core analysis (`runDfmAnalysis` in `src/lib/dfmAnalysis.ts`). The guided flow drives it through `runQuoteOptimization` (`src/lib/quoteOptimizer.ts`); the expert flow calls it directly per design.

### `runDfmAnalysis` phases

The function is long because it's the one place all the geometry comes together. Numbered phases in the file:

- **Phase 1–4**: per-color rasterization → EDT (`distanceTransform.ts`) → per-layer pocket + plug stats. Drives the per-side `SingleAnalysis.problemAreaPercent`, `widerBit*Mask`, `irreducibleProblemMask` etc. that downstream code reads.
- **Phase 5**: per-preset (`VBIT_PRESET_ANGLES = 6` angles) × per-wood × pocket/plug stats. Builds the `MachiningTimeMatrix` plus a `PerPresetAngleResult[]` per wood. The encode loop fires `buildOverlay` + `buildDepthMap` calls in parallel via `Promise.all` for the expert flow.
- **Phase 5.5**: Step 2 / guided display data — `widerBitInfeasibleMask` (largest-feasible vs largest+1) and the `irreducibleProblemMask` fallback (sharpest preset) when no preset is feasible.

Two perf flags on `runDfmAnalysis` short-circuit guided-flow work the UI never displays:

- `produceOverlays: false` — skip every PNG encode (per-side, per-preset, suggestion). Guided UI renders its own overlays in React from the raw masks. Saves ~150 PNG encodes per design.
- `useBinarySearchFeasibility: true` — replace the linear 6-preset stats sweep with a binary search for the largest-feasible preset (3–4 stats passes instead of 6). Sound because design-wide feasibility is monotonic in v-bit angle. Untested presets are filled in with sentinel `feasible` flags + stub `PerPresetAngleResult` entries; the picker's existing `if (!presetEntry) return false` guard makes the partial matrix work transparently.

The optimizer also runs a low-resolution **lite pass** (`runDfmAnalysisLite` + `redetectAlignmentRisks`, `LITE_PIXELS_PER_INCH = 120`) before the full pass, so hole-filling and alignment-extension heuristics don't pay full-resolution cost.

### Multi-design model

The `/quote` flow has been multi-design from the start; the `/expert` flow was extended to match. Each `Design` carries:

- its own `vector` + per-color `woodConfigs`
- a `Placement` (`offsetXInches`, `offsetYInches`, `designWidthInches`, optional `rotationDegrees: 0|90|180|270`)
- a `side: 'top' | 'bottom'` for two-sided cutting boards

Same-side designs cannot overlap (AABB check via `boxesOverlap` in `src/lib/aabb.ts`); back-side designs additionally avoid fixed features (feet, underside handle pockets). Two designs on **opposite** sides never conflict.

`pickPerLayerBitPlan` (`src/lib/machiningTime.ts`) walks v-bit presets widest-down, picks each layer's largest-feasible preset, and returns a plan whose tool-change overhead unions clearance bits with distinct v-bit angles across the board. `jointToolChangeOverhead` further shares bits across designs that fit on the same board.

### Rotation is a "view" transform

90°-step rotation per design **does not invalidate the analysis cache.** Pixel-grid rotations by 90° are lossless permutations under every operation in the pipeline (8-conn / radius-2 Chebyshev connectivity, separable EDT scans, rotating-calipers OBB packing, alignment-risk EDT). `vbitAngleWarning` keys off `grainDirection` (a board-level property), not feature orientation. So a `rotationDegrees` change is treated like translation: the visible AABB shifts (width and height swap for 90°/270°), collision is rechecked, and the cached `AnalysisResult` stays valid.

Renderers wrap the design in an outer container sized to the **visible** AABB and render the unrotated composite img inside it via CSS `transform: rotate()` so the image content doesn't stretch. The implementing components (`Step2ArtPlacement`, `CompositeView`, `Step3QuoteDisplay`, `BoardPreview`) all use the same pattern.

#### CSS gotcha worth remembering

Tailwind's preflight applies `img { max-width: 100%; height: auto }`. The rotation pattern centers the inner img with percentages that can exceed 100% (`width: 200%, height: 50%` for a quarter-turned wide design — the layout box must match the *unrotated* aspect). Without explicit `maxWidth: 'none'` and `maxHeight: 'none'` on every rotated img, the preflight cap squashes the image into a too-narrow box. Apply both whenever you add a new rotation overlay.

### Session export

`src/lib/sessionExport.ts` writes `.inlay-session.json` files. Schema is currently v2 (multi-design); the loader migrates v1 (single-design legacy) into a one-element `designs[]`. New optional fields on `Placement` (`rotationDegrees`) and `Design` (`side`) are tolerantly loaded — present-and-invalid is rejected, missing defaults to a sensible value.

## Conventions

- Tests are pure-function unit tests against typed-array helpers (159+ tests across `src/lib/*.test.ts`). End-to-end `runDfmAnalysis` tests aren't possible — the canvas APIs aren't available in vitest's environment. When you need integration coverage, extract the testable predicate into a pure helper and assert against it (see `binarySearchLargestFeasibleIdx` in `dfmAnalysis.ts`).
- Comments only when the *why* is non-obvious. Don't narrate what the code does; identifiers already do that.
- Per `AGENTS.md`: this is **not** the Next.js you might know from training data — APIs, conventions, and file structure may have changed. Read `node_modules/next/dist/docs/` before writing routing or App-Router code.
