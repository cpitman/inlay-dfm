import type {
  DFMSettings, VectorData, WoodConfig, WoodSpeciesKey, Layer, LayerSnapshot,
} from '@/types';
import { combineLayers } from './svgLayers';

/**
 * Bump when the session schema changes in a backward-incompatible way.
 * `loadSession` rejects files with a different version so we never
 * silently apply a malformed state.
 */
const SCHEMA_VERSION = 1;

/**
 * Persistable subset of an analyzer session — everything the user has
 * configured plus the design itself, but NOT the analysis results
 * (which are large, contain typed-array masks that don't survive JSON
 * round-trips, and are regeneratable from the saved state).
 *
 * On load the recipient must re-run analysis (the stepper gates Step 2
 * onward on a fresh result), but every input that produced the original
 * analysis is restored exactly — so the result is reproducible.
 */
export interface SessionFile {
  version: number;
  exportedAt: string;
  /** Source design — combined `svgString` is reconstructed from layers on load. */
  vector: {
    layers: Layer[];
    naturalWidth: number;
    naturalHeight: number;
    viewBox: string;
    fileName: string;
    fileType: 'svg' | 'dxf';
    detectedColors: string[];
  };
  /** Geometry-modification history. `result` is intentionally stripped from snapshots. */
  history: { layers: Layer[]; label: string }[];
  historyIndex: number;
  settings: DFMSettings;
  woodConfigs: WoodConfig[];
  backgroundSpecies: WoodSpeciesKey;
  ui: {
    currentStep: 1 | 2 | 3 | 4;
    maxReachedStep: 1 | 2 | 3 | 4;
    vbitTouched: boolean;
    hasEverAnalyzed: boolean;
  };
}

interface SaveSessionInput {
  originalVector: VectorData;
  history: LayerSnapshot[];
  historyIndex: number;
  settings: DFMSettings;
  woodConfigs: WoodConfig[];
  backgroundSpecies: WoodSpeciesKey;
  currentStep: 1 | 2 | 3 | 4;
  maxReachedStep: 1 | 2 | 3 | 4;
  vbitTouched: boolean;
  hasEverAnalyzed: boolean;
}

