import type { DFMSettings, GrainDirection, VectorData, AnalysisResult, SingleAnalysis, WoodAnalysis, AlignmentIssue } from '@/types';
import { distanceTransform } from './distanceTransform';
import { layerToStandaloneSvg } from './svgLayers';
import { detectAlignmentRisk } from './alignmentRisk';
import { CLEARANCE_BIT_MRR, CLEARANCE_BIT_OPTIONS, getVbitRates, VBIT_PRESET_ANGLES, VBIT_RATES } from './machiningRates';
import { buildMachiningTimeMatrix, machiningTimeForMask } from './machiningTime';

const DEFAULT_CANVAS_WIDTH = 1200;
const THIN_WALL_THRESHOLD_INCHES = 0.05;
const MIN_THIN_WALL_AREA_SQ_IN = 0.25;
const MIN_VBIT_ANGLE_SIDE_GRAIN = 60;
const ALIGNMENT_THRESHOLD_INCHES = 0.01;
// A piece passes when less than this fraction of its carved area is flagged.
// Using a percentage threshold (not exact-zero) avoids false failures from
// a handful of anti-aliased or border pixels that round to "0.00%" in the UI.
const PASS_THRESHOLD_PERCENT = 0.1;

// ---------------------------------------------------------------------------
// Lightweight problem-area % for a given V-bit angle, reusing an existing
// dist1 (distance from each carved pixel to the nearest non-carved pixel).
// Used by the bit-comparison matrix to determine whether a V-bit angle is
// feasible (≤ FEASIBILITY_PROBLEM_PCT problem area on every layer's pocket
// and plug). Does the same depth/threshold reasoning as analyzeMask but
// skips thin-wall analysis and overlay generation.
// ---------------------------------------------------------------------------
function problemPercentForAngle(
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
  thresholdPx: number,
  canvasW: number,
  canvasH: number,
): number {
  const n = canvasW * canvasH;
  const isFullDepth = new Uint8Array(n);
  let carvedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!carvedMask[i]) continue;
    carvedCount++;
    if (dist1[i] >= fullDepthRadiusPx) isFullDepth[i] = 1;
  }
  if (carvedCount === 0) return 0;

  const seeds = new Uint8Array(n);
  for (let i = 0; i < n; i++) seeds[i] = isFullDepth[i] ? 0 : 1;
  const dist2 = distanceTransform(seeds, canvasW, canvasH);

  let problemCount = 0;
  for (let i = 0; i < n; i++) {
    if (carvedMask[i] && !isFullDepth[i] && dist2[i] > thresholdPx) problemCount++;
  }
  return (problemCount / carvedCount) * 100;
}

/** Problem-area cutoff above which a V-bit angle is considered infeasible for the design. */
const FEASIBILITY_PROBLEM_PCT = 10;

