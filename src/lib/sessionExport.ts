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
 * Read a session file and validate its schema. Throws on parse error,
 * version mismatch, or missing required fields.
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

  // Validate enough fields to fail fast on obviously-wrong files.
  if (!raw || typeof raw !== 'object') {
    throw new Error('Session file is empty or malformed.');
  }
  const sf = raw as Partial<SessionFile>;
  if (sf.version !== SCHEMA_VERSION) {
    throw new Error(
      `Session file version ${sf.version ?? '?'} is not supported (this app expects v${SCHEMA_VERSION}).`,
    );
  }
  if (!sf.vector || !Array.isArray(sf.vector.layers)) {
    throw new Error('Session file is missing required "vector" data.');
  }
  if (!Array.isArray(sf.history) || typeof sf.historyIndex !== 'number') {
    throw new Error('Session file is missing required "history" data.');
  }
  if (!sf.settings || !sf.woodConfigs || !sf.backgroundSpecies || !sf.ui) {
    throw new Error('Session file is missing required state fields.');
  }

  const v = sf.vector;
  const originalVector: VectorData = {
    layers: v.layers,
    naturalWidth: v.naturalWidth,
    naturalHeight: v.naturalHeight,
    viewBox: v.viewBox,
    fileName: v.fileName,
    fileType: v.fileType,
    detectedColors: v.detectedColors,
    svgString: combineLayers(v.layers, v.viewBox, v.naturalWidth, v.naturalHeight),
  };

  const history: LayerSnapshot[] = sf.history.map(s => ({
    layers: s.layers,
    label: s.label,
    // result intentionally omitted — needs re-running.
  }));

  return {
    originalVector,
    history,
    historyIndex: sf.historyIndex,
    settings: sf.settings,
    woodConfigs: sf.woodConfigs,
    backgroundSpecies: sf.backgroundSpecies,
    currentStep: sf.ui.currentStep,
    maxReachedStep: sf.ui.maxReachedStep,
    vbitTouched: sf.ui.vbitTouched,
    hasEverAnalyzed: sf.ui.hasEverAnalyzed,
  };
}

/** Test whether a file looks like a session JSON by extension. */
export function looksLikeSessionFile(file: File): boolean {
  return /\.json$/i.test(file.name);
}
