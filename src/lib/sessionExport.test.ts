import { describe, it, expect } from 'vitest';
import {
  loadSessionFromFile, looksLikeSessionFile,
  type SessionFile, type SerializedDesign,
} from './sessionExport';
import type { Layer } from '@/types';

// Tests mutate fixtures in place to exercise validation. Use factory
// functions so each test gets a fresh, deep-copied object instead of a
// shared constant that earlier tests may have corrupted.
function freshSettings() {
  return {
    designWidthInches: 5,
    vbitAngleDegrees: 60,
    inlayDepthInches: 0.125,
    grainDirection: 'horizontal' as const,
    analysisResolution: 'default' as const,
    clearanceBitDiameterInches: 0.25 as const,
    clearanceStrategy: [0.25],
    toolChangeMinutes: 5,
    plugStockMarginInches: 0.25,
    plugGlueGapInches: 0.005,
    plugSurfaceGapInches: 0.010,
    boardWidthInches: 12,
    boardHeightInches: 9,
    designOffsetXInches: 3.5,
    designOffsetYInches: 2,
  };
}

function freshUi() {
  return {
    currentStep: 1 as const,
    maxReachedStep: 1 as const,
    vbitTouched: false,
    hasEverAnalyzed: false,
  };
}

function freshLayers(): Layer[] {
  return [{ colorHex: '#a52a2a', svgFragment: '<path d="M0 0h10v10h-10z"/>' }];
}

/** Build a v1 (legacy single-design) session for migration tests. */
function makeV1Session() {
  return {
    version: 1 as const,
    exportedAt: '2026-05-01T00:00:00.000Z',
    vector: {
      layers: freshLayers(),
      naturalWidth: 100,
      naturalHeight: 80,
      viewBox: '0 0 100 80',
      fileName: 'test.svg',
      fileType: 'svg' as const,
      detectedColors: ['#a52a2a'],
    },
    history: [{ layers: freshLayers(), label: 'Original' }],
    historyIndex: 0,
    settings: freshSettings(),
    woodConfigs: [{ colorHex: '#a52a2a', label: 'Cherry', species: 'cherry' as const }],
    backgroundSpecies: 'maple' as const,
    ui: freshUi(),
  };
}

/** Build a v2 (multi-design) session. */
function makeV2Session(): SessionFile {
  const design: SerializedDesign = {
    id: 'design-1',
    vector: {
      layers: freshLayers(),
      naturalWidth: 100,
      naturalHeight: 80,
      viewBox: '0 0 100 80',
      fileName: 'test.svg',
      fileType: 'svg',
      detectedColors: ['#a52a2a'],
    },
    history: [{ layers: freshLayers(), label: 'Original' }],
    historyIndex: 0,
    woodConfigs: [{ colorHex: '#a52a2a', label: 'Cherry', species: 'cherry' }],
  };
  return {
    version: 2,
    exportedAt: '2026-05-01T00:00:00.000Z',
    designs: [design],
    activeDesignId: 'design-1',
    settings: freshSettings(),
    backgroundSpecies: 'maple',
    ui: freshUi(),
  };
}

function asFile(s: unknown, name = 'session.inlay-session.json'): File {
  return new File([JSON.stringify(s)], name, { type: 'application/json' });
}

describe('looksLikeSessionFile', () => {
  it('matches .json by extension regardless of MIME', () => {
    const f = new File(['{}'], 'foo.json', { type: 'text/plain' });
    expect(looksLikeSessionFile(f)).toBe(true);
  });
  it('rejects non-json extensions', () => {
    expect(looksLikeSessionFile(new File(['x'], 'foo.svg'))).toBe(false);
    expect(looksLikeSessionFile(new File(['x'], 'foo.dxf'))).toBe(false);
    expect(looksLikeSessionFile(new File(['x'], 'foo'))).toBe(false);
  });
  it('matches .inlay-session.json', () => {
    expect(looksLikeSessionFile(new File(['x'], 'design.inlay-session.json'))).toBe(true);
  });
});