// ---------------------------------------------------------------------------
// Inner analysis — runs on any binary "carved mask" (1 = area being carved).
// For the pocket: carved = design (dark pixels).
// For the plug:   carved = background (light pixels, the waste around the plug).
// ---------------------------------------------------------------------------
function analyzeMask(
  carvedMask: Uint8Array,
  canvasW: number,
  canvasH: number,
  pixelsPerInch: number,
  fullDepthRadiusPx: number,
  thresholdPx: number,
  thinWallThresholdPx: number,
  grainDirection: GrainDirection,
  vbitAngleDegrees: number,
): {
  isProblem: Uint8Array;
  isThinWall: Uint8Array;
  dist1: Float32Array;
  fullDepthPercent: number;
  problemAreaPercent: number;
  hasAnyFullDepth: boolean;
  thinWallPixelCount: number;
  vbitAngleWarning: boolean;
  passed: boolean;
} {
  const n = canvasW * canvasH;

  // EDT 1: distance from each carved pixel to the nearest un-carved pixel
  const dist1 = distanceTransform(carvedMask, canvasW, canvasH);

  // Full-depth classification
  const isFullDepth = new Uint8Array(n);
  let carvedCount = 0, fullDepthCount = 0;
  for (let i = 0; i < n; i++) {
    if (!carvedMask[i]) continue;
    carvedCount++;
    if (dist1[i] >= fullDepthRadiusPx) { isFullDepth[i] = 1; fullDepthCount++; }
  }

  // EDT 2: distance from each pixel to the nearest full-depth pixel
  const seeds2 = new Uint8Array(n);
  for (let i = 0; i < n; i++) seeds2[i] = isFullDepth[i] ? 0 : 1;
  const dist2 = distanceTransform(seeds2, canvasW, canvasH);

  // Problem pixels: carved, not full-depth, far from any full-depth zone
  const isProblem = new Uint8Array(n);
  let problemCount = 0;
  for (let i = 0; i < n; i++) {
    if (carvedMask[i] && !isFullDepth[i] && dist2[i] > thresholdPx) {
      isProblem[i] = 1;
      problemCount++;
    }
  }

  // Thin wall check (side grain only).
  // Looks for thin runs of !carvedMask (the un-carved material) bounded on both sides
  // by carved pixels in the direction perpendicular to the grain.
  // - pocket: un-carved = background → detects thin un-carved walls between pocket features
  // - plug:   un-carved = design   → detects thin raised plug features
  const isThinWall = new Uint8Array(n);
  let thinWallPixelCount = 0;

  if (grainDirection !== 'end') {
    if (grainDirection === 'vertical') {
      for (let x = 0; x < canvasW; x++) {
        let y = 0;
        while (y < canvasH) {
          if (!carvedMask[y * canvasW + x]) {
            const runStart = y;
            while (y < canvasH && !carvedMask[y * canvasW + x]) y++;
            const bounded =
              runStart > 0 && !!carvedMask[(runStart - 1) * canvasW + x] &&
              y < canvasH   && !!carvedMask[y * canvasW + x];
            if (bounded && (y - runStart) < thinWallThresholdPx) {
              for (let yy = runStart; yy < y; yy++) {
                isThinWall[yy * canvasW + x] = 1;
                thinWallPixelCount++;
              }
            }
          } else {
            y++;
          }
        }
      }
    } else {
      for (let y = 0; y < canvasH; y++) {
        let x = 0;
        while (x < canvasW) {
          if (!carvedMask[y * canvasW + x]) {
            const runStart = x;
            while (x < canvasW && !carvedMask[y * canvasW + x]) x++;
            const bounded =
              runStart > 0 && !!carvedMask[y * canvasW + runStart - 1] &&
              x < canvasW   && !!carvedMask[y * canvasW + x];
            if (bounded && (x - runStart) < thinWallThresholdPx) {
              for (let xx = runStart; xx < x; xx++) {
                isThinWall[y * canvasW + xx] = 1;
                thinWallPixelCount++;
              }
            }
          } else {
            x++;
          }
        }
      }
    }

    // Filter connected components below the minimum area threshold
    if (thinWallPixelCount > 0) {
      const minPixels = MIN_THIN_WALL_AREA_SQ_IN * pixelsPerInch * pixelsPerInch;
      const visited = new Uint8Array(n);
      for (let start = 0; start < n; start++) {
        if (!isThinWall[start] || visited[start]) continue;
        const queue: number[] = [start];
        visited[start] = 1;
        let head = 0;
        while (head < queue.length) {
          const idx = queue[head++];
          const x = idx % canvasW;
          const y = (idx - x) / canvasW;
          const nb = [
            y > 0           ? idx - canvasW : -1,
            y < canvasH - 1 ? idx + canvasW : -1,
            x > 0           ? idx - 1       : -1,
            x < canvasW - 1 ? idx + 1       : -1,
          ];
          for (const n of nb) {
            if (n >= 0 && isThinWall[n] && !visited[n]) { visited[n] = 1; queue.push(n); }
          }
        }
        if (queue.length < minPixels) for (const idx of queue) isThinWall[idx] = 0;
      }
      thinWallPixelCount = 0;
      for (let i = 0; i < n; i++) if (isThinWall[i]) thinWallPixelCount++;
    }
  }

  return {
    isProblem,
    isThinWall,
    dist1,
    fullDepthPercent:   carvedCount > 0 ? (fullDepthCount / carvedCount) * 100 : 0,
    problemAreaPercent: carvedCount > 0 ? (problemCount  / carvedCount) * 100 : 0,
    hasAnyFullDepth: fullDepthCount > 0,
    thinWallPixelCount,
    vbitAngleWarning: grainDirection !== 'end' && vbitAngleDegrees < MIN_VBIT_ANGLE_SIDE_GRAIN,
    passed: (carvedCount > 0 ? (problemCount / carvedCount) * 100 : 0) < PASS_THRESHOLD_PERCENT,
  };
}

