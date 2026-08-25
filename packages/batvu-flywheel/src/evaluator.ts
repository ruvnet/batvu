// SPDX-License-Identifier: MIT
//
// The evaluator: the ONLY place sonar meaning enters the promotion loop.
//
// `@metaharness/flywheel` projects every domain onto four abstract axes and
// refuses to know anything else. Picking that projection well is most of the
// work, because the wheel will optimise exactly what these four numbers say and
// nothing else — a lazy mapping does not produce a mediocre sonar, it produces a
// sonar that is excellent at the wrong thing.
//
// | axis         | for BatVu                                    | why THIS and not the obvious choice |
// |--------------|----------------------------------------------|-------------------------------------|
// | `primary`    | half free-space IoU, half dilated occupied recall | see below — plain occupied IoU is gameable |
// | `noopRate`   | fraction of the mapped volume the scan left UNCOMMITTED | see below — got this wrong twice |
// | `costPerWin` | milliseconds of compute per IoU point         | keeps the wheel from buying quality with a phone that gets hot |
// | `regressed`  | emission guard denies, or the map carves through a wall | two hard stops, neither negotiable |
//
// ## `primary`: why not simply "IoU of the occupied voxels"
//
// Because it rewards painting. Measured directly: on an empty rectangular room,
// the deliberately BAD root policy — a 120-degree beam assumption and an
// occupied threshold below its own per-ping hit weight, so one ping declares a
// whole arc solid — scored a HIGHER occupied IoU (0.100) than the tuned default
// (0.067). It was not mapping better. In a bare box almost everything at
// wall-range really is wall, so a policy that smears occupancy across the whole
// arc lands most of it on a wall by luck, and IoU cannot tell luck from skill.
//
// Two halves fix it, and each covers the other's blind spot:
//
// * **Free-space IoU** is the anti-painting term. A policy that declares
//   everything occupied has no free space left and scores near zero. It is also
//   the number a user actually acts on — "can I walk there".
// * **Dilated occupied F1** is the anti-timidity term. A policy that finds
//   nothing carves everything free and would ace free-space IoU alone. F1 rather
//   than recall, because recall alone is what made painting free in the first
//   place. Dilated by one voxel because a sonar can only ever mark SURFACES, and
//   demanding voxel-exact agreement scores the discretisation rather than the
//   sensor.
//
// Gaming either one costs the other. The remaining degenerate strategy — carve
// everything free and find nothing — is caught by `regressed`, not by `primary`.
//
// ## Both classes are decided at FIXED probability thresholds
//
// 0.7 for occupied, 0.3 for free — not at the policy's own `occupiedThreshold`.
// Log-odds are policy-scaled, so scoring a map at the threshold its own policy
// chose lets a candidate lower the bar and be graded against the lower bar. The
// measuring stick has to sit outside the thing being measured.
//
// ## `noopRate` took three attempts, and the wrong two are instructive
//
// The flywheel's definition is "non-committal / empty / no-op outputs — the
// 'never end empty' signal", and its gate demands a STRICT improvement, because
// "a policy earns a promotion by making the executor COMMIT more, not just score
// higher". Getting the projection right means asking what "committing" is for a
// sonar.
//
// **Attempt 1: fraction of pings with no detections.** Backwards. Pointing at an
// open doorway SHOULD return nothing, and that silence is the strongest evidence
// in the system — it is what carves free space. Rewarding less silence drives
// straight to a trigger-happy detector that fills empty rooms with ghosts.
//
// **Attempt 2: the miss rate** — how much of what the room put in the beam the
// detector failed to report. Sounds right, and it fights `primary` head-on.
// Measured against the deliberately-bad root: tightening the detector improved
// `primary` from 0.056 to 0.107 and CUT `costPerWin` by two thirds, and the gate
// rejected it, because a stricter detector misses more. The single most useful
// class of change was structurally unpromotable. A metric that opposes the
// thing you are optimising is not strict, it is broken.
//
// **Attempt 3, and the one that is actually faithful:** a miss is an ERROR, and
// errors are already priced into `primary`. A no-op is an ABSTENTION. For a
// scan, the output is map evidence, so the scan "ends empty" to the extent that
// the volume it looked at is still undecided — voxels sitting near p = 0.5,
// touched but uncommitted.
//
//     noopRate = fraction of KNOWN voxels whose |log-odds| is below the
//                decision threshold
//
// Committing correctly improves both axes. Committing WRONGLY improves this one
// and costs `primary` — which is exactly the tension the conjunctive gate is
// for: you must commit, and you must be right. And it approaches zero
// asymptotically rather than landing on it, so the strict clause stays
// satisfiable while any real improvement remains.
//
// ## `regressed` and the false-free carve
//
// The other hard stop is the failure that makes a spatial-intelligence system
// dangerous rather than merely inaccurate: confidently marking free the space a
// wall occupies. A user acting on "clear ahead" walks into it. No amount of
// measured lift anywhere else may override that, which is precisely what
// `regressed` is for.

