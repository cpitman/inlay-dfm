/**
 * Polygon-native machining-time calculation. Replaces the bitmap-EDT
 * + morphological opening pipeline in `machiningTimeForMask` /
 * `buildMachiningTimeMatrix`.
 *
 * The user's algorithm: each bit's "covered area" is its inward-
 * offset polygon's area plus a perimeter × R band along that
 * polygon's boundary (= Steiner's formula for the Minkowski sum
 * of the inward-offset region with a radius-R disc, minus the
 * π R² corner-cap term). Per-bit assigned area = its covered area
 * minus the next-larger bit's covered area (= the area only this
 * bit can clear that the larger one couldn't). The smallest
 * clearance bit's residual is the v-bit's incremental area.
 *
 * Time formulas (unchanged from the bitmap version):
 *   clearanceTime[bit] = incrementalArea × depth / MRR[bit]
 *   vbitAreaTime       = vbitIncrementalArea × depth / vbitMRR
 *   vbitPerimeterTime  = perimeterIn / vbitFeed
 *   total              = sum of all of the above
 */

import { multiPolygonOffset } from './clipperOps';
import {
  multiPolygonArea,
  multiPolygonIsEmpty,
  multiPolygonPerimeter,
  type MultiPolygon,
} from './polygon';
import { enumerateClearanceStrategies } from './machiningTime';

export interface PolygonMachiningTimeResult {
  totalTimeMin: number;
  /** Combined area cleared by all clearance bits (incremental sum), in sq in. */
  clearanceAreaSqIn: number;
  /** V-bit's incremental area (= what only the v-bit covers), in sq in. */
  vbitAreaSqIn: number;
}

/**
 * Compute the user-spec covered area for a single bit at the given
 * radius, in square design units:
 *
 *   coveredArea = area(inwardOffset(carved, R)) + perimeter(inwardOffset(carved, R)) × R
 *
 * The first term is the bit-center traversal region; the second is
 * the bit-body band along that region's boundary. Together they
 * approximate the morphological opening (= the bit's actual cleared
 * region) to within the π R² corner-cap term that Steiner's formula
 * for the inward-offset's Minkowski-dilation by a disc would add.
 *
 * Returns 0 when the inward offset collapses to nothing (= the bit
 * doesn't fit anywhere inside `carvedMP`).
 */
function bitCoveredAreaSqUnits(carvedMP: MultiPolygon, radiusUnits: number): number {
  if (radiusUnits <= 0) return multiPolygonArea(carvedMP);
  const inward = multiPolygonOffset(carvedMP, -radiusUnits, { joinType: 'round' });
  if (multiPolygonIsEmpty(inward)) return 0;
  return multiPolygonArea(inward) + multiPolygonPerimeter(inward) * radiusUnits;
}

/**
 * Per-side machining time. `clearanceBitDiametersIn` MUST be
 * pre-sorted in descending order (largest first). The v-bit is
 * always smallest in the assignment, picking up the residual after
 * the smallest clearance bit's reach.
 */