/** Serialize a session and trigger a browser download. */
export function saveSessionToFile(input: SaveSessionInput): void {
  const file: SessionFile = {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    vector: {
      layers: input.originalVector.layers,
      naturalWidth: input.originalVector.naturalWidth,
      naturalHeight: input.originalVector.naturalHeight,
      viewBox: input.originalVector.viewBox,
      fileName: input.originalVector.fileName,
      fileType: input.originalVector.fileType,
      detectedColors: input.originalVector.detectedColors,
    },
    history: input.history.map(s => ({ layers: s.layers, label: s.label })),
    historyIndex: input.historyIndex,
    settings: input.settings,
    woodConfigs: input.woodConfigs,
    backgroundSpecies: input.backgroundSpecies,
    ui: {
      currentStep: input.currentStep,
      maxReachedStep: input.maxReachedStep,
      vbitTouched: input.vbitTouched,
      hasEverAnalyzed: input.hasEverAnalyzed,
    },
  };

  const json = JSON.stringify(file);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sessionFileName(input.originalVector.fileName);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sessionFileName(designName: string): string {
  const base = designName.replace(/\.(svg|dxf|json)$/i, '');
  return `${base || 'design'}.inlay-session.json`;
}

export interface LoadedSession {
  /** Reconstructed VectorData with svgString rebuilt from layers. */
  originalVector: VectorData;
  history: LayerSnapshot[];
  historyIndex: number;
  settings: DFMSettings;
  woodConfigs: WoodConfig[];
  backgroundSpecies: WoodSpeciesKey;
  currentStep: 1 | 2 | 3 | 4;
  maxReachedStep: 1 | 2 | 3 | 4;
  vbitTouched: boolean;
  hasEverAnalyzed: boolean;
}

/**
 * Tiny ad-hoc validation helpers. Each throws a specific message naming
 * the offending field instead of a generic schema-failure error, since
 * the user typically can't fix the file directly — the precise location
 * helps decide whether to re-export or troubleshoot.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function expectFiniteNumber(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) throw new Error(`Session field "${path}" must be a finite number.`);
  return value;
}
function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`Session field "${path}" must be a string.`);
  return value;
}
function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Session field "${path}" must be a boolean.`);
  return value;
}
function expectStepNumber(value: unknown, path: string): 1 | 2 | 3 | 4 {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4) {
    throw new Error(`Session field "${path}" must be 1, 2, 3, or 4.`);
  }
  return value;
}
function expectLayer(value: unknown, path: string): Layer {
  if (!value || typeof value !== 'object') throw new Error(`Session field "${path}" must be an object.`);
  const l = value as Partial<Layer>;
  return {
    colorHex: expectString(l.colorHex, `${path}.colorHex`),
    svgFragment: expectString(l.svgFragment, `${path}.svgFragment`),
  };
}
function expectLayerArray(value: unknown, path: string): Layer[] {
  if (!Array.isArray(value)) throw new Error(`Session field "${path}" must be an array.`);
  return value.map((l, i) => expectLayer(l, `${path}[${i}]`));
}

function validateSettings(value: unknown): DFMSettings {
  if (!value || typeof value !== 'object') throw new Error('Session "settings" must be an object.');
  const s = value as Partial<DFMSettings>;
  return {
    designWidthInches:        expectFiniteNumber(s.designWidthInches,        'settings.designWidthInches'),
    vbitAngleDegrees:         expectFiniteNumber(s.vbitAngleDegrees,         'settings.vbitAngleDegrees'),
    inlayDepthInches:         expectFiniteNumber(s.inlayDepthInches,         'settings.inlayDepthInches'),
    grainDirection:           (() => {
      const g = s.grainDirection;
      if (g !== 'horizontal' && g !== 'vertical' && g !== 'end') {
        throw new Error('Session field "settings.grainDirection" must be horizontal, vertical, or end.');
      }
      return g;
    })(),
    analysisResolution:       (() => {
      const r = s.analysisResolution;
      if (r !== 'low' && r !== 'default' && r !== 'high') {
        throw new Error('Session field "settings.analysisResolution" must be low, default, or high.');
      }
      return r;
    })(),
    clearanceBitDiameterInches: (() => {
      const d = s.clearanceBitDiameterInches;
      if (d !== 0.125 && d !== 0.25 && d !== 0.5) {
        throw new Error('Session field "settings.clearanceBitDiameterInches" must be 0.125, 0.25, or 0.5.');
      }
      return d;
    })(),
    clearanceStrategy:        (() => {
      if (!Array.isArray(s.clearanceStrategy)) {
        throw new Error('Session field "settings.clearanceStrategy" must be an array of bit diameters.');
      }
      return s.clearanceStrategy.map((d, i) => expectFiniteNumber(d, `settings.clearanceStrategy[${i}]`));
    })(),
    toolChangeMinutes:        expectFiniteNumber(s.toolChangeMinutes,        'settings.toolChangeMinutes'),
    plugStockMarginInches:    expectFiniteNumber(s.plugStockMarginInches,    'settings.plugStockMarginInches'),
    plugGlueGapInches:        expectFiniteNumber(s.plugGlueGapInches,        'settings.plugGlueGapInches'),
    plugSurfaceGapInches:     expectFiniteNumber(s.plugSurfaceGapInches,     'settings.plugSurfaceGapInches'),
    boardWidthInches:         expectFiniteNumber(s.boardWidthInches,         'settings.boardWidthInches'),
    boardHeightInches:        expectFiniteNumber(s.boardHeightInches,        'settings.boardHeightInches'),
    designOffsetXInches:      expectFiniteNumber(s.designOffsetXInches,      'settings.designOffsetXInches'),
    designOffsetYInches:      expectFiniteNumber(s.designOffsetYInches,      'settings.designOffsetYInches'),
    vbitMRRInches3PerMin:     s.vbitMRRInches3PerMin === undefined ? undefined : expectFiniteNumber(s.vbitMRRInches3PerMin, 'settings.vbitMRRInches3PerMin'),
    vbitFeedInchesPerMin:     s.vbitFeedInchesPerMin === undefined ? undefined : expectFiniteNumber(s.vbitFeedInchesPerMin, 'settings.vbitFeedInchesPerMin'),
  };
}

function validateWoodConfigs(value: unknown): WoodConfig[] {
  if (!Array.isArray(value)) throw new Error('Session field "woodConfigs" must be an array.');
  return value.map((wc, i) => {
    if (!wc || typeof wc !== 'object') throw new Error(`Session field "woodConfigs[${i}]" must be an object.`);
    const w = wc as Partial<WoodConfig>;
    return {
      colorHex: expectString(w.colorHex, `woodConfigs[${i}].colorHex`),
      label:    expectString(w.label,    `woodConfigs[${i}].label`),
      species:  expectString(w.species,  `woodConfigs[${i}].species`) as WoodSpeciesKey,
    };
  });
}

/**
 * Read a session file and validate its schema. Throws on parse error,
 * version mismatch, missing required fields, or wrong field types.
 *
 * Cached AnalysisResults are NOT in the file — caller should expect a
 * stale result state and prompt re-analysis on Step 2.
 */
export async function loadSessionFromFile(file: File): Promise<LoadedSession> {
  const text = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('Not a valid JSON file: ' + (e as Error).message);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('Session file is empty or malformed.');
  }
  const sf = raw as Partial<SessionFile>;
  if (sf.version !== SCHEMA_VERSION) {
    throw new Error(
      `Session file version ${sf.version ?? '?'} is not supported (this app expects v${SCHEMA_VERSION}).`,
    );
  }
  if (!sf.vector || typeof sf.vector !== 'object') {
    throw new Error('Session file is missing required "vector" data.');
  }
  const vRaw = sf.vector as Partial<SessionFile['vector']>;
  const vectorLayers = expectLayerArray(vRaw.layers, 'vector.layers');
  const vectorNaturalWidth  = expectFiniteNumber(vRaw.naturalWidth,  'vector.naturalWidth');
  const vectorNaturalHeight = expectFiniteNumber(vRaw.naturalHeight, 'vector.naturalHeight');
  const vectorViewBox  = expectString(vRaw.viewBox,  'vector.viewBox');
  const vectorFileName = expectString(vRaw.fileName, 'vector.fileName');
  if (vRaw.fileType !== 'svg' && vRaw.fileType !== 'dxf') {
    throw new Error('Session field "vector.fileType" must be "svg" or "dxf".');
  }
  if (!Array.isArray(vRaw.detectedColors)) {
    throw new Error('Session field "vector.detectedColors" must be an array.');
  }
  const vectorDetectedColors = vRaw.detectedColors.map((c, i) => expectString(c, `vector.detectedColors[${i}]`));

  if (!Array.isArray(sf.history)) {
    throw new Error('Session field "history" must be an array.');
  }
  const history: LayerSnapshot[] = sf.history.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`Session field "history[${i}]" must be an object.`);
    return {
      layers: expectLayerArray((s as { layers: unknown }).layers, `history[${i}].layers`),
      label:  expectString((s as { label: unknown }).label,        `history[${i}].label`),
    };
  });
  const historyIndex = expectFiniteNumber(sf.historyIndex, 'historyIndex');
  if (historyIndex < 0 || historyIndex >= history.length) {
    throw new Error(`Session field "historyIndex" (${historyIndex}) is out of range for history of length ${history.length}.`);
  }

  const settings = validateSettings(sf.settings);
  const woodConfigs = validateWoodConfigs(sf.woodConfigs);
  const backgroundSpecies = expectString(sf.backgroundSpecies, 'backgroundSpecies') as WoodSpeciesKey;

  if (!sf.ui || typeof sf.ui !== 'object') {
    throw new Error('Session field "ui" must be an object.');
  }
  const ui = sf.ui as Partial<SessionFile['ui']>;
  const currentStep    = expectStepNumber(ui.currentStep,    'ui.currentStep');
  const maxReachedStep = expectStepNumber(ui.maxReachedStep, 'ui.maxReachedStep');
  const vbitTouched    = expectBoolean(ui.vbitTouched,       'ui.vbitTouched');
  const hasEverAnalyzed = expectBoolean(ui.hasEverAnalyzed,  'ui.hasEverAnalyzed');

  const originalVector: VectorData = {
    layers: vectorLayers,
    naturalWidth: vectorNaturalWidth,
    naturalHeight: vectorNaturalHeight,
    viewBox: vectorViewBox,
    fileName: vectorFileName,
    fileType: vRaw.fileType,
    detectedColors: vectorDetectedColors,
    svgString: combineLayers(vectorLayers, vectorViewBox, vectorNaturalWidth, vectorNaturalHeight),
  };

  return {
    originalVector,
    history,
    historyIndex,
    settings,
    woodConfigs,
    backgroundSpecies,
    currentStep,
    maxReachedStep,
    vbitTouched,
    hasEverAnalyzed,
  };
}

/** Test whether a file looks like a session JSON by extension. */
export function looksLikeSessionFile(file: File): boolean {
  return /\.json$/i.test(file.name);
}