async function buildOverlay(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  isProblem: Uint8Array,
  isThinWall: Uint8Array,
  isAlignment?: Uint8Array,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, canvasW, canvasH);
  const d = img.data;
  for (let i = 0, n = canvasW * canvasH; i < n; i++) {
    if (isProblem[i]) {
      d[i*4]=220; d[i*4+1]=50;  d[i*4+2]=50;  d[i*4+3]=210;
    } else if (isThinWall[i]) {
      d[i*4]=220; d[i*4+1]=150; d[i*4+2]=30;  d[i*4+3]=210;
    } else if (isAlignment?.[i]) {
      d[i*4]=210; d[i*4+1]=50;  d[i*4+2]=210; d[i*4+3]=210;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasToDataUrl(oc);
}

async function buildDepthMap(
  base: OffscreenCanvas,
  canvasW: number,
  canvasH: number,
  carvedMask: Uint8Array,
  dist1: Float32Array,
  fullDepthRadiusPx: number,
): Promise<string> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.drawImage(base, 0, 0);
  const img = ctx.getImageData(0, 0, canvasW, canvasH);
  const d = img.data;
  for (let i = 0, n = canvasW * canvasH; i < n; i++) {
    if (!carvedMask[i]) continue;
    const ratio = Math.min(1, dist1[i] / fullDepthRadiusPx);
    // Red (shallow) → green (full depth)
    d[i*4]   = Math.round(220 - 180 * ratio);
    d[i*4+1] = Math.round(40  + 160 * ratio);
    d[i*4+2] = 30;
    d[i*4+3] = 220;
  }
  ctx.putImageData(img, 0, 0);
  return canvasToDataUrl(oc);
}