import {
  BatVuCore,
  DEFAULT_PING_RATE_HZ,
  OccupancyGrid,
  mainlobeHalfWidth,
  minPriSeconds,
  occupancyIoU,
  recordLenFor,
  scoreRanges,
  speedOfSound,
  type SonarConfig,
  type Vec3,
} from '@batvu/core';
import { classifyEmission } from '@batvu/horizon';
import {
  isSolid,
  rasterSweep,
  simulateScan,
  surfacePredicate,
  type Room,
  type ScanPose,
} from '@batvu/sim';
import { resolvePolicy, type SonarPolicy } from './policy.js';

export interface Score {
  primary: number;
  noopRate: number;
  costPerWin: number;
  regressed: boolean;
}

export interface EvaluationDetail extends Score {
  room: string;
  /** The composite `primary` score. */
  iou: number;
  /** How much of the genuinely open space the map got right. */
  freeIoU: number;
  /** How much of the observable surface the map found. */
  occupiedRecall: number;
  /** How much of what the map called occupied really was. */
  occupiedPrecision: number;
  occupiedF1: number;
  /** Mean fraction of in-beam surfaces the detector failed to report.
   *  Diagnostic only — NOT scored; see the note on `noopRate`. */
  missRate: number;
  /** Fraction of known voxels the scan left undecided — the `noopRate` input. */
  uncommittedFraction: number;
  /** Pings that reported nothing at all — NOT a failure on its own. */
  silentPings: number;
  /** Pings whose capture path was ruined (clipped, non-finite, no blast). */
  brokenPings: number;
  falseFreeRate: number;
  pings: number;
  elapsedMs: number;
  emissionVerdict: string;
}

export interface EvaluatorOptions {
  /** Poses per room. More is a better measurement and a slower run. */
  azSteps?: number;
  elSteps?: number;
  /** Deterministic noise seed. Same seed + same policy = same score, which is
   *  what makes a replay bundle verifiable rather than a recording. */
  seed?: number;
  /** Wall-clock source, injectable so tests can be deterministic. */
  now?: () => number;
}

// A real sweep is continuous; 24 x 3 looks is the coarsest raster whose
// 30-degree cones actually overlap enough for the corroboration threshold to be
// reachable. Sample more thinly and every policy scores an identical near-zero,
// which measures the sampling rather than the policy.
const DEFAULTS = { azSteps: 24, elSteps: 3, seed: 0x0bada55 } as const;

/**
 * Score one policy on one room.
 *
 * Runs the real pipeline end to end: synthesise the record, compress it, detect,
 * fuse into occupancy, compare with the room. Nothing is stubbed, which is the
 * point — a promotion has to mean the phone got better, not the harness.
 */
