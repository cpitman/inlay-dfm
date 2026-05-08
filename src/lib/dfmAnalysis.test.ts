import { describe, it, expect } from 'vitest';
import { binarySearchLargestFeasibleIdx } from './dfmAnalysis';

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
