import { describe, it, expect } from 'vitest';
import {
  monotonicAscentReachable, carvedHasComponentWithoutFullDepth,
  redetectAlignmentRisks,
} from './dfmAnalysis';

// These tests exercise the watershed-style reachability helper directly with
// hand-crafted dist1 grids. We don't go through analyzeMask (which would need
// canvas APIs) — the helper is a pure function over typed arrays.

function carved(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

function depthFromGrid(rows: number[][]): { dist1: Float32Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const dist1 = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) dist1[y * w + x] = rows[y][x];
  }
  return { dist1, w, h };
}

function isFullDepthMask(dist1: Float32Array, fdr: number): Uint8Array {
  const out = new Uint8Array(dist1.length);
  for (let i = 0; i < dist1.length; i++) if (dist1[i] >= fdr) out[i] = 1;
  return out;
}

describe('monotonicAscentReachable', () => {
  it('basin connected to a full-depth peak via a flat (equal-EDT) bridge → reachable', () => {
    // Layout (rows are dist1 values):
    //   Left 3×3 block: dist1 = 5 (full-depth at fdr=5)
    //   Single bridge cell at (3,1): dist1 = 2 (matches basin level)
    //   Right 3×3 block: dist1 = 2 (basin)
    // ≥-monotonic descent from the peak should walk: peak (5) → bridge (2) → basin (2).
    //
    // Bridge at level 2 is below the peak — descent OK. Equal-EDT moves into
    // the basin are also OK. So all basin cells should be reached.
    const { dist1, w, h } = depthFromGrid([
      [5, 5, 5, 0, 2, 2, 2],
      [5, 5, 5, 2, 2, 2, 2],
      [5, 5, 5, 0, 2, 2, 2],
    ]);
    // The "0" cells are non-carved (carvedMask = 0) — they form a wall except
    // for the single bridge at (3, 1).
    const carvedMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) carvedMask[i] = dist1[i] > 0 ? 1 : 0;
    const isFullDepth = isFullDepthMask(dist1, 5);

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    // Every basin cell (right 3×3 block) should be reachable through the bridge.
    for (let y = 0; y < 3; y++) {
      for (let x = 4; x < 7; x++) {
        expect(reachable[y * w + x]).toBe(1);
      }
    }
    // Bridge cell reached.
    expect(reachable[1 * w + 3]).toBe(1);
  });

  it('basin separated from peak by a saddle (lower than basin) → unreachable', () => {
    // Saddle is 3 columns wide (Chebyshev distance peak-to-basin > 2) so
    // the relaxed connectivity radius doesn't simply bridge across it. The
    // saddle's only mask cell is below the basin level, so reverse BFS
    // from the peak descends to it but can't ascend back up to the basin.
    const { dist1, w, h } = depthFromGrid([
      [5, 5, 5, 0, 0, 0, 2, 2, 2],
      [5, 5, 5, 0, 1, 0, 2, 2, 2],
      [5, 5, 5, 0, 0, 0, 2, 2, 2],
    ]);
    const carvedMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) carvedMask[i] = dist1[i] > 0 ? 1 : 0;
    const isFullDepth = isFullDepthMask(dist1, 5);

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    // None of the basin cells should be reachable — they're stranded by the saddle.
    for (let y = 0; y < 3; y++) {
      for (let x = 6; x < 9; x++) {
        expect(reachable[y * w + x]).toBe(0);
      }
    }
    // Bridge itself IS reachable (descent from peak 5 → bridge 1 is monotonic).
    expect(reachable[1 * w + 4]).toBe(1);
  });

  it('single full-depth seed reaches all 8-connected lower neighbors', () => {
    const { dist1, w, h } = depthFromGrid([
      [3, 4, 3],
      [4, 5, 4],
      [3, 4, 3],
    ]);
    const carvedMask = carved(w, h);
    const isFullDepth = isFullDepthMask(dist1, 5);

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    // All 9 cells reachable — center is full-depth, every neighbor has dist1 ≤ 5.
    for (let i = 0; i < w * h; i++) expect(reachable[i]).toBe(1);
  });

  it('empty full-depth set → nothing reachable', () => {
    // No pixels meet the full-depth threshold, so reverse BFS has no seeds.
    const { dist1, w, h } = depthFromGrid([
      [1, 2, 1],
      [2, 3, 2],
      [1, 2, 1],
    ]);
    const carvedMask = carved(w, h);
    const isFullDepth = isFullDepthMask(dist1, 5);   // fdr above any cell

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    for (let i = 0; i < w * h; i++) expect(reachable[i]).toBe(0);
  });

  it('local-maximum bump along the descent path → still reachable (level-set)', () => {
    // Centerline values left→right: 5, 4, 4.5, 3, 2.
    // Strict ≥-monotonic descent BFS would walk peak (5) → 4, then get stuck:
    // the neighbor at 4.5 is uphill from 4, so BFS can't descend through it,
    // and 3 / 2 (the tip side) become unreachable. This is the failure mode
    // we hit with discrete EDT noise on rotated thin features.
    //
    // Level-set reachability: at the tip's level (dist1 = 2), the level cut
    // {dist1 >= 2} contains all five pixels and they are 4-connected, so
    // they're in one component. Component contains the seed (the 5). Tip
    // is correctly reachable.
    const { dist1, w, h } = depthFromGrid([
      [5, 4, 4.5, 3, 2],
    ]);
    const carvedMask = carved(w, h);
    const isFullDepth = isFullDepthMask(dist1, 5);

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    for (let i = 0; i < w * h; i++) expect(reachable[i]).toBe(1);
  });

  it('respects carvedMask — does not cross into non-carved pixels', () => {
    // Wall of non-carved cells between peak and basin. The wall is 3 columns
    // wide so the Chebyshev distance between the two sides is > 2 (the
    // connectivity radius the analyzer uses to bridge anti-aliasing gaps).
    const w = 7, h = 3;
    const dist1 = new Float32Array(w * h);
    const carvedMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (x >= 2 && x <= 4) {
          dist1[k] = 0;
          carvedMask[k] = 0;
        } else if (x < 2) {
          dist1[k] = 5;
          carvedMask[k] = 1;
        } else {
          dist1[k] = 2;
          carvedMask[k] = 1;
        }
      }
    }
    const isFullDepth = isFullDepthMask(dist1, 5);

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    // Left side reached, right side stranded.
    for (let y = 0; y < h; y++) {
      expect(reachable[y * w + 0]).toBe(1);
      expect(reachable[y * w + 1]).toBe(1);
      expect(reachable[y * w + 5]).toBe(0);
      expect(reachable[y * w + 6]).toBe(0);
    }
  });

  it('treats single-pixel anti-aliasing gaps as still-connected', () => {
    // Diagonal pattern: pixels at (0,0), (2,1), (4,2) — adjacent in concept
    // but separated by 1-pixel gaps from anti-aliasing. With strict 8-conn
    // these are 3 separate components; with the relaxed (radius-2)
    // connectivity we use, they form one component.
    const w = 5, h = 3;
    const carvedMask = new Uint8Array(w * h);
    const dist1 = new Float32Array(w * h);
    // Two stroke pixels with a non-mask gap between, plus a full-depth
    // anchor pixel reachable through the relaxed connectivity.
    carvedMask[0 * w + 0] = 1; dist1[0 * w + 0] = 1;
    carvedMask[1 * w + 2] = 1; dist1[1 * w + 2] = 1;
    carvedMask[2 * w + 4] = 1; dist1[2 * w + 4] = 5; // full-depth seed
    const isFullDepth = isFullDepthMask(dist1, 5);

    const reachable = monotonicAscentReachable(carvedMask, dist1, isFullDepth, w, h);

    // All three pixels reachable: the 1-pixel gaps don't disconnect them
    // under the relaxed connectivity used to bridge anti-aliasing artifacts.
    expect(reachable[0 * w + 0]).toBe(1);
    expect(reachable[1 * w + 2]).toBe(1);
    expect(reachable[2 * w + 4]).toBe(1);
  });
});

