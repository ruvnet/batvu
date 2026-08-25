// SPDX-License-Identifier: MIT
//
// The sonar inverse sensor model and a log-odds occupancy grid — the step that
// turns a pile of range readings into a room.
//
// ## The problem this file exists to solve honestly
//
// A phone has ONE speaker and ONE microphone. That gives range and nothing else.
// A detection at 2.4 m does not say "there is a wall 2.4 m ahead"; it says "the
// nearest reflector somewhere inside a cone tens of degrees wide is 2.4 m away".
// Painting a point at 2.4 m along the pointing axis would look like a depth
// camera and would be a fabrication.
//
// So each detection deposits its evidence across the whole cone (Elfes/Moravec,
// as sonar mapping has done since the 1980s), and the map sharpens only where
// cones from DIFFERENT attitudes disagree. Concretely:
//
// * **Free space is the strong evidence.** "Nothing returned before 2.4 m along
//   any of these directions" is a confident, direction-specific statement, and
//   it is what carves the false parts of other pings' arcs away.
// * **Occupied is the weak evidence.** It is smeared over the arc, and only
//   accumulates where several arcs cross. `occupiedThreshold` is deliberately
//   set above `logOddsHit`, so ONE wide-beam ping can never declare a voxel
//   occupied — corroboration from a second attitude is required.
// * **Beyond a detection is unknown**, not free and not occupied — the first
//   reflector shadows everything behind it.
//
// This asymmetry is why a scan has to SWEEP. One ping from one attitude produces
// a shell of ambiguity; twenty pings across a head-turn produce a room.
//
// ## Why the cone is traversed by voxel, not ray-cast
//
// The obvious implementation casts N rays through the cone. It is wrong at
// range: N rays diverge, and past `r = voxel / angularSpacing` consecutive rays
// are more than a voxel apart, so the deposited shell becomes a sparse dotting
// with holes — including, for most N, a hole exactly on the beam axis, because
// a Fibonacci spiral never samples its own pole. Raising N does not fix it: the
// count needed grows as r^2 and is unbounded.
//
// Sampling the shell in spherical coordinates at voxel-sized steps is hole-free
// but pays for it — it oversamples near the apex by the same r^2 factor, and
// measured at 500k trig-heavy point evaluations to update 60k voxels.
//
// So the traversal is inverted: iterate the VOXELS of the cone's exact bounding
// box and test each for membership with two dot products. Every voxel in the
// cone is visited exactly once, holes are impossible by construction, and the
// inner loop is arithmetic instead of trigonometry.

import { normalize, type Vec3 } from './geometry.js';
import type { Detection, PingResult } from './wasm.js';

export interface OccupancyConfig {
  /** Half-extent of the mapped cube about the origin, in metres. */
  extentM: number;
  /** Voxel edge length in metres. */
  voxelM: number;
  /** Log-odds added to a voxel a detection lands in. */
  logOddsHit: number;
  /** Log-odds subtracted from a voxel a pulse passed through. */
  logOddsMiss: number;
  /** Clamps. Without them a voxel saturates and can never be revised — the map
   *  stops being able to learn that the chair moved. */
  logOddsMin: number;
  logOddsMax: number;
  /** Log-odds at or above which a voxel counts as occupied. Keep it above
   *  `logOddsHit` so a single wide-beam ping cannot localise on its own. */
  occupiedThreshold: number;
  /** Half-angle of the transmit/receive beam, in degrees. The single most
   *  consequential mapping lever: too narrow draws a confident wrong map, too
   *  wide smears every wall into fog. */
  beamHalfAngleDeg: number;
  /** Stop carving free space this far short of a detection, so range error does
   *  not carve away the very surface that produced the echo. */
  freeMarginM: number;
  /** Weight a detection's evidence by SNR, saturating at this many dB. */
  snrReferenceDb: number;
}

export const DEFAULT_OCCUPANCY_CONFIG: OccupancyConfig = {
  extentM: 6,
  voxelM: 0.1,
  logOddsHit: 0.85,
  logOddsMiss: 0.4,
  logOddsMin: -4,
  logOddsMax: 4,
  occupiedThreshold: 1.4,
  beamHalfAngleDeg: 30,
  freeMarginM: 0.15,
  snrReferenceDb: 20,
};

export interface IntegrateOptions {
  /** Where the phone was, in world metres. Orientation-only scans leave this at
   *  the origin — see `ScanSession` for why translation is not integrated. */
  origin?: Vec3;
  /** Which way the transducers pointed. */
  beam: Vec3;
  /** Furthest range the ping could have seen — used to carve free space when
   *  NOTHING was detected, which is itself strong evidence. */
  maxRangeM: number;
  minRangeM: number;
}

