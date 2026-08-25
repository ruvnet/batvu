// SPDX-License-Identifier: MIT
//
// A scan session: many pings from many attitudes, fused into one map.
//
// ## Why v1 is orientation-only
//
// The obvious ambition is to walk around the room and build a full 3-D model.
// The obvious ambition is not available. A browser can read the accelerometer,
// and integrating acceleration twice to get position accumulates error as t^2 —
// a consumer MEMS accelerometer drifts metres within seconds, which is worse
// than useless when the whole map is 6 m across. iOS Safari does not expose
// ARKit's visual-inertial pose to the page.
//
// So BatVu v1 pins the origin and integrates ORIENTATION only: stand still,
// sweep the phone like a torch, and the reconstruction is a spherical shell of
// the room seen from one point. That is a real, defensible product — it is close
// to what a stationary bat gets from a head scan — and it is honest, which
// "walk around and we will figure it out" would not be.
//
// `origin` is still a parameter throughout, so a future pose source (WebXR, an
// external tracker) drops in without reshaping anything.

import { DEFAULT_SONAR_CONFIG, recordLenFor, type SonarConfig } from './config.js';
import {
  angularCoverage,
  beamDirection,
  type DeviceOrientation,
  type Vec3,
} from './geometry.js';
import { OccupancyGrid, type IntegrationStats, type OccupancyConfig } from './occupancy.js';
import type { BatVuCore, PingResult, SonarPlan } from './wasm.js';

export interface ScanSessionOptions {
  sonar?: Partial<SonarConfig>;
  occupancy?: Partial<OccupancyConfig>;
  /** Override the record length; defaults to whatever `maxRangeM` needs. */
  recordLen?: number;
}

/** One ping, with everything needed to explain or replay it. */
export interface ScanPing {
  index: number;
  beam: Vec3;
  origin: Vec3;
  result: PingResult;
  stats: IntegrationStats;
}

/** The health of a scan, as the session controller sees it. */
export interface ScanState {
  pings: number;
  /** Fraction of the sphere the beam has pointed at. */
  coverage: number;
  /** Mean binary entropy over known voxels — confidence, not coverage. */
  entropy: number;
  occupiedVoxels: number;
  knownVoxels: number;
  /** Stable hash of the map. The horizon halt controller's progress signal. */
  signature: string;
  /** Pings in a row that produced no detections. */
  silentStreak: number;
  /** Pings in a row whose record clipped. */
  saturatedStreak: number;
}

export class ScanSession {
  readonly sonar: SonarConfig;
  readonly grid: OccupancyGrid;
  readonly plan: SonarPlan;
  private readonly beams: Vec3[] = [];
  private pingCount = 0;
  private silentStreak = 0;
  private saturatedStreak = 0;

  constructor(
    private readonly core: BatVuCore,
    options: ScanSessionOptions = {},
  ) {
    this.sonar = { ...DEFAULT_SONAR_CONFIG, ...options.sonar };
    this.grid = new OccupancyGrid(options.occupancy);
    const recordLen = options.recordLen ?? recordLenFor(this.sonar);
    this.plan = this.core.createPlan(this.sonar as unknown as Record<string, unknown>, recordLen);
  }

  /** The exact transmit waveform, so playback and the matched filter agree. */
  transmitWaveform(): Float32Array {
    const res = this.core.eval<{ samples: number[] }>({
      op: 'chirp',
      config: this.sonar,
    });
    return Float32Array.from(res.samples);
  }

  /** Process one captured record and fold it into the map. */
  ping(samples: Float32Array | number[], orientation: DeviceOrientation, origin?: Vec3): ScanPing {
    return this.pingWithBeam(samples, beamDirection(orientation), origin);
  }

  /** As `ping`, but with the beam direction supplied directly — used by the
   *  simulator and by tests, which know where the phone is pointing exactly. */
  pingWithBeam(samples: Float32Array | number[], beam: Vec3, origin?: Vec3): ScanPing {
    const result = this.plan.processSamples(samples);
    const at = origin ?? { x: 0, y: 0, z: 0 };
    const stats = this.grid.integrate(result, {
      origin: at,
      beam,
      minRangeM: this.sonar.minRangeM,
      maxRangeM: this.sonar.maxRangeM,
    });

    this.beams.push(beam);
    this.pingCount++;
    this.silentStreak = result.detections.length === 0 ? this.silentStreak + 1 : 0;
    this.saturatedStreak = result.saturated ? this.saturatedStreak + 1 : 0;

    return { index: this.pingCount - 1, beam, origin: at, result, stats };
  }

  state(): ScanState {
    return {
      pings: this.pingCount,
      coverage: angularCoverage(this.beams),
      entropy: this.grid.meanEntropy(),
      occupiedVoxels: this.grid.occupiedCount(),
      knownVoxels: this.grid.knownCount(),
      signature: this.grid.stateSignature(),
      silentStreak: this.silentStreak,
      saturatedStreak: this.saturatedStreak,
    };
  }

  /**
   * A failure signature for the horizon halt controller, or null if this ping
   * was fine.
   *
   * The distinction that matters: a ping with no detections is not a failure —
   * pointing at an open doorway is supposed to return nothing, and that silence
   * is the evidence that carves the doorway. It only becomes a failure when it
   * REPEATS, which means the mic died or the speaker stopped. Treating single
   * silences as failures would abort every scan of a room with a door in it.
   */
  failureSignature(ping: ScanPing): string | null {
    if (ping.result.saturated) return 'saturated';
    if (ping.result.sanitized > 0) return 'non-finite-samples';
    if (ping.result.blastAmplitude <= 0) return 'no-direct-path';
    if (this.silentStreak >= 5) return 'silent';
    return null;
  }

  destroy(): void {
    this.plan.destroy();
  }
}