describe('carvedHasComponentWithoutFullDepth', () => {
  // The full-depth threshold for these tests is 5; any pixel with dist1 >= 5
  // counts as full-depth.

  it('single component containing a full-depth pixel → false', () => {
    const { dist1, w, h } = depthFromGrid([
      [3, 4, 5, 4, 3],
    ]);
    const mask = carved(w, h);
    expect(carvedHasComponentWithoutFullDepth(mask, dist1, 5, w, h)).toBe(false);
  });

  it('single component with no full-depth pixel → true', () => {
    const { dist1, w, h } = depthFromGrid([
      [3, 4, 4, 4, 3],
    ]);
    const mask = carved(w, h);
    expect(carvedHasComponentWithoutFullDepth(mask, dist1, 5, w, h)).toBe(true);
  });

  it('two carved components, only one has full-depth → true', () => {
    // Carved row at y=0 (no full-depth), separator block of 3 empty rows
    // (so Chebyshev distance > 2, beyond the connectivity radius the
    // analyzer uses to bridge anti-aliasing gaps), and a carved row at y=4
    // containing a full-depth pixel.
    const w = 5, h = 5;
    const dist1 = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) { mask[x] = 1; dist1[x] = 4; }
    for (let x = 0; x < w; x++) { mask[4 * w + x] = 1; dist1[4 * w + x] = x === 2 ? 5 : 4; }

    expect(carvedHasComponentWithoutFullDepth(mask, dist1, 5, w, h)).toBe(true);
  });

  it('two carved blobs separated by ONE empty row → bridged by relaxed connectivity → false', () => {
    // The kind of single-pixel gap anti-aliased rasterization can introduce
    // in a thin diagonal stroke. Even though the empty row breaks strict
    // 8-conn, our relaxed (radius-2) connectivity bridges it, so the top
    // row sees the bottom row's full-depth pixel and the result is "no
    // isolated component".
    const w = 5, h = 3;
    const dist1 = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) { mask[x] = 1; dist1[x] = 4; }
    for (let x = 0; x < w; x++) { mask[2 * w + x] = 1; dist1[2 * w + x] = x === 2 ? 5 : 4; }

    expect(carvedHasComponentWithoutFullDepth(mask, dist1, 5, w, h)).toBe(false);
  });

  it('barbell (two lobes joined by a thin saddle, each lobe full-depth) → false', () => {
    // Both lobes have a full-depth pixel; even though the saddle dips
    // below full-depth, the entire barbell is one carved component and
    // it does contain a full-depth pixel.
    const { dist1, w, h } = depthFromGrid([
      [5, 5, 1, 5, 5],
    ]);
    const mask = carved(w, h);
    expect(carvedHasComponentWithoutFullDepth(mask, dist1, 5, w, h)).toBe(false);
  });

  it('empty mask → false (nothing to flag)', () => {
    const w = 4, h = 4;
    const mask = new Uint8Array(w * h);
    const dist1 = new Float32Array(w * h);
    expect(carvedHasComponentWithoutFullDepth(mask, dist1, 5, w, h)).toBe(false);
  });
});