export function polygonMachiningTime(params: {
  carvedMP: MultiPolygon;
  perimeterUnits: number;
  designUnitsPerInch: number;
  clearanceBitDiametersIn: readonly number[]; // descending
  clearanceMrrByDiameter: ReadonlyMap<number, number>;
  vbitFullDepthRadiusUnits: number;
  vbitMrr: number;
  vbitFeedInchesPerMin: number;
  effectiveDepthIn: number;
}): PolygonMachiningTimeResult {
  const {
    carvedMP, perimeterUnits, designUnitsPerInch, clearanceBitDiametersIn,
    clearanceMrrByDiameter, vbitFullDepthRadiusUnits, vbitMrr,
    vbitFeedInchesPerMin, effectiveDepthIn,
  } = params;

  if (multiPolygonIsEmpty(carvedMP)) {
    return { totalTimeMin: 0, clearanceAreaSqIn: 0, vbitAreaSqIn: 0 };
  }

  const sqUnitsToSqIn = 1 / (designUnitsPerInch * designUnitsPerInch);
  const perimeterIn = perimeterUnits / designUnitsPerInch;

  let prevCoveredAreaUnits = 0;
  let clearanceTimeMin = 0;
  let clearanceAreaSqIn = 0;

  for (const diam of clearanceBitDiametersIn) {
    const radiusUnits = (diam / 2) * designUnitsPerInch;
    const coveredAreaUnits = bitCoveredAreaSqUnits(carvedMP, radiusUnits);
    const incrementalUnits = Math.max(0, coveredAreaUnits - prevCoveredAreaUnits);
    const incrementalSqIn = incrementalUnits * sqUnitsToSqIn;
    const mrr = clearanceMrrByDiameter.get(diam) ?? 0;
    if (mrr > 0) clearanceTimeMin += (incrementalSqIn * effectiveDepthIn) / mrr;
    clearanceAreaSqIn += incrementalSqIn;
    prevCoveredAreaUnits = coveredAreaUnits;
  }

  // V-bit incremental area. Same covered-area formula with the v-bit's
  // full-depth radius. If smaller than the smallest clearance bit's
  // radius, the v-bit covers everything not yet covered.
  const vbitCoveredUnits = bitCoveredAreaSqUnits(carvedMP, vbitFullDepthRadiusUnits);
  const vbitIncrementalUnits = Math.max(0, vbitCoveredUnits - prevCoveredAreaUnits);
  const vbitAreaSqIn = vbitIncrementalUnits * sqUnitsToSqIn;

  const vbitAreaTimeMin = vbitMrr > 0 ? (vbitAreaSqIn * effectiveDepthIn) / vbitMrr : 0;
  const vbitPerimeterTimeMin = vbitFeedInchesPerMin > 0 ? perimeterIn / vbitFeedInchesPerMin : 0;

  return {
    totalTimeMin: clearanceTimeMin + vbitAreaTimeMin + vbitPerimeterTimeMin,
    clearanceAreaSqIn,
    vbitAreaSqIn,
  };
}

// ---------------------------------------------------------------------------
// Multi-strategy × v-bit matrix
// ---------------------------------------------------------------------------

/**
 * Drop-in polygon replacement for `buildMachiningTimeMatrix`. Same
 * `MachiningTimeMatrix` output shape (strategies × v-bits, with
 * per-layer disaggregation), so `pickPerLayerBitPlan`,
 * `jointToolChangeOverhead`, and the pricing layer don't change.
 *
 * Per-layer per-side pre-computation: the inward-offset polygon for
 * each available clearance bit is computed ONCE (independent of
 * v-bit angle), and its covered area is cached. Per-cell, the
 * v-bit's covered area is computed fresh because its radius depends
 * on `angle/2`.
 */