describe('loadSessionFromFile — v1 migration', () => {
  it('migrates a v1 session into a single-element designs array', async () => {
    const original = makeV1Session();
    const loaded = await loadSessionFromFile(asFile(original));
    expect(loaded.designs).toHaveLength(1);
    expect(loaded.designs[0].originalVector.layers).toHaveLength(1);
    expect(loaded.designs[0].originalVector.layers[0].colorHex).toBe('#a52a2a');
    expect(loaded.designs[0].originalVector.viewBox).toBe('0 0 100 80');
    // svgString reconstructed from layers
    expect(loaded.designs[0].originalVector.svgString).toContain('<path d="M0 0h10v10h-10z"/>');
    expect(loaded.designs[0].history).toHaveLength(1);
    expect(loaded.designs[0].historyIndex).toBe(0);
    expect(loaded.designs[0].woodConfigs).toEqual(original.woodConfigs);
    expect(loaded.activeDesignId).toBe(loaded.designs[0].id);
    expect(loaded.settings.vbitAngleDegrees).toBe(60);
    expect(loaded.currentStep).toBe(1);
  });

  it('strips cached AnalysisResults from history snapshots', async () => {
    const loaded = await loadSessionFromFile(asFile(makeV1Session()));
    expect((loaded.designs[0].history[0] as { result?: unknown }).result).toBeUndefined();
  });

  it('throws on out-of-range historyIndex (v1)', async () => {
    const s = makeV1Session() as { historyIndex: number };
    s.historyIndex = 5;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/historyIndex/);
  });
});

describe('loadSessionFromFile — v2 round-trip', () => {
  it('round-trips a v2 single-design session', async () => {
    const original = makeV2Session();
    const loaded = await loadSessionFromFile(asFile(original));
    expect(loaded.designs).toHaveLength(1);
    expect(loaded.designs[0].id).toBe('design-1');
    expect(loaded.activeDesignId).toBe('design-1');
    expect(loaded.designs[0].originalVector.layers[0].colorHex).toBe('#a52a2a');
    expect(loaded.designs[0].woodConfigs).toEqual(original.designs[0].woodConfigs);
  });

  it('round-trips multiple designs', async () => {
    const session = makeV2Session();
    const second: SerializedDesign = {
      id: 'design-2',
      vector: { ...session.designs[0].vector, fileName: 'second.svg' },
      history: [{ layers: freshLayers(), label: 'Original' }],
      historyIndex: 0,
      woodConfigs: [{ colorHex: '#a52a2a', label: 'Walnut', species: 'walnut' }],
    };
    session.designs.push(second);

    const loaded = await loadSessionFromFile(asFile(session));
    expect(loaded.designs).toHaveLength(2);
    expect(loaded.designs[0].id).toBe('design-1');
    expect(loaded.designs[1].id).toBe('design-2');
    expect(loaded.designs[1].originalVector.fileName).toBe('second.svg');
    expect(loaded.designs[1].woodConfigs[0].species).toBe('walnut');
  });

  it('falls back to first design id when activeDesignId is missing', async () => {
    const s = makeV2Session() as Partial<SessionFile>;
    s.activeDesignId = null;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.activeDesignId).toBe('design-1');
  });

  it('throws on unrecognized version', async () => {
    const s = makeV2Session() as unknown as { version: number };
    s.version = 999;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/version 999/);
  });

  it('throws on out-of-range historyIndex (v2)', async () => {
    const s = makeV2Session();
    s.designs[0].historyIndex = 5;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/historyIndex/);
  });

  it('throws when a design is missing required fields', async () => {
    const s = makeV2Session() as unknown as { designs: unknown[] };
    s.designs[0] = { id: 'x' }; // missing vector/history/woodConfigs
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow();
  });

  it('round-trips Design.side when present', async () => {
    const s = makeV2Session();
    (s.designs[0] as { side?: 'top' | 'bottom' }).side = 'bottom';
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].side).toBe('bottom');
  });

  it('omitted side stays undefined on load (caller treats as top)', async () => {
    const s = makeV2Session();
    delete (s.designs[0] as { side?: unknown }).side;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].side).toBeUndefined();
  });

  it('rejects an invalid side value', async () => {
    const s = makeV2Session();
    (s.designs[0] as unknown as { side: string }).side = 'sideways';
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/side/);
  });

  it('round-trips a placement with rotationDegrees', async () => {
    const s = makeV2Session();
    s.designs[0].placement = {
      offsetXInches: 1.25,
      offsetYInches: 2.5,
      designWidthInches: 4,
      rotationDegrees: 90,
    };
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].placement.offsetXInches).toBe(1.25);
    expect(loaded.designs[0].placement.offsetYInches).toBe(2.5);
    expect(loaded.designs[0].placement.designWidthInches).toBe(4);
    expect(loaded.designs[0].placement.rotationDegrees).toBe(90);
  });

  it('omitted rotationDegrees stays undefined on load (caller treats as 0)', async () => {
    const s = makeV2Session();
    s.designs[0].placement = {
      offsetXInches: 1, offsetYInches: 1, designWidthInches: 4,
    };
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].placement.rotationDegrees).toBeUndefined();
  });

  it('rejects an invalid rotationDegrees value', async () => {
    const s = makeV2Session();
    s.designs[0].placement = {
      offsetXInches: 1, offsetYInches: 1, designWidthInches: 4,
      rotationDegrees: 45 as unknown as 0,
    };
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/rotationDegrees/);
  });

  it('round-trips a placement without rotationDegrees (and now actually preserves it)', async () => {
    // Regression: prior to the rotation change, the v2 loader silently
    // dropped placement on load. This asserts the load path now passes
    // it through.
    const s = makeV2Session();
    s.designs[0].placement = {
      offsetXInches: 7.25,
      offsetYInches: 8.5,
      designWidthInches: 9.75,
    };
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].placement.offsetXInches).toBe(7.25);
    expect(loaded.designs[0].placement.offsetYInches).toBe(8.5);
    expect(loaded.designs[0].placement.designWidthInches).toBe(9.75);
  });

  it('round-trips a textSpec on a text design', async () => {
    const s = makeV2Session();
    s.designs[0].textSpec = {
      content: 'Hello',
      fontFamily: 'Inter',
      fontStyle: 'bold',
      species: 'cherry',
    };
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].textSpec).toEqual({
      content: 'Hello',
      fontFamily: 'Inter',
      fontStyle: 'bold',
      species: 'cherry',
    });
  });

  it('omitted textSpec stays undefined on load (regular uploaded designs)', async () => {
    const s = makeV2Session();
    delete (s.designs[0] as { textSpec?: unknown }).textSpec;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].textSpec).toBeUndefined();
  });

  it('round-trips a non-default textSpec.fontFamily (catalog-expanded)', async () => {
    // The validator no longer pins family to a fixed enum — any
    // non-empty string is accepted and resolved against the runtime
    // catalog by loadFont. This test asserts a Roboto-style entry
    // round-trips so the load path doesn't accidentally re-tighten
    // the check.
    const s = makeV2Session();
    s.designs[0].textSpec = {
      content: 'Hello',
      fontFamily: 'Roboto Slab',
      fontStyle: 'regular',
      species: 'walnut',
    };
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.designs[0].textSpec).toEqual({
      content: 'Hello',
      fontFamily: 'Roboto Slab',
      fontStyle: 'regular',
      species: 'walnut',
    });
  });

  it('rejects an empty textSpec.fontFamily', async () => {
    const s = makeV2Session();
    s.designs[0].textSpec = {
      content: 'X',
      fontFamily: '',
      fontStyle: 'regular',
      species: 'walnut',
    };
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/fontFamily/);
  });

  it('rejects an invalid textSpec.fontStyle', async () => {
    const s = makeV2Session();
    s.designs[0].textSpec = {
      content: 'X',
      fontFamily: 'Inter',
      fontStyle: 'extra-bold' as unknown as 'regular',
      species: 'walnut',
    };
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/fontStyle/);
  });
});