/** Stamp a filled axis-aligned rectangle into a w×h mask, in place. */
function stamp(mask: Uint8Array, w: number, x: number, y: number, rw: number, rh: number) {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      mask[(y + dy) * w + (x + dx)] = 1;
    }
  }
}

describe('redetectAlignmentRisks', () => {
  it('returns empty issue lists for an empty colorOrder', () => {
    const out = redetectAlignmentRisks(new Map(), [], 100, 100, 1);
    expect(out.size).toBe(0);
  });

  it('initializes every color in the order with an empty list, even when no masks are supplied', () => {
    const out = redetectAlignmentRisks(new Map(), ['#aaa', '#bbb'], 100, 100, 1);
    expect(out.size).toBe(2);
    expect(out.get('#aaa')).toEqual([]);
    expect(out.get('#bbb')).toEqual([]);
  });

  it('reports no risks for two well-separated rectangles', () => {
    const w = 30, h = 10;
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    stamp(a, w, 1, 3, 4, 4);
    stamp(b, w, 20, 3, 4, 4);
    const out = redetectAlignmentRisks(
      new Map([['#aaa', a], ['#bbb', b]]),
      ['#aaa', '#bbb'], w, h, 1,
    );
    expect(out.get('#aaa')).toEqual([]);
    expect(out.get('#bbb')).toEqual([]);
  });

  it('reports an issue on the EARLIER layer when boundaries are within threshold', () => {
    // Two 4x4 rects with a 1-px gap between them; threshold 2 px → hit.
    const w = 20, h = 10;
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    stamp(a, w, 1, 3, 4, 4);   // x = 1..4
    stamp(b, w, 6, 3, 4, 4);   // x = 6..9
    const out = redetectAlignmentRisks(
      new Map([['#aaa', a], ['#bbb', b]]),
      ['#aaa', '#bbb'], w, h, 3,
    );
    // Risk recorded on the EARLIER layer (#aaa, first in colorOrder).
    expect(out.get('#aaa')).toHaveLength(1);
    expect(out.get('#aaa')![0].otherColorHex).toBe('#bbb');
    expect(out.get('#aaa')![0].affectedPercent).toBeGreaterThan(0);
    expect(out.get('#bbb')).toEqual([]);
  });

  it('reports issues for a chain: a near b, b near c', () => {
    const w = 30, h = 10;
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    const c = new Uint8Array(w * h);
    stamp(a, w, 1,  3, 4, 4);
    stamp(b, w, 6,  3, 4, 4);
    stamp(c, w, 11, 3, 4, 4);
    const out = redetectAlignmentRisks(
      new Map([['#aaa', a], ['#bbb', b], ['#ccc', c]]),
      ['#aaa', '#bbb', '#ccc'], w, h, 3,
    );
    expect(out.get('#aaa')!.map(i => i.otherColorHex)).toEqual(['#bbb']);
    expect(out.get('#bbb')!.map(i => i.otherColorHex)).toEqual(['#ccc']);
    expect(out.get('#ccc')).toEqual([]);
  });

  it('skips colors that are missing from the mask map (defensive)', () => {
    const w = 20, h = 10;
    const a = new Uint8Array(w * h);
    stamp(a, w, 1, 3, 4, 4);
    const out = redetectAlignmentRisks(
      new Map([['#aaa', a]]),
      ['#aaa', '#bbb'], w, h, 3,
    );
    expect(out.get('#aaa')).toEqual([]);
    expect(out.get('#bbb')).toEqual([]);
  });

  it('a layer that fills its hole drops the alignment issue: re-detect produces no risk', () => {
    // Motivating case for this helper. Layer A is a 10x10 square with
    // an interior 4x4 hole. Layer B sits inside A's hole as a 2x2
    // island, 1 px from A's hole edge.
    // BEFORE fill: A's hole boundary is within 2-px threshold of B's
    // boundary → alignment risk.
    // AFTER fill (A becomes solid, with B fully inside it):
    // A has no boundary near B, so re-detect reports nothing.
    const w = 16, h = 16;
    const aWithHole = new Uint8Array(w * h);
    const aSolid    = new Uint8Array(w * h);
    stamp(aWithHole, w, 3, 3, 10, 10);
    stamp(aSolid,    w, 3, 3, 10, 10);
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        aWithHole[(6 + dy) * w + (6 + dx)] = 0;
      }
    }
    const b = new Uint8Array(w * h);
    stamp(b, w, 7, 7, 2, 2);

    const before = redetectAlignmentRisks(
      new Map([['#aaa', aWithHole], ['#bbb', b]]),
      ['#aaa', '#bbb'], w, h, 3,
    );
    expect(before.get('#aaa')).toHaveLength(1);

    const after = redetectAlignmentRisks(
      new Map([['#aaa', aSolid], ['#bbb', b]]),
      ['#aaa', '#bbb'], w, h, 3,
    );
    expect(after.get('#aaa')).toEqual([]);
  });
});