export interface IntegrationStats {
  /** Voxels updated by this ping (each at most once). */
  voxelsTouched: number;
  voxelsOccupiedEvidence: number;
  voxelsFreeEvidence: number;
  detections: number;
  occupiedBefore: number;
  occupiedAfter: number;
  /** Net change in the occupied set — the horizon progress signal's raw input. */
  changed: number;
}

/**
 * A bounded log-odds voxel grid.
 *
 * Bounded on purpose. An unbounded or hashed grid invites the map to grow with
 * accumulated drift, and with orientation-only pose (ADR-006) there is no honest
 * way to place anything beyond a few metres of the scan origin anyway. The cube
 * is the claim: this is the region we are willing to say something about.
 */
export class OccupancyGrid {
  readonly config: OccupancyConfig;
  readonly dim: number;
  readonly origin: number;
  private readonly cells: Float32Array;
  /**
   * Per-ping dedup: `touch[i] >>> 1` is the ping that last wrote voxel `i`, and
   * bit 0 records whether it was occupied evidence. Without it the shell walk
   * would bump a near-field voxel dozens of times in one ping — angular sampling
   * necessarily oversamples close to the origin — and a single ping would
   * saturate the map it is supposed to only nudge.
   */
  private readonly touch: Uint32Array;
  private pingId = 0;

  constructor(config: Partial<OccupancyConfig> = {}) {
    this.config = { ...DEFAULT_OCCUPANCY_CONFIG, ...config };
    if (!(this.config.voxelM > 0)) throw new Error('batvu: voxelM must be positive');
    if (!(this.config.extentM > 0)) throw new Error('batvu: extentM must be positive');
    this.dim = Math.max(1, Math.ceil((2 * this.config.extentM) / this.config.voxelM));
    this.origin = -this.config.extentM;
    this.cells = new Float32Array(this.dim * this.dim * this.dim);
    this.touch = new Uint32Array(this.cells.length);
  }

  get voxelCount(): number {
    return this.cells.length;
  }

  /** Bytes of backing store — the number that decides whether a resolution is
   *  viable on a phone. 0.1 m over a 6 m half-extent is 14 MB; 0.05 m is 110 MB. */
  get byteLength(): number {
    return this.cells.byteLength + this.touch.byteLength;
  }

  /** Grid index for a world point, or -1 if it falls outside the cube. */
  indexOf(p: Vec3): number {
    const { voxelM } = this.config;
    const i = Math.floor((p.x - this.origin) / voxelM);
    const j = Math.floor((p.y - this.origin) / voxelM);
    const k = Math.floor((p.z - this.origin) / voxelM);
    if (i < 0 || j < 0 || k < 0 || i >= this.dim || j >= this.dim || k >= this.dim) return -1;
    return (k * this.dim + j) * this.dim + i;
  }

  /** World-space centre of a voxel index. */
  centerOf(index: number): Vec3 {
    const { voxelM } = this.config;
    const i = index % this.dim;
    const j = Math.floor(index / this.dim) % this.dim;
    const k = Math.floor(index / (this.dim * this.dim));
    return {
      x: this.origin + (i + 0.5) * voxelM,
      y: this.origin + (j + 0.5) * voxelM,
      z: this.origin + (k + 0.5) * voxelM,
    };
  }

  logOddsAt(p: Vec3): number {
    const idx = this.indexOf(p);
    return idx < 0 ? 0 : this.cells[idx]!;
  }

  probabilityAt(p: Vec3): number {
    return 1 / (1 + Math.exp(-this.logOddsAt(p)));
  }

  isOccupied(p: Vec3): boolean {
    return this.logOddsAt(p) >= this.config.occupiedThreshold;
  }

