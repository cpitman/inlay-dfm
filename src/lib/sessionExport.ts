import type {
  DFMSettings, VectorData, WoodConfig, WoodSpeciesKey, Layer, LayerSnapshot, Placement, RotationDegrees,
} from '@/types';
import { combineLayers } from './svgLayers';
import { isValidRotation } from './rotation';

/**
 * Bump when the session schema changes in a backward-incompatible way.
 *
 * - v1: single-design session with top-level `vector`, `history`,
 *       `historyIndex`, `woodConfigs`. Loader migrates these into a
 *       single-element `designs[]` so multi-design code paths can
 *       consume them uniformly.
 * - v2: multi-design session with `designs: SerializedDesign[]` and
 *       an `activeDesignId`. Each design carries its own vector,
 *       history, and woodConfigs.
 */
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Persistable subset of an analyzer session — everything the user has
 * configured plus the designs themselves, but NOT the analysis results
 * (which are large, contain typed-array masks that don't survive JSON
 * round-trips, and are regeneratable from the saved state).
 */
export interface SerializedDesign {
  id: string;
  vector: {
    layers: Layer[];
    naturalWidth: number;
    naturalHeight: number;
    viewBox: string;
    fileName: string;
    fileType: 'svg' | 'dxf';
    detectedColors: string[];
  };
  history: { layers: Layer[]; label: string }[];
  historyIndex: number;
  woodConfigs: WoodConfig[];
  /** Per-design placement on the board (in inches). Optional in the
   *  schema for forward-compat with files written before this field
   *  existed (still v2 if `designs` is present); the loader falls back
   *  to a sensible default. */
  placement?: Placement;
  /** Which face the design lives on. Optional — older v2 files written
   *  before two-sided support default to `'top'` on load. */
  side?: 'top' | 'bottom';
}

export interface SessionFile {
  version: number;
  exportedAt: string;
  designs: SerializedDesign[];
  activeDesignId: string | null;
  settings: DFMSettings;
  backgroundSpecies: WoodSpeciesKey;
  ui: {
    currentStep: 1 | 2 | 3 | 4;
    maxReachedStep: 1 | 2 | 3 | 4;
    vbitTouched: boolean;
    hasEverAnalyzed: boolean;
  };
}

/** v1 (legacy) shape — used only by the loader's migration branch. */
interface SessionFileV1 {
  version: 1;
  vector: SerializedDesign['vector'];
  history: SerializedDesign['history'];
  historyIndex: number;
  settings: DFMSettings;
  woodConfigs: WoodConfig[];
  backgroundSpecies: WoodSpeciesKey;
  ui: SessionFile['ui'];
}

export interface ExpertDesignLike {
  id: string;
  originalVector: VectorData;
  history: LayerSnapshot[];
  historyIndex: number;
  woodConfigs: WoodConfig[];
  placement: Placement;
  /** Which board face this design lives on. Optional because the
   *  expert flow doesn't expose sides today; the guided flow's
   *  per-side `Design.side` matches this when sessions ever flow
   *  between the two flows. Loader defaults to undefined → caller
   *  falls back to 'top'. */
  side?: 'top' | 'bottom';
}

interface SaveSessionInput {
  designs: ExpertDesignLike[];
  activeDesignId: string | null;
  settings: DFMSettings;
  backgroundSpecies: WoodSpeciesKey;
  currentStep: 1 | 2 | 3 | 4;
  maxReachedStep: 1 | 2 | 3 | 4;
  vbitTouched: boolean;
  hasEverAnalyzed: boolean;
}

