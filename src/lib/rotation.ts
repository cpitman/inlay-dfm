import type { Placement, RotationDegrees } from '@/types';
import type { AABB } from './aabb';

export type { RotationDegrees };

/** All supported rotation values, ordered clockwise from 0°. */
export const ROTATION_VALUES: readonly RotationDegrees[] = [0, 90, 180, 270];

export function isValidRotation(v: unknown): v is RotationDegrees {
  return v === 0 || v === 90 || v === 180 || v === 270;
}

/** True when the rotation swaps the design's width and height axes. */
export function isQuarterTurn(rotation: RotationDegrees | undefined): boolean {
  return ((rotation ?? 0) % 180) !== 0;
}

/** Cycle 0° → 90° → 180° → 270° → 0°. */
export function rotateRight(rotation: RotationDegrees | undefined): RotationDegrees {
  const cur = (rotation ?? 0) as RotationDegrees;
  return ROTATION_VALUES[(ROTATION_VALUES.indexOf(cur) + 1) % 4];
}

/** Cycle 0° → 270° → 180° → 90° → 0°. */
export function rotateLeft(rotation: RotationDegrees | undefined): RotationDegrees {
  const cur = (rotation ?? 0) as RotationDegrees;
  return ROTATION_VALUES[(ROTATION_VALUES.indexOf(cur) + 3) % 4];
}

/**
 * Visible AABB on the board for a placed design — accounts for 90°-step
 * rotation by swapping width and height when the rotation is a quarter
 * turn. `(x, y)` is the top-left of the *visible* AABB; `w × h` is
 * `(designWidth, designHeight)` for 0°/180° rotation, and the swapped
 * `(designHeight, designWidth)` for 90°/270°.
 *
 * Drag, resize, and collision-detection use this AABB so the user
 * interacts with the box they actually see on the board.
 */
export function effectivePlacementAabb(
  p: Placement,
  naturalWidth: number,
  naturalHeight: number,
): AABB {
  const aspect = naturalHeight / naturalWidth;
  const w0 = p.designWidthInches;
  const h0 = w0 * aspect;
  const turned = isQuarterTurn(p.rotationDegrees);
  return {
    x: p.offsetXInches,
    y: p.offsetYInches,
    w: turned ? h0 : w0,
    h: turned ? w0 : h0,
  };
}

/**
 * Visible aspect ratio (`visibleHeight / visibleWidth`) that resize
 * handles must preserve. Reciprocal of the natural aspect for 90°/270°.
 */
export function visibleAspectRatio(
  naturalAspect: number,
  rotation: RotationDegrees | undefined,
): number {
  return isQuarterTurn(rotation) ? 1 / naturalAspect : naturalAspect;
}

/**
 * Translate a visible-AABB width back to the underlying
 * `designWidthInches` (which is always the *unrotated* horizontal
 * extent on the board). Resize handles operate in visible space; the
 * stored placement keeps its pre-rotation width semantics.
 */
export function visibleWidthToDesignWidth(
  visibleWidth: number,
  naturalAspect: number,
  rotation: RotationDegrees | undefined,
): number {
  return isQuarterTurn(rotation) ? visibleWidth / naturalAspect : visibleWidth;
}

/** Inverse of `visibleWidthToDesignWidth` — the visible width given a `designWidth`. */
export function designWidthToVisibleWidth(
  designWidth: number,
  naturalAspect: number,
  rotation: RotationDegrees | undefined,
): number {
  return isQuarterTurn(rotation) ? designWidth * naturalAspect : designWidth;
}
