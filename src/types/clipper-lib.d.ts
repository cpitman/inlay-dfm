/**
 * Minimal ambient declarations for `clipper-lib` (v6.4.x), which
 * ships untyped. Covers only the surface used by `src/lib/clipperOps.ts` —
 * if more API is needed later, extend here.
 */
declare module 'clipper-lib' {
  export interface IntPoint {
    X: number;
    Y: number;
  }

  export type Path = IntPoint[];
  export type Paths = Path[];

  export const ClipType: {
    ctIntersection: number;
    ctUnion: number;
    ctDifference: number;
    ctXor: number;
  };

  export const PolyType: {
    ptSubject: number;
    ptClip: number;
  };

  export const PolyFillType: {
    pftEvenOdd: number;
    pftNonZero: number;
    pftPositive: number;
    pftNegative: number;
  };

  export const JoinType: {
    jtRound: number;
    jtSquare: number;
    jtMiter: number;
  };

  export const EndType: {
    etClosedPolygon: number;
    etClosedLine: number;
    etOpenButt: number;
    etOpenSquare: number;
    etOpenRound: number;
  };

  export class Clipper {
    constructor(initOptions?: number);
    AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
    AddPath(path: Path, polyType: number, closed: boolean): boolean;
    Execute(
      clipType: number,
      solution: Paths,
      subjFillType?: number,
      clipFillType?: number,
    ): boolean;
    Execute(
      clipType: number,
      solution: PolyTree,
      subjFillType?: number,
      clipFillType?: number,
    ): boolean;
    Clear(): void;
  }

  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPaths(paths: Paths, joinType: number, endType: number): void;
    AddPath(path: Path, joinType: number, endType: number): void;
    Execute(solution: Paths, delta: number): void;
    Clear(): void;
  }

  export class PolyNode {
    Contour(): Path;
    Childs(): PolyNode[];
    Parent(): PolyNode | null;
    IsHole(): boolean;
    ChildCount(): number;
  }

  export class PolyTree extends PolyNode {
    Clear(): void;
    GetFirst(): PolyNode | null;
    Total(): number;
  }

  // Default export aggregates everything (clipper-lib's UMD style).
  const ClipperLib: {
    Clipper: typeof Clipper;
    ClipperOffset: typeof ClipperOffset;
    PolyTree: typeof PolyTree;
    PolyNode: typeof PolyNode;
    ClipType: typeof ClipType;
    PolyType: typeof PolyType;
    PolyFillType: typeof PolyFillType;
    JoinType: typeof JoinType;
    EndType: typeof EndType;
    Path: new () => Path;
    Paths: new () => Paths;
  };
  export default ClipperLib;
}