/** Serialize a session and trigger a browser download. */
export function saveSessionToFile(input: SaveSessionInput): void {
  const file: SessionFile = {
    version: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    designs: input.designs.map(d => ({
      id: d.id,
      vector: {
        layers: d.originalVector.layers,
        naturalWidth: d.originalVector.naturalWidth,
        naturalHeight: d.originalVector.naturalHeight,
        viewBox: d.originalVector.viewBox,
        fileName: d.originalVector.fileName,
        fileType: d.originalVector.fileType,
        detectedColors: d.originalVector.detectedColors,
      },
      // Strip cached analysis results — they don't survive JSON round-trip.
      history: d.history.map(s => ({ layers: s.layers, label: s.label })),
      historyIndex: d.historyIndex,
      woodConfigs: d.woodConfigs,
      placement: d.placement,
      // `side` is only set by callers that track per-design faces
      // (the guided flow's `Design.side`). Omitted means top.
      ...(d.side !== undefined ? { side: d.side } : {}),
    })),
    activeDesignId: input.activeDesignId,
    settings: input.settings,
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
  const firstName = input.designs[0]?.originalVector.fileName ?? 'design';
  a.download = sessionFileName(firstName);
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
  designs: ExpertDesignLike[];
  activeDesignId: string | null;
  settings: DFMSettings;
  backgroundSpecies: WoodSpeciesKey;
  currentStep: 1 | 2 | 3 | 4;
  maxReachedStep: 1 | 2 | 3 | 4;
  vbitTouched: boolean;
  hasEverAnalyzed: boolean;
}

// Validation helpers (unchanged shape from v1).
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

function validateWoodConfigs(value: unknown, path: string): WoodConfig[] {
  if (!Array.isArray(value)) throw new Error(`Session field "${path}" must be an array.`);
  return value.map((wc, i) => {
    if (!wc || typeof wc !== 'object') throw new Error(`Session field "${path}[${i}]" must be an object.`);
    const w = wc as Partial<WoodConfig>;
    return {
      colorHex: expectString(w.colorHex, `${path}[${i}].colorHex`),
      label:    expectString(w.label,    `${path}[${i}].label`),
      species:  expectString(w.species,  `${path}[${i}].species`) as WoodSpeciesKey,
    };
  });
}

function validateVector(value: unknown, path: string): SerializedDesign['vector'] {
  if (!value || typeof value !== 'object') throw new Error(`Session field "${path}" must be an object.`);
  const v = value as Partial<SerializedDesign['vector']>;
  if (v.fileType !== 'svg' && v.fileType !== 'dxf') {
    throw new Error(`Session field "${path}.fileType" must be "svg" or "dxf".`);
  }
  if (!Array.isArray(v.detectedColors)) {
    throw new Error(`Session field "${path}.detectedColors" must be an array.`);
  }
  return {
    layers:         expectLayerArray(v.layers, `${path}.layers`),
    naturalWidth:   expectFiniteNumber(v.naturalWidth,  `${path}.naturalWidth`),
    naturalHeight:  expectFiniteNumber(v.naturalHeight, `${path}.naturalHeight`),
    viewBox:        expectString(v.viewBox,  `${path}.viewBox`),
    fileName:       expectString(v.fileName, `${path}.fileName`),
    fileType:       v.fileType,
    detectedColors: v.detectedColors.map((c, i) => expectString(c, `${path}.detectedColors[${i}]`)),
  };
}

function validateHistory(value: unknown, path: string): { layers: Layer[]; label: string }[] {
  if (!Array.isArray(value)) throw new Error(`Session field "${path}" must be an array.`);
  return value.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`Session field "${path}[${i}]" must be an object.`);
    return {
      layers: expectLayerArray((s as { layers: unknown }).layers, `${path}[${i}].layers`),
      label:  expectString((s as { label: unknown }).label,        `${path}[${i}].label`),
    };
  });
}

/** Convert a SerializedDesign back into the in-memory `ExpertDesignLike`. */
function deserializeDesign(d: SerializedDesign): ExpertDesignLike {
  const originalVector: VectorData = {
    layers:         d.vector.layers,
    naturalWidth:   d.vector.naturalWidth,
    naturalHeight:  d.vector.naturalHeight,
    viewBox:        d.vector.viewBox,
    fileName:       d.vector.fileName,
    fileType:       d.vector.fileType,
    detectedColors: d.vector.detectedColors,
    svgString: combineLayers(
      d.vector.layers, d.vector.viewBox, d.vector.naturalWidth, d.vector.naturalHeight,
    ),
  };
  // Default placement when missing (legacy v1, or v2 file written
  // before per-design placement was added): sized to the design's
  // natural aspect at 5" wide, anchored at origin. The expert app
  // re-clamps on load so this is just a sensible fallback.
  const placement: Placement = d.placement ?? {
    offsetXInches: 0,
    offsetYInches: 0,
    designWidthInches: 5,
  };
  return {
    id: d.id,
    originalVector,
    history: d.history,
    historyIndex: d.historyIndex,
    woodConfigs: d.woodConfigs,
    placement,
    side: d.side,
  };
}