// ---------------------------------------------------------------------------
// Public entry point
// colorOrder controls which inlay is "earlier" for alignment detection.
// Defaults to vector.detectedColors order; pass woodConfigs order to reflect
// user reordering.
// ---------------------------------------------------------------------------
export async function runDfmAnalysis(
  vector: VectorData,
  settings: DFMSettings,
  colorOrder?: string[],
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
): Promise<AnalysisResult> {
  const { designWidthInches, vbitAngleDegrees, inlayDepthInches, grainDirection } = settings;

  const halfAngleRad = (vbitAngleDegrees / 2) * (Math.PI / 180);
  const vbitCutWidthInches = 2 * inlayDepthInches * Math.tan(halfAngleRad);
  const fullDepthRadiusInches = inlayDepthInches * Math.tan(halfAngleRad);
  const thresholdInches = 2 * vbitCutWidthInches;

  const aspect = vector.naturalHeight / vector.naturalWidth;
  const canvasW = canvasWidth;
  const canvasH = Math.max(1, Math.round(canvasWidth * aspect));
  const pixelsPerInch = canvasW / designWidthInches;
  const fullDepthRadiusPx = fullDepthRadiusInches * pixelsPerInch;
  const thresholdPx = thresholdInches * pixelsPerInch;
  const thinWallThresholdPx = THIN_WALL_THRESHOLD_INCHES * pixelsPerInch;
  const alignThresholdPx = ALIGNMENT_THRESHOLD_INCHES * pixelsPerInch;

  // Combined render — used only as a fallback visual backdrop if a layer's
  // per-layer canvas is missing. Per-layer canvases are now the source of
  // truth for both masks and the per-wood overlay/depth-map base image.
  const base = await renderSvgToCanvas(vector.svgString, canvasW, canvasH);
  const n = canvasW * canvasH;
  const orderedColors = colorOrder ?? vector.detectedColors;

  // Per-layer base canvases — each shows only that layer's geometry. Used as the
  // visual backdrop for each wood's overlay/depth-map so the WoodSection canvas
  // displays only that single inlay rather than the full mixed design.
  const perLayerBases = new Map<string, OffscreenCanvas>();
  for (const layer of vector.layers) {
    const layerSvg = layerToStandaloneSvg(layer, vector.viewBox, vector.naturalWidth, vector.naturalHeight);
    perLayerBases.set(layer.colorHex, await renderSvgToCanvas(layerSvg, canvasW, canvasH));
  }

  const args = [canvasW, canvasH, pixelsPerInch, fullDepthRadiusPx, thresholdPx, thinWallThresholdPx, grainDirection, vbitAngleDegrees] as const;

  const toSingle = async (
    mask: Uint8Array,
    maskData: ReturnType<typeof analyzeMask>,
    layerBase: OffscreenCanvas,
    alignPixels?: Uint8Array,
  ): Promise<SingleAnalysis> => ({
    fullDepthPercent:   maskData.fullDepthPercent,
    problemAreaPercent: maskData.problemAreaPercent,
    passed:             maskData.passed,
    hasAnyFullDepth:    maskData.hasAnyFullDepth,
    vbitAngleWarning:   maskData.vbitAngleWarning,
    thinWallPixelCount: maskData.thinWallPixelCount,
    overlayDataUrl:  await buildOverlay(layerBase, canvasW, canvasH, maskData.isProblem, maskData.isThinWall, alignPixels),
    depthMapDataUrl: await buildDepthMap(layerBase, canvasW, canvasH, mask, maskData.dist1, fullDepthRadiusPx),
  });

  // -----------------------------------------------------------------------
  // Phase 1: Build all pocket masks via per-layer rasterization.
  //
  // We deliberately do NOT use color-matching from the combined render here.
  // Color-matching gives the *visible* extent of each layer (what survives
  // SVG z-order), but for DFM and especially staged-alignment risk detection
  // we need each layer's *physical* extent — including any portion that the
  // extend-for-registration algorithm has placed under a later layer.
  //
  // Brightness threshold (< 220 luma) over the per-layer canvas captures the
  // colored region; antialiased edge pixels at adjacent boundaries can fall
  // into both layers' masks by ~1 px, which is harmless because the boundary
  // detector picks them up on both sides equally.
  // -----------------------------------------------------------------------
  const pocketMasks: Uint8Array[] = orderedColors.map(colorHex => {
    const layerCanvas = perLayerBases.get(colorHex);
    if (!layerCanvas) return new Uint8Array(n);
    const lctx = layerCanvas.getContext('2d')!;
    const layerData = lctx.getImageData(0, 0, canvasW, canvasH).data;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = layerData[i * 4], g = layerData[i * 4 + 1], b = layerData[i * 4 + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b < 220) mask[i] = 1;
    }
    return mask;
  });

  // -----------------------------------------------------------------------
  // Phase 2: Cross-pair alignment check.
  //
  // For each pair (i < j), flag layer-i boundary pixels that lie within
  // alignThresholdPx of any layer-j boundary pixel. This captures direct
  // adjacency, thin background gaps, and other close-boundary cases —
  // and correctly does NOT flag cases where one layer overlaps the other
  // by more than the threshold (boundaries are far apart in that case).
  //
  // Visual: the detected boundary strip is dilated (3× threshold radius)
  // within the inlay mask so it renders clearly. affectedPercent represents
  // the fraction of layer-i's perimeter at risk, using the un-dilated set.
  // -----------------------------------------------------------------------
  const alignVisualPx = Math.max(5, alignThresholdPx * 3);

  const alignPixelsPerInlay: Uint8Array[] = orderedColors.map(() => new Uint8Array(n));
  const alignIssues: AlignmentIssue[][] = orderedColors.map(() => []);

  for (let i = 0; i < orderedColors.length; i++) {
    for (let j = i + 1; j < orderedColors.length; j++) {
      const { riskMask, affectedCount, totalBoundaryCount } = detectAlignmentRisk(
        pocketMasks[i], pocketMasks[j],
        canvasW, canvasH, alignThresholdPx,
      );

      if (affectedCount > 0) {
        for (let k = 0; k < n; k++) if (riskMask[k]) alignPixelsPerInlay[i][k] = 1;
        alignIssues[i].push({
          otherColorHex: orderedColors[j],
          affectedPercent: totalBoundaryCount > 0 ? (affectedCount / totalBoundaryCount) * 100 : 0,
        });
      }
    }
  }

  // Dilate alignment pixels within the inlay mask for visual clarity.
  const alignVisualPerInlay: Uint8Array[] = alignPixelsPerInlay.map((raw, i) => {
    if (!raw.some(v => v)) return raw; // no issues → skip
    const seeds = new Uint8Array(n);
    for (let k = 0; k < n; k++) seeds[k] = raw[k] ? 0 : 1;
    const distToRaw = distanceTransform(seeds, canvasW, canvasH);
    const dilated = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (pocketMasks[i][k] && distToRaw[k] < alignVisualPx) dilated[k] = 1;
    }
    return dilated;
  });

  // -----------------------------------------------------------------------
  // Phase 3: Machining-time rates (constant across layers for one analysis).
  // V-bit rates may be missing if the user is on a custom angle without
  // having supplied MRR/feed — in that case time fields are NaN and the UI
  // displays "—" instead of a number.
  // -----------------------------------------------------------------------
  const clearanceMRR = CLEARANCE_BIT_MRR[settings.clearanceBitDiameterInches];
  const vbitRates = getVbitRates(
    vbitAngleDegrees,
    settings.vbitMRRInches3PerMin,
    settings.vbitFeedInchesPerMin,
  );
  const haveMachiningRates = vbitRates !== null;

  // -----------------------------------------------------------------------
  // Phase 4: Run DFM analysis and assemble WoodAnalysis entries.
  // -----------------------------------------------------------------------
  const woods: WoodAnalysis[] = [];
  const matrixLayers: { mask: Uint8Array; dist1: Float32Array }[] = [];
  // Pocket+plug masks and their dist1's, kept for the per-V-bit feasibility check.
  const layerSidesForFeasibility: { mask: Uint8Array; dist1: Float32Array }[] = [];
  let totalMachineTime = 0;
  let anyMachineTimeMissing = false;

  for (let idx = 0; idx < orderedColors.length; idx++) {
    const colorHex = orderedColors[idx];
    const pocketMask = pocketMasks[idx];

    const plugMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) plugMask[i] = pocketMask[i] ? 0 : 1;

    const pocketAnalysis = analyzeMask(pocketMask, ...args);
    const plugAnalysis   = analyzeMask(plugMask,   ...args);

    matrixLayers.push({ mask: pocketMask, dist1: pocketAnalysis.dist1 });
    layerSidesForFeasibility.push({ mask: pocketMask, dist1: pocketAnalysis.dist1 });
    layerSidesForFeasibility.push({ mask: plugMask,   dist1: plugAnalysis.dist1   });

    // Machining time uses the pocket mask + its EDT (already in pocketAnalysis.dist1).
    // Plug time is modeled identically (same shape, same depth) — see plan notes.
    let pocketMachineTimeMinutes = NaN, plugMachineTimeMinutes = NaN, layerMachineTimeMinutes = NaN;
    let clearanceAreaSqIn = 0, vbitAreaSqIn = 0, perimeterIn = 0;
    if (haveMachiningRates && vbitRates) {
      const t = machiningTimeForMask(
        pocketMask, pocketAnalysis.dist1,
        canvasW, canvasH, pixelsPerInch,
        inlayDepthInches,
        settings.clearanceBitDiameterInches,
        clearanceMRR,
        vbitRates.mrr,
        vbitRates.feed,
      );
      pocketMachineTimeMinutes = t.totalTimeMin;
      plugMachineTimeMinutes   = t.totalTimeMin; // identical model
      layerMachineTimeMinutes  = pocketMachineTimeMinutes + plugMachineTimeMinutes;
      clearanceAreaSqIn = t.clearanceAreaSqIn;
      vbitAreaSqIn      = t.vbitAreaSqIn;
      perimeterIn       = t.perimeterIn;
      totalMachineTime += layerMachineTimeMinutes;
    } else {
      anyMachineTimeMissing = true;
    }

    const layerBase = perLayerBases.get(colorHex) ?? base;
    woods.push({
      colorHex,
      pocket: await toSingle(pocketMask, pocketAnalysis, layerBase, alignVisualPerInlay[idx]),
      plug:   await toSingle(plugMask,   plugAnalysis,   layerBase),
      alignmentIssues: alignIssues[idx],
      clearanceAreaSqIn,
      vbitAreaSqIn,
      perimeterIn,
      pocketMachineTimeMinutes,
      plugMachineTimeMinutes,
      layerMachineTimeMinutes,
    });
  }

  // -----------------------------------------------------------------------
  // Phase 5: Per-angle feasibility check, then comparison matrix.
  //
  // For every preset V-bit angle, compute the maximum problem-area % across
  // all (layer × side) pairs reusing each side's dist1 EDT (so the only
  // extra cost is one EDT2 + thresholding pass per angle per side). A V-bit
  // angle is "feasible" only when every pocket and plug stays under
  // FEASIBILITY_PROBLEM_PCT — otherwise the whole column in the matrix is
  // marked N/A.
  // -----------------------------------------------------------------------
  const matrixVbits = VBIT_PRESET_ANGLES.map(angleDeg => {
    const half = (angleDeg / 2) * (Math.PI / 180);
    const fdrInches = inlayDepthInches * Math.tan(half);
    const cutWidthInches = 2 * fdrInches;
    const angleFdrPx = fdrInches * pixelsPerInch;
    const angleThresholdPx = (2 * cutWidthInches) * pixelsPerInch;

    let maxProblem = 0;
    for (const side of layerSidesForFeasibility) {
      const p = problemPercentForAngle(
        side.mask, side.dist1, angleFdrPx, angleThresholdPx, canvasW, canvasH,
      );
      if (p > maxProblem) maxProblem = p;
      if (maxProblem > FEASIBILITY_PROBLEM_PCT) break;
    }
    return {
      angleDegrees: angleDeg,
      ...VBIT_RATES[angleDeg],
      feasible: maxProblem <= FEASIBILITY_PROBLEM_PCT,
    };
  });

  const machiningTimeTable = buildMachiningTimeMatrix({
    layers: matrixLayers,
    canvasW, canvasH, pixelsPerInch,
    inlayDepthInches,
    clearanceBits: CLEARANCE_BIT_OPTIONS.map(d => ({ diameterInches: d, mrr: CLEARANCE_BIT_MRR[d] })),
    vbits: matrixVbits,
  });

  return {
    woods,
    vbitCutWidthInches,
    fullDepthRadiusInches,
    thresholdInches,
    thinWallThresholdInches: THIN_WALL_THRESHOLD_INCHES,
    alignmentThresholdInches: ALIGNMENT_THRESHOLD_INCHES,
    pixelsPerInch,
    totalMachineTimeMinutes: anyMachineTimeMissing || !haveMachiningRates ? NaN : totalMachineTime,
    clearanceBitDiameterInches: settings.clearanceBitDiameterInches,
    clearanceMRR,
    vbitMRR:  vbitRates?.mrr  ?? NaN,
    vbitFeed: vbitRates?.feed ?? NaN,
    machiningTimeTable,
  };
}

async function renderSvgToCanvas(
  svgString: string,
  canvasW: number,
  canvasH: number,
): Promise<OffscreenCanvas> {
  const oc = new OffscreenCanvas(canvasW, canvasH);
  const ctx = oc.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasW, canvasH);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvasW, canvasH); resolve(); };
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return oc;
}

async function canvasToDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
