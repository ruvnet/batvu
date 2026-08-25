// SPDX-License-Identifier: MIT
//
// End-to-end scan synthesis: a room and a sweep in, captured records out.
//
// This closes the loop that makes everything downstream measurable. A scan
// simulated here goes through exactly the code the phone runs — the same wasm,
// the same matched filter, the same CFAR, the same occupancy update — so a
// number produced in CI means the same thing as a number produced on a phone.
//
// It is also the reason the flywheel can run at all. Evolving DSP policy needs
// thousands of scored scans; a room does not fit in a CI runner, and a human
// cannot hold a phone ten thousand times.

import {
  DEFAULT_SONAR_CONFIG,
  coneRays,
  fromSpherical,
  recordLenFor,
  type BatVuCore,
  type SimScene,
  type SonarConfig,
  type Vec3,
} from '@batvu/core';
import { DEFAULT_BEAM_SAMPLE, sampleBeam, type BeamSampleOptions, type Room } from './room.js';

export interface ScanPose {
  origin: Vec3;
  beam: Vec3;
}

export interface SimulatedPing {
  pose: ScanPose;
  /** The captured record, ready to hand to a `SonarPlan`. */
  samples: Float32Array;
  /** What the room actually contained in this beam — the per-ping ground truth. */
  truthRangesM: number[];
}

export interface SimulateScanOptions {
  sonar?: Partial<SonarConfig>;
  scene?: SimScene;
  beam?: Partial<BeamSampleOptions>;
  /** Base PRNG seed. Each ping gets `seed + index` so a scan replays exactly
   *  while no two pings share a noise realisation. */
  seed?: number;
}

/**
 * A horizontal sweep — the motion a person actually performs when asked to
 * "scan the room": stand still and turn on the spot.
 */
export function horizontalSweep(count: number, elevationDeg = 0, startDeg = -180, endDeg = 180): ScanPose[] {
  const out: ScanPose[] = [];
  const el = (elevationDeg * Math.PI) / 180;
  for (let i = 0; i < count; i++) {
    const frac = count === 1 ? 0 : i / (count - 1);
    const az = ((startDeg + frac * (endDeg - startDeg)) * Math.PI) / 180;
    out.push({ origin: { x: 0, y: 0, z: 0 }, beam: fromSpherical({ azimuth: az, elevation: el }) });
  }
  return out;
}

/**
 * A raster sweep across azimuth and elevation — a more thorough head scan, and
 * the one that actually populates a 3-D map rather than a horizontal slice.
 */
export function rasterSweep(azSteps: number, elSteps: number, elRangeDeg = 60): ScanPose[] {
  const out: ScanPose[] = [];
  for (let e = 0; e < elSteps; e++) {
    const elFrac = elSteps === 1 ? 0.5 : e / (elSteps - 1);
    const el = ((elFrac - 0.5) * elRangeDeg * Math.PI) / 180;
    for (let a = 0; a < azSteps; a++) {
      // Serpentine, so consecutive poses are adjacent — a real sweep does not
      // teleport back to the start of each row, and pose-dependent artifacts
      // only show up if the simulated motion is plausible.
      const idx = e % 2 === 0 ? a : azSteps - 1 - a;
      const az = ((idx / azSteps) * 360 - 180) * (Math.PI / 180);
      out.push({ origin: { x: 0, y: 0, z: 0 }, beam: fromSpherical({ azimuth: az, elevation: el }) });
    }
  }
  return out;
}

/**
 * Render a whole scan.
 *
 * Each pose is turned into a target list by ray-casting the room, then into a
 * waveform by the Rust simulator — the same simulator the DSP unit tests use, so
 * there is exactly one model of the acoustics in the project.
 */
export function simulateScan(
  core: BatVuCore,
  room: Room,
  poses: readonly ScanPose[],
  options: SimulateScanOptions = {},
): SimulatedPing[] {
  const sonar = { ...DEFAULT_SONAR_CONFIG, ...options.sonar };
  const beamOpts: BeamSampleOptions = {
    ...DEFAULT_BEAM_SAMPLE,
    maxRangeM: sonar.maxRangeM,
    ...options.beam,
  };
  const recordLen = options.scene?.recordLen ?? recordLenFor(sonar);
  const seed = options.seed ?? 0x5eed1234;
  const halfAngle = (beamOpts.halfAngleDeg * Math.PI) / 180;

  return poses.map((pose, i) => {
    const rays = coneRays(pose.beam, halfAngle, beamOpts.rays);
    const targets = sampleBeam(room, pose.origin, pose.beam, rays, beamOpts);
    const res = core.eval<{ samples: number[] }>({
      op: 'simulate',
      config: sonar,
      targets,
      scene: {
        recordLen,
        noiseRms: 5e-4,
        ...options.scene,
        // Each ping gets its own noise realisation, derived from the base seed
        // so the whole scan still replays bit for bit.
        seed: (seed + i * 2654435761) >>> 0,
      },
    });
    return {
      pose,
      samples: Float32Array.from(res.samples),
      truthRangesM: targets.map((t) => t.rangeM),
    };
  });
}