/**
 * Read a session file and validate its schema. Throws on parse error,
 * missing required fields, or wrong field types. Handles v1 (legacy
 * single-design) and v2 (multi-design) sessions transparently.
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
  const sf = raw as { version?: unknown };
  if (sf.version !== 1 && sf.version !== 2) {
    throw new Error(
      `Session file version ${sf.version ?? '?'} is not supported (this app reads v1 or v2).`,
    );
  }

  // Common fields shared by both versions.
  const top = raw as Partial<SessionFile> & Partial<SessionFileV1>;
  const settings          = validateSettings(top.settings);
  const backgroundSpecies = expectString(top.backgroundSpecies, 'backgroundSpecies') as WoodSpeciesKey;
  if (!top.ui || typeof top.ui !== 'object') {
    throw new Error('Session field "ui" must be an object.');
  }
  const ui = top.ui as Partial<SessionFile['ui']>;
  const currentStep    = expectStepNumber(ui.currentStep,    'ui.currentStep');
  const maxReachedStep = expectStepNumber(ui.maxReachedStep, 'ui.maxReachedStep');
  const vbitTouched    = expectBoolean(ui.vbitTouched,       'ui.vbitTouched');
  const hasEverAnalyzed = expectBoolean(ui.hasEverAnalyzed,  'ui.hasEverAnalyzed');

  let designs: ExpertDesignLike[];
  let activeDesignId: string | null;

  if (sf.version === 1) {
    // Migrate v1 → in-memory single-design list.
    const vec = validateVector(top.vector, 'vector');
    const history = validateHistory(top.history, 'history');
    const historyIndex = expectFiniteNumber(top.historyIndex, 'historyIndex');
    if (historyIndex < 0 || historyIndex >= history.length) {
      throw new Error(`Session field "historyIndex" (${historyIndex}) is out of range for history of length ${history.length}.`);
    }
    const woodConfigs = validateWoodConfigs(top.woodConfigs, 'woodConfigs');
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `legacy-${Date.now()}`;
    designs = [deserializeDesign({
      id,
      vector: vec,
      history,
      historyIndex,
      woodConfigs,
    })];
    activeDesignId = id;
  } else {
    // v2: designs array.
    if (!Array.isArray(top.designs)) {
      throw new Error('Session field "designs" must be an array.');
    }
    designs = top.designs.map((d, i) => {
      if (!d || typeof d !== 'object') {
        throw new Error(`Session field "designs[${i}]" must be an object.`);
      }
      const dd = d as Partial<SerializedDesign>;
      const vec = validateVector(dd.vector, `designs[${i}].vector`);
      const history = validateHistory(dd.history, `designs[${i}].history`);
      const historyIndex = expectFiniteNumber(dd.historyIndex, `designs[${i}].historyIndex`);
      if (historyIndex < 0 || historyIndex >= history.length) {
        throw new Error(`Session field "designs[${i}].historyIndex" (${historyIndex}) is out of range for history of length ${history.length}.`);
      }
      const woodConfigs = validateWoodConfigs(dd.woodConfigs, `designs[${i}].woodConfigs`);
      // `side` is optional. When present it must be 'top' or 'bottom';
      // any other value is a malformed file and rejected. Missing → undefined,
      // which the caller treats as 'top'.
      let side: 'top' | 'bottom' | undefined;
      if (dd.side !== undefined) {
        if (dd.side !== 'top' && dd.side !== 'bottom') {
          throw new Error(`Session field "designs[${i}].side" must be "top" or "bottom".`);
        }
        side = dd.side;
      }
      // `placement` is optional (legacy / pre-placement files use the
      // default in `deserializeDesign`). When present, validate
      // `rotationDegrees` if provided — it must be one of 0/90/180/270.
      let placement: Placement | undefined;
      if (dd.placement !== undefined) {
        if (!dd.placement || typeof dd.placement !== 'object') {
          throw new Error(`Session field "designs[${i}].placement" must be an object.`);
        }
        const pp = dd.placement as Partial<Placement>;
        let rotationDegrees: RotationDegrees | undefined;
        if (pp.rotationDegrees !== undefined) {
          if (!isValidRotation(pp.rotationDegrees)) {
            throw new Error(`Session field "designs[${i}].placement.rotationDegrees" must be 0, 90, 180, or 270.`);
          }
          rotationDegrees = pp.rotationDegrees;
        }
        placement = {
          offsetXInches:     expectFiniteNumber(pp.offsetXInches,     `designs[${i}].placement.offsetXInches`),
          offsetYInches:     expectFiniteNumber(pp.offsetYInches,     `designs[${i}].placement.offsetYInches`),
          designWidthInches: expectFiniteNumber(pp.designWidthInches, `designs[${i}].placement.designWidthInches`),
          ...(rotationDegrees !== undefined ? { rotationDegrees } : {}),
        };
      }
      return deserializeDesign({
        id: expectString(dd.id, `designs[${i}].id`),
        vector: vec,
        history,
        historyIndex,
        woodConfigs,
        ...(placement ? { placement } : {}),
        ...(side ? { side } : {}),
      });
    });
    if (top.activeDesignId !== null && typeof top.activeDesignId !== 'string') {
      throw new Error('Session field "activeDesignId" must be a string or null.');
    }
    activeDesignId = (top.activeDesignId as string | null | undefined) ?? designs[0]?.id ?? null;
  }

  return {
    designs,
    activeDesignId,
    settings,
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