export function buildMachiningTimeMatrixPolygon(params: {
  layers: {
    pocketMP: MultiPolygon;
    plugCarvedMP: MultiPolygon;
    pocketPerimeterUnits: number;
    plugPerimeterUnits: number;
  }[];
  designUnitsPerInch: number;
  inlayDepthInches: number;
  plugFit?: { glueGapInches: number; surfaceGapInches: number };
  clearanceBits: { diameterInches: number; mrr: number }[];
  vbits: import('@/types').MachiningTimeMatrix['vbits'];
  inlayDepthForVbit: number;
}): import('@/types').MachiningTimeMatrix {
  const { layers, designUnitsPerInch, inlayDepthInches, plugFit, clearanceBits, vbits } = params;
  const plugDepthInches = plugFit
    ? Math.max(0, inlayDepthInches - plugFit.glueGapInches + plugFit.surfaceGapInches)
    : inlayDepthInches;
  const mrrByDiameter = new Map(clearanceBits.map(b => [b.diameterInches, b.mrr]));
  const sqUnitsToSqIn = 1 / (designUnitsPerInch * designUnitsPerInch);

  const strategies = enumerateClearanceStrategies(clearanceBits.map(b => b.diameterInches));

  // Per-layer per-side: pre-compute covered-area-in-sq-units for each
  // available clearance bit, plus the side's total area in sq units.
  type SideAreas = {
    totalAreaUnits: number;
    coveredByBit: Map<number, number>; // diameter → covered area in sq units
  };
  const layerSides: { pocket: SideAreas; plug: SideAreas }[] = layers.map(layer => {
    const compute = (mp: MultiPolygon): SideAreas => {
      const totalAreaUnits = multiPolygonArea(mp);
      const coveredByBit = new Map<number, number>();
      for (const b of clearanceBits) {
        const radiusUnits = (b.diameterInches / 2) * designUnitsPerInch;
        coveredByBit.set(b.diameterInches, bitCoveredAreaSqUnits(mp, radiusUnits));
      }
      return { totalAreaUnits, coveredByBit };
    };
    return {
      pocket: compute(layer.pocketMP),
      plug: compute(layer.plugCarvedMP),
    };
  });

  // Per-side time computation, parameterized on the v-bit's effective
  // covered area (caller provides — v-bit covered area depends on
  // angle, so it's computed once per (layer, vbit) pair below).
  const sideTime = (
    side: SideAreas,
    perimeterIn: number,
    depthInches: number,
    strategy: import('@/types').ClearanceStrategy,
    v: import('@/types').MachiningTimeMatrix['vbits'][number],
    vbitCoveredUnits: number,
  ): number => {
    let prevCoveredUnits = 0;
    let clearanceTime = 0;
    for (const d of strategy.diameters) {
      const coveredUnits = side.coveredByBit.get(d) ?? 0;
      const incrementalUnits = Math.max(0, coveredUnits - prevCoveredUnits);
      const incrementalSqIn = incrementalUnits * sqUnitsToSqIn;
      const mrr = mrrByDiameter.get(d) ?? 0;
      if (mrr > 0) clearanceTime += (incrementalSqIn * depthInches) / mrr;
      prevCoveredUnits = coveredUnits;
    }
    const vbitIncrementalUnits = Math.max(0, vbitCoveredUnits - prevCoveredUnits);
    const vbitAreaSqIn = vbitIncrementalUnits * sqUnitsToSqIn;
    const tVbitArea = v.mrr  > 0 ? (vbitAreaSqIn * depthInches) / v.mrr : 0;
    const tPerim    = v.feed > 0 ? perimeterIn / v.feed                  : 0;
    return clearanceTime + tVbitArea + tPerim;
  };

  // For each (layer, vbit), pre-compute the v-bit covered area for
  // pocket and plug sides. Reused across all strategies for that
  // (layer, vbit) cell.
  const vbitCoveredByLayer: { pocket: number; plug: number }[][] = layers.map((layer, li) => {
    return vbits.map(v => {
      const halfAngleRad = (v.angleDegrees / 2) * (Math.PI / 180);
      const radiusInches = params.inlayDepthForVbit * Math.tan(halfAngleRad);
      const radiusUnits = radiusInches * designUnitsPerInch;
      void li; // unused index; explicit acknowledgement
      return {
        pocket: bitCoveredAreaSqUnits(layer.pocketMP,    radiusUnits),
        plug:   bitCoveredAreaSqUnits(layer.plugCarvedMP, radiusUnits),
      };
    });
  });

  const layerCuttingTimes: number[][][] = layers.map(() =>
    strategies.map(() => vbits.map(() => 0)),
  );
  const cuttingTimes: number[][] = strategies.map((strategy, si) =>
    vbits.map((v, vi) => {
      let total = 0;
      for (let li = 0; li < layers.length; li++) {
        const sides = layerSides[li];
        const pocketPerimeterIn = layers[li].pocketPerimeterUnits / designUnitsPerInch;
        const plugPerimeterIn   = layers[li].plugPerimeterUnits   / designUnitsPerInch;
        const vbitCovered = vbitCoveredByLayer[li][vi];
        const layerTotal = sideTime(sides.pocket, pocketPerimeterIn, inlayDepthInches, strategy, v, vbitCovered.pocket)
                         + sideTime(sides.plug,   plugPerimeterIn,   plugDepthInches,  strategy, v, vbitCovered.plug);
        layerCuttingTimes[li][si][vi] = layerTotal;
        total += layerTotal;
      }
      return total;
    }),
  );

  return { strategies, vbits, cuttingTimes, layerCuttingTimes };
}
