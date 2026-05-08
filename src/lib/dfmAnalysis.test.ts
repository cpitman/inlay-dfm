import { describe, it, expect } from 'vitest';
import {
  redetectAlignmentRisks, binarySearchLargestFeasibleIdx,
} from './dfmAnalysis';

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

describe('binarySearchLargestFeasibleIdx', () => {
  // Build a predicate that flips from `true` to `false` at `flipAt`.
  // Models design-wide feasibility's monotonicity in v-bit angle.
  function makePredicate(flipAt: number) {
    let calls = 0;
    const isFeasible = (i: number) => {
      calls++;
      return i < flipAt;
    };
    return { isFeasible, getCalls: () => calls };
  }

  it('returns -1 for length 0', () => {
    expect(binarySearchLargestFeasibleIdx(0, () => true)).toBe(-1);
  });

  it('all true → returns last index', () => {
    expect(binarySearchLargestFeasibleIdx(6, () => true)).toBe(5);
    expect(binarySearchLargestFeasibleIdx(1, () => true)).toBe(0);
  });

  it('all false → returns -1', () => {
    expect(binarySearchLargestFeasibleIdx(6, () => false)).toBe(-1);
    expect(binarySearchLargestFeasibleIdx(1, () => false)).toBe(-1);
  });

  it('finds the largest-true index for every flip point in [0, 6]', () => {
    // Predicate is monotonic: true for i < flipAt, false for i >= flipAt.
    // Largest-true is `flipAt - 1` (or -1 when flipAt = 0).
    for (let flipAt = 0; flipAt <= 6; flipAt++) {
      const { isFeasible } = makePredicate(flipAt);
      const expected = flipAt - 1;
      expect(binarySearchLargestFeasibleIdx(6, isFeasible)).toBe(expected);
    }
  });

  it('probes at most ⌈log₂(length)⌉ + 1 indices', () => {
    // For length=6, log₂(6) ≈ 2.585 → ceil = 3 → cap = 4.
    const cap = Math.ceil(Math.log2(6)) + 1;
    for (let flipAt = 0; flipAt <= 6; flipAt++) {
      const { isFeasible, getCalls } = makePredicate(flipAt);
      binarySearchLargestFeasibleIdx(6, isFeasible);
      expect(getCalls()).toBeLessThanOrEqual(cap);
    }
  });

  it('always probes index 0 when no preset is feasible (so Phase 5.5 fallback has data)', () => {
    // Phase 5.5's "no feasible" branch needs preset 0's mask for the
    // irreducibleProblemMask. Binary search must touch index 0 along
    // its descent on a fully-infeasible predicate.
    const probed = new Set<number>();
    binarySearchLargestFeasibleIdx(6, (i) => { probed.add(i); return false; });
    expect(probed.has(0)).toBe(true);
  });

  it('caches largestFeasibleIdx + 1 along the search path when largest exists and is < length-1', () => {
    // Phase 5.5's "feasible" branch wants stats at largestFeasible+1
    // for the wider-bit suggestion overlay. The search must touch
    // largestFeasible+1 to flip lo > hi, so the cache always has it.
    for (let flipAt = 1; flipAt < 6; flipAt++) {
      const probed = new Set<number>();
      binarySearchLargestFeasibleIdx(6, (i) => { probed.add(i); return i < flipAt; });
      // Largest-feasible is flipAt - 1; the search must have probed flipAt
      // itself (the flip point) to confirm it's infeasible.
      expect(probed.has(flipAt)).toBe(true);
    }
  });
});
