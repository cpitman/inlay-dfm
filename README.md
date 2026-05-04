# Inlay DFM Analyzer

A browser-based Design for Manufacturing (DFM) tool for CNC v-carve inlay designs. Upload an SVG or DXF file, place it on a cutting board, and get either a price estimate or a per-bit feasibility analysis — without uploading anything to a server. Every render and every analysis runs in your tab.

## Two ways in

- **`/quote` — Get a quote.** A guided 3-step experience for artwork owners: pick a cutting board, drop one or more designs onto either face, see a price range plus the regions (if any) that need to be widened before manufacturing. Multi-color designs and two-sided boards are supported.
- **`/expert` — Expert DFM.** A 4-step stepper for users who want the full DFM picture: per-pocket and per-plug overlays, the machining-time matrix across six v-bit presets, depth-map visualizations, and bit-choice recommendations.

Both flows share the same analysis core, so feasibility verdicts agree across them.

## What a v-carve inlay actually involves

Two cuts, both made with a v-bit:

- **Pocket** — the design is carved *into* the base board. The bit traces the design's vector outline; depth grows toward the inside of each shape.
- **Plug** — the same vectors are carved on a second board, but with material removed *outside* the design, leaving the inlay shape standing proud. Glue the plug into the pocket and the v-cut walls register the two pieces precisely.

For both cuts, depth at any interior point follows:

```
depth = distance_from_edge / tan(v-bit_angle / 2)
```

Full inlay depth is reached only where `distance_from_edge ≥ inlay_depth × tan(half_angle)`. Features narrower than that never reach full depth, and the resulting fit is poor.

## What the analyzer checks

For each design layer (and its corresponding plug), at every selectable v-bit angle:

1. **Depth feasibility.** Pixels that never reach full depth *and* sit far (> 2× cut width) from any full-depth zone are flagged as unmanufacturable problem area.
2. **Isolated unreachable components.** A connected piece of the carve with no full-depth pixel anywhere inside it — same blocker as above, but called out as a topological failure (the bit physically can't seat anywhere in that region).
3. **Thin walls** (side grain only). Short runs of *un*-carved material perpendicular to the grain that are at risk of splitting. Below a 0.25 in² noise floor, ignored.
4. **V-bit angle** (side grain only). Angles below 60° increase tearout risk across wood fibres.
5. **Alignment risk between adjacent inlays.** Two layers whose edges sit within a small registration tolerance — they'll fight for the same v-cut wall when carved sequentially. Surfaced as a warning so you can adjust the design.

The guided flow runs an automatic optimization pass on top: it fills enclosed holes (invisible in the final composite, saving v-bit perimeter time) and picks a per-layer v-bit + clearance-bit plan that minimizes total machining time. The expert flow lets you drive every choice manually.

## Visualizations

Each canvas (pocket and plug, per layer) has three overlay modes:

- **Off** — composite preview with each color rendered as its assigned wood species' grain texture.
- **Threshold** — gray = OK; red = problem area; amber = thin wall opposing grain; teal/cyan = "wider bit would unlock here" suggestions.
- **Depth Map** — continuous gradient from red (zero depth, at the edge) to green (at or past full inlay depth).

The guided quote view consolidates all of this into one composite per design with locator badges pointing at any blocking regions.

## Multi-design + two-sided boards

A board can carry multiple designs across both faces. Each design has its own:

- vector file + per-color wood-species mapping
- placement on the board (offset, width, optional 90°-step rotation)
- side (`top` or `bottom`)

Same-side designs can't overlap each other or fixed back-side features (router-bit feet, underside handle pockets); opposite-side designs are independent. Each side is analyzed and costed separately — same species used on both sides counts as two inlay sheets in the materials estimate.

## File support

- **SVG** — parsed directly; the `viewBox` defines natural dimensions.
- **DXF** — converted to SVG via `dxf-parser`. Closed `LWPOLYLINE`s and splines are filled; open paths and arcs are stroked. Filling matters because the EDT-based feasibility analysis runs over the interior, not the outline.

Sessions save and load as `.inlay-session.json` files (a v2 schema covering all designs, placements, and wood mappings on the current board).

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and pick a flow.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4
- `OffscreenCanvas` for all rasterization and overlay generation
- A separable 4-pass approximate Euclidean Distance Transform — runs in milliseconds on million-pixel canvases
- [`dxf-parser`](https://www.npmjs.com/package/dxf-parser) for DXF support

Tests use [`vitest`](https://vitest.dev/) against pure-function helpers (typed-array masks, geometry, mask ops, packing, pricing — see `src/lib/*.test.ts`).