export function evaluateRoom(
  core: BatVuCore,
  policy: SonarPolicy,
  room: Room,
  options: EvaluatorOptions = {},
): EvaluationDetail {
  const { azSteps, elSteps, seed } = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => performance.now());
  const { sonar, occupancy } = resolvePolicy(policy);

  // The safety gate runs BEFORE anything is emitted, even in simulation — a
  // policy that would be unsafe on a phone must not be able to earn a score
  // that argues for promoting it.
  //
  // Judged at the rate the app actually pings, capped by the range-ambiguity
  // limit. Judging it at the theoretical maximum rate would gate configurations
  // nobody would ever run that fast; judging it at some nominal rate while the
  // app ran faster would be worse.
  const pingRateHz = Math.min(DEFAULT_PING_RATE_HZ, 1 / minPriSeconds(sonar));
  const emission = classifyEmission(sonar, pingRateHz);

  const poses: ScanPose[] = rasterSweep(azSteps, elSteps, 40);
  const started = now();

  const pings = simulateScan(core, room, poses, {
    sonar,
    seed,
    beam: { halfAngleDeg: occupancy.beamHalfAngleDeg, rays: 96 },
  });

  const grid = new OccupancyGrid(occupancy);
  const plan = core.createPlan(sonar as unknown as Record<string, unknown>, recordLenFor(sonar));

  // One resolution cell of tolerance: closer than that and the sonar genuinely
  // cannot tell two surfaces apart, so demanding better scores the test rather
  // than the system.
  const toleranceM = Math.max(0.05, rangeResolutionM(sonar));

  let missFractionSum = 0;
  let broken = 0;
  let silentPings = 0;
  try {
    for (const p of pings) {
      const result = plan.processSamples(p.samples);
      const isBroken =
        result.saturated || result.sanitized > 0 || result.blastAmplitude <= 0;
      if (isBroken) broken++;
      if (result.detections.length === 0) silentPings++;

      // Reported for diagnosis, NOT scored — see the note on attempt 2. Missing
      // a surface is an error, and errors belong to `primary`.
      if (p.truthRangesM.length > 0 && !isBroken) {
        const s = scoreRanges(result.detections, p.truthRangesM, toleranceM);
        missFractionSum += 1 - s.recall;
      } else if (isBroken) {
        missFractionSum += 1;
      }

      grid.integrate(result, {
        beam: p.pose.beam,
        origin: p.pose.origin,
        minRangeM: sonar.minRangeM,
        maxRangeM: sonar.maxRangeM,
      });
    }
  } finally {
    plan.destroy();
  }

  const elapsedMs = now() - started;
  const map = scoreMap(grid, room, sonar.maxRangeM, occupancy.voxelM);
  const iou = map.primary;
  const falseFreeRate = map.falseFreeRate;
  // Abstention, not error: how much of the volume the scan looked at it left
  // undecided. A ruined ping counts as a full abstention on top.
  const brokenShare = pings.length === 0 ? 1 : broken / pings.length;
  const noopRate = Math.min(1, map.uncommittedFraction + brokenShare);

  // Cost per IoU POINT, not per ping: a policy that doubles compute for a
  // rounding-error gain should look expensive, and per-ping cost would hide it.
  const iouPoints = Math.max(iou * 100, 0.5);
  const costPerWin = elapsedMs / iouPoints;
  void occupancyIoU;
  void surfacePredicate;

  const regressed = emission.verdict === 'deny' || falseFreeRate > 0.15;

  return {
    room: room.name,
    iou,
    uncommittedFraction: map.uncommittedFraction,
    freeIoU: map.freeIoU,
    occupiedRecall: map.occupiedRecall,
    occupiedPrecision: map.occupiedPrecision,
    occupiedF1: map.occupiedF1,
    missRate: pings.length === 0 ? 1 : missFractionSum / pings.length,
    silentPings,
    brokenPings: broken,
    falseFreeRate,
    pings: pings.length,
    elapsedMs,
    emissionVerdict: emission.verdict,
    primary: iou,
    noopRate,
    costPerWin,
    regressed,
  };
}

/** Realisable range resolution for a config, in metres. */
function rangeResolutionM(sonar: SonarConfig): number {
  const b = Math.max(1, Math.abs(sonar.f1 - sonar.f0));
  const nominal = speedOfSound(sonar.temperatureC) / (2 * b);
  // The mainlobe widening is already folded into `mainlobeHalfWidth`.
  return nominal * ((mainlobeHalfWidth(sonar) * b) / sonar.fs);
}

interface MapScore {
  /** Fraction of KNOWN voxels still sitting near p = 0.5 — the abstention axis. */
  uncommittedFraction: number;
  freeIoU: number;
  occupiedRecall: number;
  occupiedPrecision: number;
  occupiedF1: number;
  falseFreeRate: number;
  primary: number;
}

