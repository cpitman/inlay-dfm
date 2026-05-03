import { describe, it, expect } from 'vitest';
import { topoSortByArea } from './layerOrderOptimizer';

describe('topoSortByArea', () => {
  it('sorts purely by ascending area when there are no constraints', () => {
    const initial = ['A', 'B', 'C'];
    const areas = new Map([['A', 5], ['B', 1], ['C', 3]]);
    expect(topoSortByArea(initial, areas, [])).toEqual(['B', 'C', 'A']);
  });

  it('preserves user order when two layers overlap, even if area would reorder them', () => {
    // A (large) is drawn before B (small) in the user's stack and they
    // overlap → carving order MUST be A, then B. Without the constraint
    // the area sort would put B first.
    const initial = ['A', 'B'];
    const areas = new Map([['A', 10], ['B', 1]]);
    const plan = topoSortByArea(initial, areas, [['A', 'B']]);
    expect(plan).toEqual(['A', 'B']);
  });

  it('respects a chain of constraints', () => {
    // A → B → C with no overlap A-C. Areas would sort C, B, A. But the
    // chain forces the user's original order.
    const initial = ['A', 'B', 'C'];
    const areas = new Map([['A', 9], ['B', 5], ['C', 1]]);
    const plan = topoSortByArea(initial, areas, [['A', 'B'], ['B', 'C']]);
    expect(plan).toEqual(['A', 'B', 'C']);
  });

  it('mixes constraints with free layers — sorts free ones by area', () => {
    // A overlaps B (forces A before B). C and D are free. Areas:
    // A=10, B=2, C=1, D=8. Available pool starts {A, C, D}. Smallest
    // is C → output C. Then {A, D}: smallest D → output D. Then {A}:
    // output A; B becomes free → output B.
    const initial = ['A', 'B', 'C', 'D'];
    const areas = new Map([['A', 10], ['B', 2], ['C', 1], ['D', 8]]);
    const plan = topoSortByArea(initial, areas, [['A', 'B']]);
    expect(plan).toEqual(['C', 'D', 'A', 'B']);
  });

  it('breaks ties by original order', () => {
    const initial = ['A', 'B', 'C'];
    const areas = new Map([['A', 5], ['B', 5], ['C', 5]]);
    expect(topoSortByArea(initial, areas, [])).toEqual(['A', 'B', 'C']);
  });

  it('handles boundary-shared (no constraint) layers as free', () => {
    // Real-world parallel: two adjacent puzzle-piece inlays. The
    // pre-pass produced no overlap constraint between them, so they
    // sort freely by area.
    const initial = ['L', 'R'];
    const areas = new Map([['L', 5], ['R', 1]]);
    expect(topoSortByArea(initial, areas, [])).toEqual(['R', 'L']);
  });

  it('returns an empty list for an empty input', () => {
    expect(topoSortByArea([], new Map(), [])).toEqual([]);
  });

  it('throws on a cycle (defensive — real input is always a linear stack)', () => {
    expect(() =>
      topoSortByArea(['A', 'B'], new Map([['A', 1], ['B', 1]]), [['A', 'B'], ['B', 'A']])
    ).toThrow();
  });

  it('ignores constraints referring to colors not in initialOrder', () => {
    const initial = ['A', 'B'];
    const areas = new Map([['A', 5], ['B', 1]]);
    // Junk constraint involving 'X' (not in initial) is silently dropped.
    expect(topoSortByArea(initial, areas, [['X', 'A'], ['B', 'X']])).toEqual(['B', 'A']);
  });
});
