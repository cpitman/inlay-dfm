/**
 * Axis-aligned bounding box utilities for the multi-design layout.
 * Used by Step 2 (guided) to validate placements before commit and to
 * pick a default position for newly-uploaded designs.
 *
 * Boxes are `{ x, y, w, h }` in inches, anchored at the top-left of
 * the board. "Touching but not overlapping" is treated as NOT
 * overlapping — strict-inequality semantics so two designs sharing an
 * edge are allowed.
 */

export interface AABB {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True when two AABBs share interior area. Edge-touching is allowed. */
export function boxesOverlap(a: AABB, b: AABB): boolean {
  return a.x < b.x + b.w
      && b.x < a.x + a.w
      && a.y < b.y + b.h
      && b.y < a.y + a.h;
}

/** True when `box` would overlap any of `others` (edge-touching allowed). */
export function overlapsAny(box: AABB, others: readonly AABB[]): boolean {
  for (const other of others) if (boxesOverlap(box, other)) return true;
  return false;
}

/**
 * Pick a placement origin for a new box of size (`w` × `h`) inside a
 * `bounds` rectangle that doesn't overlap any of `existing`. Tries:
 *   1. Right of each existing box (top-aligned).
 *   2. Below each existing box (left-aligned).
 *   3. The bounds origin.
 * Returns null when nothing fits — the caller can fall back to an
 * arbitrary placement and let the user fix the overlap manually.
 */
export function findFreeSpot(
  w: number,
  h: number,
  bounds: AABB,
  existing: readonly AABB[],
): { x: number; y: number } | null {
  // Quick exit: doesn't fit at all.
  if (w > bounds.w || h > bounds.h) return null;

  const candidates: Array<{ x: number; y: number }> = [];
  for (const e of existing) {
    candidates.push({ x: e.x + e.w, y: e.y });           // right of e
    candidates.push({ x: e.x,       y: e.y + e.h });     // below e
  }
  candidates.push({ x: bounds.x, y: bounds.y });

  for (const c of candidates) {
    const cx = Math.max(bounds.x, Math.min(bounds.x + bounds.w - w, c.x));
    const cy = Math.max(bounds.y, Math.min(bounds.y + bounds.h - h, c.y));
    const probe: AABB = { x: cx, y: cy, w, h };
    if (!overlapsAny(probe, existing)) return { x: cx, y: cy };
  }
  return null;
}