  /**
   * Fold one ping into the map.
   *
   * Occupied evidence is deposited first so that free-space carving cannot erase
   * the surface that produced the echo in the same breath.
   */
  integrate(ping: PingResult, opts: IntegrateOptions): IntegrationStats {
    const origin = opts.origin ?? { x: 0, y: 0, z: 0 };
    const cfg = this.config;
    const beam = normalize(opts.beam);
    const halfAngle = (cfg.beamHalfAngleDeg * Math.PI) / 180;
    const before = this.occupiedCount();
    this.pingId++;

    const detections = usableDetections(ping);
    let occupiedEvidence = 0;
    let freeEvidence = 0;

    for (const det of detections) {
      const confidence = Math.min(1, Math.max(0, det.snrDb / cfg.snrReferenceDb));
      if (confidence <= 0) continue;
      // The shell must be at least a voxel DIAGONAL thick, not a voxel edge.
      // Membership is tested at voxel centres, and a voxel whose interior
      // straddles the true range can have its centre up to half a diagonal
      // (0.87 voxels) away from it — so an edge-thick shell silently deposits
      // nothing for exactly the targets that land near a voxel corner.
      const thickness = Math.max(cfg.voxelM * Math.SQRT2 * 1.23, det.widthM, ping.rangeStepM * 2);
      occupiedEvidence += this.walkCone(
        origin,
        beam,
        halfAngle,
        Math.max(0, det.rangeM - thickness / 2),
        det.rangeM + thickness / 2,
        cfg.logOddsHit * confidence,
        true,
      );
    }

    // Only the NEAREST detection bounds free space: everything past it is in
    // shadow. With no detections at all, the cone is clear to max range — and
    // that silence is how a scan proves a doorway is a doorway.
    const nearest = detections.length
      ? detections.reduce((a, b) => (a.rangeM <= b.rangeM ? a : b)).rangeM - cfg.freeMarginM
      : opts.maxRangeM;
    freeEvidence = this.walkCone(
      origin,
      beam,
      halfAngle,
      opts.minRangeM,
      Math.max(opts.minRangeM, nearest),
      -cfg.logOddsMiss,
      false,
    );

    const after = this.occupiedCount();
    return {
      voxelsTouched: occupiedEvidence + freeEvidence,
      voxelsOccupiedEvidence: occupiedEvidence,
      voxelsFreeEvidence: freeEvidence,
      detections: detections.length,
      occupiedBefore: before,
      occupiedAfter: after,
      changed: Math.abs(after - before),
    };
  }

  /**
   * Apply `delta` exactly once to every voxel whose centre lies inside the cone
   * between two ranges.
   *
   * Iterates the cone's exact axis-aligned bounding box and tests membership.
   * The bound is not the enclosing sphere's: the furthest a cone reaches along a
   * world axis `e` is `rMax * cos(max(0, angle(e, axis) - halfAngle))`, which is
   * exact and costs six cosines. For a 30-degree beam that is a far smaller box
   * than the sphere, and the difference is most of the work.
   */
  private walkCone(
    origin: Vec3,
    axis: Vec3,
    halfAngle: number,
    fromM: number,
    toM: number,
    delta: number,
    isOccupiedEvidence: boolean,
  ): number {
    if (!(toM > fromM) || delta === 0) return 0;
    const { voxelM, logOddsMin, logOddsMax } = this.config;
    const cosHalf = Math.cos(Math.min(Math.PI, Math.max(0, halfAngle)));
    const from2 = fromM * fromM;
    const to2 = toM * toM;

    const lo = { x: 0, y: 0, z: 0 };
    const hi = { x: 0, y: 0, z: 0 };
    for (const key of ['x', 'y', 'z'] as const) {
      const pos: Vec3 = { x: 0, y: 0, z: 0 };
      pos[key] = 1;
      const neg: Vec3 = { x: 0, y: 0, z: 0 };
      neg[key] = -1;
      hi[key] = origin[key] + coneReach(axis, pos, halfAngle, fromM, toM);
      lo[key] = origin[key] - coneReach(axis, neg, halfAngle, fromM, toM);
    }

    const i0 = Math.max(0, Math.floor((lo.x - this.origin) / voxelM));
    const i1 = Math.min(this.dim - 1, Math.floor((hi.x - this.origin) / voxelM));
    const j0 = Math.max(0, Math.floor((lo.y - this.origin) / voxelM));
    const j1 = Math.min(this.dim - 1, Math.floor((hi.y - this.origin) / voxelM));
    const k0 = Math.max(0, Math.floor((lo.z - this.origin) / voxelM));
    const k1 = Math.min(this.dim - 1, Math.floor((hi.z - this.origin) / voxelM));

    let touched = 0;
    const stampValue = (this.pingId << 1) | (isOccupiedEvidence ? 1 : 0);
    for (let k = k0; k <= k1; k++) {
      const dz = this.origin + (k + 0.5) * voxelM - origin.z;
      for (let j = j0; j <= j1; j++) {
        const dy = this.origin + (j + 0.5) * voxelM - origin.y;
        const rowBase = (k * this.dim + j) * this.dim;
        for (let i = i0; i <= i1; i++) {
          const dx = this.origin + (i + 0.5) * voxelM - origin.x;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 < from2 || r2 > to2) continue;
          const along = dx * axis.x + dy * axis.y + dz * axis.z;
          // cos(angle) = along / |d|; compare squared to avoid the sqrt, taking
          // care that a negative `along` is always outside a sub-90-degree cone.
          if (along <= 0) continue;
          if (along * along < cosHalf * cosHalf * r2) continue;

          const idx = rowBase + i;
          if (this.touch[idx]! >>> 1 === this.pingId) continue;
          this.touch[idx] = stampValue;
          this.cells[idx] = Math.min(
            logOddsMax,
            Math.max(logOddsMin, this.cells[idx]! + delta),
          );
          touched++;
        }
      }
    }
    return touched;
  }

  occupiedCount(): number {
    const t = this.config.occupiedThreshold;
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]! >= t) n++;
    return n;
  }

  /** Voxels the scan has said anything about at all. */
  knownCount(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]! !== 0) n++;
    return n;
  }

  /** World-space centres of every occupied voxel — what the renderer draws. */
  occupiedPoints(): Vec3[] {
    const t = this.config.occupiedThreshold;
    const out: Vec3[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i]! >= t) out.push(this.centerOf(i));
    }
    return out;
  }

  /**
   * Mean binary entropy over the KNOWN voxels, in bits.
   *
   * The scan's confidence, not its coverage: it falls as the map commits to
   * occupied or free, and says nothing about the parts of the room never looked
   * at. Paired with `angularCoverage` it distinguishes "I have studied one wall
   * exhaustively" from "I have surveyed the room".
   */
  meanEntropy(): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const l = this.cells[i]!;
      if (l === 0) continue;
      const p = 1 / (1 + Math.exp(-l));
      if (p > 0 && p < 1) sum += -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
      n++;
    }
    return n === 0 ? 0 : sum / n;
  }

  /**
   * A cheap, stable signature of map state.
   *
   * This is what the horizon `HaltController` compares between sweeps to decide
   * whether the scan is still making progress. It must change when the map
   * changes and NOT change when it does not — a signature that drifted with
   * floating-point noise would make no-progress detection impossible — so the
   * log-odds are quantised before hashing.
   */
  stateSignature(): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.cells.length; i++) {
      const q = Math.round(this.cells[i]! * 4);
      if (q === 0) continue;
      h ^= i + 0x9e3779b9;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= q & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `fnv1a:${h.toString(16).padStart(8, '0')}`;
  }

  get updateCount(): number {
    return this.pingId;
  }

  /** Raw log-odds, for renderers and tests. Do not mutate. */
  get data(): Float32Array {
    return this.cells;
  }

  reset(): void {
    this.cells.fill(0);
    this.touch.fill(0);
    this.pingId = 0;
  }
}