/**
 * Score a finished map against the room it was built from.
 *
 * Everything is restricted to the OBSERVABLE region — inside `maxRangeM` of the
 * scan origin. Scoring a phone on the far end of a 12 m corridor measures the
 * link budget, which is physics, not policy, and would drown the signal the
 * flywheel is trying to read.
 */
function scoreMap(
  grid: OccupancyGrid,
  room: Room,
  maxRangeM: number,
  voxelM: number,
): MapScore {
  // Fixed, policy-independent decision levels: p >= 0.7 occupied, p <= 0.3 free.
  // An untouched voxel sits at p = 0.5 and is neither — silence is not a claim.
  const OCCUPIED_LOG_ODDS = Math.log(0.7 / 0.3); // 0.847
  const FREE_LOG_ODDS = -OCCUPIED_LOG_ODDS;
  const isSurface = surfacePredicate(room, voxelM);

  let freeHit = 0;
  let freeUnion = 0;
  let surfaceTotal = 0;
  let surfaceFound = 0;
  let predictedOccupied = 0;
  let solidTotal = 0;
  let solidClaimedFree = 0;
  let known = 0;
  let uncommitted = 0;

  for (let i = 0; i < grid.data.length; i++) {
    const p: Vec3 = grid.centerOf(i);
    if (Math.hypot(p.x, p.y, p.z) > maxRangeM) continue;

    const l = grid.data[i]!;
    const solid = isSolid(room, p);
    const saysOccupied = l >= OCCUPIED_LOG_ODDS;
    const saysFree = l <= FREE_LOG_ODDS;

    if (l !== 0) {
      known++;
      // Touched but undecided: the scan looked here and came away with nothing
      // it would stand behind.
      if (!saysOccupied && !saysFree) uncommitted++;
    }

    if (solid) {
      solidTotal++;
      if (saysFree) solidClaimedFree++;
    }
    if (saysOccupied) predictedOccupied++;
    if (isSurface(p)) {
      surfaceTotal++;
      if (saysOccupied) surfaceFound++;
    }

    const trulyFree = !solid;
    if (saysFree && trulyFree) freeHit++;
    if (saysFree || trulyFree) freeUnion++;
  }

  const freeIoU = freeUnion === 0 ? 0 : freeHit / freeUnion;
  const recall = surfaceTotal === 0 ? 1 : surfaceFound / surfaceTotal;
  const precision = predictedOccupied === 0 ? (surfaceTotal === 0 ? 1 : 0) : surfaceFound / predictedOccupied;
  const occupiedF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    uncommittedFraction: known === 0 ? 1 : uncommitted / known,
    freeIoU,
    occupiedRecall: recall,
    occupiedPrecision: precision,
    occupiedF1,
    falseFreeRate: solidTotal === 0 ? 0 : solidClaimedFree / solidTotal,
    primary: 0.5 * freeIoU + 0.5 * occupiedF1,
  };
}

/** Aggregate a suite of rooms into the one `Score` the gate sees. */
export function aggregate(details: readonly EvaluationDetail[]): Score {
  if (details.length === 0) {
    return { primary: 0, noopRate: 1, costPerWin: Infinity, regressed: true };
  }
  const mean = (f: (d: EvaluationDetail) => number): number =>
    details.reduce((a, d) => a + f(d), 0) / details.length;
  return {
    primary: mean((d) => d.primary),
    noopRate: mean((d) => d.noopRate),
    costPerWin: mean((d) => d.costPerWin),
    // ANY room regressing regresses the suite. Averaging a safety flag would let
    // three good rooms vote down one that carves through a wall.
    regressed: details.some((d) => d.regressed),
  };
}

/** Build the `Evaluator` the flywheel engine takes. */
export function makeEvaluator(
  core: BatVuCore,
  options: EvaluatorOptions = {},
): (policy: SonarPolicy, suite: { id: string; items: unknown[] }) => Promise<Score> {
  return async (policy, suite) => {
    const rooms = suite.items as Room[];
    const details = rooms.map((room) => evaluateRoom(core, policy, room, options));
    return aggregate(details);
  };
}