describe('loadSessionFromFile — shared validation', () => {
  it('throws on malformed JSON', async () => {
    const f = new File(['{not json'], 'broken.json', { type: 'application/json' });
    await expect(loadSessionFromFile(f)).rejects.toThrow(/Not a valid JSON file/);
  });

  it('throws when settings is missing', async () => {
    const s = makeV2Session() as Partial<SessionFile>;
    delete s.settings;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/settings/);
  });

  it('throws naming the offending field on a bad type', async () => {
    const s = makeV2Session() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).vbitAngleDegrees = 'sixty';
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/settings\.vbitAngleDegrees/);
  });

  it('throws on bad grainDirection enum', async () => {
    const s = makeV2Session() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).grainDirection = 'diagonal';
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/grainDirection/);
  });

  it('throws on bad clearanceStrategy entries', async () => {
    const s = makeV2Session() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).clearanceStrategy = ['big', 'small'];
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/clearanceStrategy/);
  });

  it('round-trips plug-fit settings', async () => {
    const s = makeV2Session();
    s.settings.plugGlueGapInches = 0.007;
    s.settings.plugSurfaceGapInches = 0.013;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.settings.plugGlueGapInches).toBe(0.007);
    expect(loaded.settings.plugSurfaceGapInches).toBe(0.013);
  });

  it('throws on bad currentStep', async () => {
    const s = makeV2Session() as unknown as Record<string, unknown>;
    (s.ui as Record<string, unknown>).currentStep = 7;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/currentStep/);
  });

  it('throws when woodConfigs entry has wrong type', async () => {
    const s = makeV2Session();
    (s.designs[0].woodConfigs as unknown[])[0] = { colorHex: 123, label: 'x', species: 'cherry' };
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/woodConfigs\[0\]\.colorHex/);
  });

  it('accepts a session with v-bit custom rates set', async () => {
    const s = makeV2Session();
    s.settings.vbitMRRInches3PerMin = 0.4;
    s.settings.vbitFeedInchesPerMin = 60;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.settings.vbitMRRInches3PerMin).toBe(0.4);
    expect(loaded.settings.vbitFeedInchesPerMin).toBe(60);
  });
});