/**
 * How far the truncated cone `{ r*u : rMin <= r <= rMax, angle(u, axis) <= halfAngle }`
 * reaches along the unit direction `dir` — i.e. `max` of `dot(point, dir)` over it.
 *
 * The best available direction is `dir` itself when it lies inside the cone, and
 * otherwise the rim direction `halfAngle` from the axis toward it, giving
 * `cosBest = cos(max(0, angle - halfAngle))`.
 *
 * The RANGE that maximises then depends on the sign, and getting this wrong is
 * how a bounding box silently loses the near half of its own cone: with
 * `cosBest > 0` the furthest point is at `rMax`, but with `cosBest < 0` every
 * point has a negative projection and the LARGEST one is at `rMin`. Using
 * `rMax` in both cases pushes the lower bound past the whole cone, and the walk
 * updates nothing at all.
 */
function coneReach(
  axis: Vec3,
  dir: Vec3,
  halfAngle: number,
  rMin: number,
  rMax: number,
): number {
  const cosAngle = Math.min(1, Math.max(-1, axis.x * dir.x + axis.y * dir.y + axis.z * dir.z));
  const cosBest = Math.cos(Math.max(0, Math.acos(cosAngle) - halfAngle));
  return cosBest >= 0 ? rMax * cosBest : rMin * cosBest;
}

/** Detections worth mapping: finite, positive range, real SNR. */
function usableDetections(ping: PingResult): Detection[] {
  if (ping.saturated) return []; // a clipped record's ranges are fiction
  return ping.detections.filter(
    (d) => Number.isFinite(d.rangeM) && d.rangeM > 0 && Number.isFinite(d.snrDb) && d.snrDb > 0,
  );
}

/**
 * Intersection-over-union of occupied voxels against a ground-truth predicate.
 *
 * The flywheel's `primary` axis. IoU rather than accuracy because a room is
 * mostly empty: a map that predicts "free everywhere" scores over 95% accuracy
 * and is worth nothing.
 */
export function occupancyIoU(grid: OccupancyGrid, truth: (p: Vec3) => boolean): number {
  const t = grid.config.occupiedThreshold;
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < grid.data.length; i++) {
    const predicted = grid.data[i]! >= t;
    const actual = truth(grid.centerOf(i));
    if (predicted && actual) intersection++;
    if (predicted || actual) union++;
  }
  return union === 0 ? 1 : intersection / union;
}
