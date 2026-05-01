# Inlay DFM Analyzer

A browser-based Design for Manufacturing (DFM) tool for CNC VCarve inlay designs. Upload an SVG or DXF file, set your tooling parameters, and get an instant feasibility analysis of both the pocket and plug cuts — no server required.

## What it does

A VCarve inlay involves two cuts:

- **Pocket** — the design is carved into the base board. The V-bit tip traces the design vectors; depth increases going inward from the boundary.
- **Plug** — the background around the design is carved away from a second board, leaving the design as a raised feature. The V-bit traces the same vectors from outside.

For both cuts, the depth at any interior point follows:

```
depth = distance_from_edge / tan(V-bit_angle / 2)
```

Full inlay depth is reached only where `distance_from_edge ≥ inlay_depth × tan(half_angle)`. Features narrower than this never reach full depth, which causes a poor fit.

The analyzer checks each cut for:

1. **Depth feasibility** — pixels that never reach full depth *and* are far (> 2× cut width) from any full-depth zone are flagged as problem areas.
2. **Thin walls** (side grain only) — short runs of un-carved material perpendicular to the grain direction that are at risk of splitting. Blobs smaller than 0.25 in² are ignored as noise.
3. **V-bit angle** (side grain only) — angles below 60° increase tearout risk across wood fibres.

## Parameters

| Parameter | Description |
|---|---|
| Design width | Real-world width of the design in inches (sets the pixel-to-inch scale) |
| V-bit angle | Included angle of the V-bit (e.g. 60°, 90°) |
| Inlay depth | Target inlay depth in inches |
| Grain direction | Horizontal, vertical, or end grain — affects thin-wall and tearout checks |

## Visualizations

After running analysis, three overlay modes are available for each canvas:

- **Off** — plain SVG preview
- **Threshold** — binary overlay: gray = OK, red = problem area, amber = thin wall opposing grain
- **Depth Map** — continuous depth gradient: red = at the edge (zero depth), green = at or past full inlay depth

## File support

- **SVG** — parsed directly; uses the `viewBox` for natural dimensions
- **DXF** — converted to SVG via `dxf-parser`; closed polylines and splines are filled, open paths and arcs are stroked

All rendering and analysis runs in the browser using `OffscreenCanvas` and a 4-pass approximate Euclidean Distance Transform.

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Stack

- Next.js 16.2.4 (App Router, client-side only)
- React 19, TypeScript, Tailwind CSS v4
- [`dxf-parser`](https://www.npmjs.com/package/dxf-parser) for DXF support
