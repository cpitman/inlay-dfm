import { describe, it, expect } from 'vitest';
import { loadSessionFromFile, looksLikeSessionFile, type SessionFile } from './sessionExport';
import type { Layer } from '@/types';

// Build a minimal valid session file. Tests mutate copies of this to
// exercise validation paths.
function makeSession(): SessionFile {
  const layers: Layer[] = [{ colorHex: '#a52a2a', svgFragment: '<path d="M0 0h10v10h-10z"/>' }];
  return {
    version: 1,
    exportedAt: '2026-05-01T00:00:00.000Z',
    vector: {
      layers,
      naturalWidth: 100,
      naturalHeight: 80,
      viewBox: '0 0 100 80',
      fileName: 'test.svg',
      fileType: 'svg',
      detectedColors: ['#a52a2a'],
    },
    history: [{ layers, label: 'Original' }],
    historyIndex: 0,
    settings: {
      designWidthInches: 5,
      vbitAngleDegrees: 60,
      inlayDepthInches: 0.125,
      grainDirection: 'horizontal',
      analysisResolution: 'default',
      clearanceBitDiameterInches: 0.25,
      clearanceStrategy: [0.25],
      toolChangeMinutes: 5,
      plugStockMarginInches: 0.25,
      plugGlueGapInches: 0.005,
      plugSurfaceGapInches: 0.010,
      boardWidthInches: 12,
      boardHeightInches: 9,
      designOffsetXInches: 3.5,
      designOffsetYInches: 2,
    },
    woodConfigs: [{ colorHex: '#a52a2a', label: 'Cherry', species: 'cherry' }],
    backgroundSpecies: 'maple',
    ui: {
      currentStep: 1,
      maxReachedStep: 1,
      vbitTouched: false,
      hasEverAnalyzed: false,
    },
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

describe('loadSessionFromFile', () => {
  it('round-trips a valid session', async () => {
    const original = makeSession();
    const loaded = await loadSessionFromFile(asFile(original));
    expect(loaded.originalVector.layers).toHaveLength(1);
    expect(loaded.originalVector.layers[0].colorHex).toBe('#a52a2a');
    expect(loaded.originalVector.viewBox).toBe('0 0 100 80');
    // svgString is reconstructed from layers; should be a string containing the fragment
    expect(loaded.originalVector.svgString).toContain('<path d="M0 0h10v10h-10z"/>');
    expect(loaded.history).toHaveLength(1);
    expect(loaded.historyIndex).toBe(0);
    expect(loaded.settings.vbitAngleDegrees).toBe(60);
    expect(loaded.settings.clearanceStrategy).toEqual([0.25]);
    expect(loaded.woodConfigs).toEqual(original.woodConfigs);
    expect(loaded.currentStep).toBe(1);
    expect(loaded.vbitTouched).toBe(false);
  });

  it('strips cached AnalysisResults from history snapshots', async () => {
    const original = makeSession();
    const loaded = await loadSessionFromFile(asFile(original));
    expect((loaded.history[0] as { result?: unknown }).result).toBeUndefined();
  });

  it('throws on unrecognized version', async () => {
    const s = makeSession();
    (s as unknown as { version: number }).version = 999;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/version 999/);
  });

  it('throws on malformed JSON', async () => {
    const f = new File(['{not json'], 'broken.json', { type: 'application/json' });
    await expect(loadSessionFromFile(f)).rejects.toThrow(/Not a valid JSON file/);
  });

  it('throws when settings is missing', async () => {
    const s = makeSession();
    delete (s as Partial<SessionFile>).settings;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/settings/);
  });

  it('throws naming the offending field on a bad type', async () => {
    const s = makeSession() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).vbitAngleDegrees = 'sixty';
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/settings\.vbitAngleDegrees/);
  });

  it('throws on out-of-range historyIndex', async () => {
    const s = makeSession();
    (s as { historyIndex: number }).historyIndex = 5;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/historyIndex/);
  });

  it('throws on bad grainDirection enum', async () => {
    const s = makeSession() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).grainDirection = 'diagonal';
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/grainDirection/);
  });

  it('throws on bad clearanceStrategy entries', async () => {
    const s = makeSession() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).clearanceStrategy = ['big', 'small'];
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/clearanceStrategy/);
  });

  it('round-trips plug-fit settings', async () => {
    const s = makeSession();
    s.settings.plugGlueGapInches = 0.007;
    s.settings.plugSurfaceGapInches = 0.013;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.settings.plugGlueGapInches).toBe(0.007);
    expect(loaded.settings.plugSurfaceGapInches).toBe(0.013);
  });

  it('throws on bad plug-fit value type', async () => {
    const s = makeSession() as unknown as Record<string, unknown>;
    (s.settings as Record<string, unknown>).plugGlueGapInches = 'a lot';
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/plugGlueGapInches/);
  });

  it('throws on bad currentStep', async () => {
    const s = makeSession() as unknown as Record<string, unknown>;
    (s.ui as Record<string, unknown>).currentStep = 7;
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/currentStep/);
  });

  it('throws when woodConfigs entry has wrong type', async () => {
    const s = makeSession() as unknown as Record<string, unknown>;
    (s.woodConfigs as unknown[])[0] = { colorHex: 123, label: 'x', species: 'cherry' };
    await expect(loadSessionFromFile(asFile(s))).rejects.toThrow(/woodConfigs\[0\]\.colorHex/);
  });

  it('accepts a session with v-bit custom rates set', async () => {
    const s = makeSession();
    s.settings.vbitMRRInches3PerMin = 0.4;
    s.settings.vbitFeedInchesPerMin = 60;
    const loaded = await loadSessionFromFile(asFile(s));
    expect(loaded.settings.vbitMRRInches3PerMin).toBe(0.4);
    expect(loaded.settings.vbitFeedInchesPerMin).toBe(60);
  });
});
