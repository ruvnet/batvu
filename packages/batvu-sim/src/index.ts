// SPDX-License-Identifier: MIT
//
// @batvu/sim — the ground truth.
//
// A 3-D room, a beam pointed into it, and the record a phone would have
// captured. Everything BatVu claims about accuracy is measured here, because a
// tape measure cannot keep up with a sonar and a CI runner cannot hold a phone.
//
// The acoustics live in ONE place — the Rust simulator in `crates/batvu-dsp` —
// and this package supplies only the geometry that turns an attitude into the
// 1-D target list that simulator takes. Two models of the physics would drift,
// and the day they disagreed, every test would still pass.

export {
  castRay,
  isSolid,
  surfacePredicate,
  sampleBeam,
  emptyRoom,
  pillar,
  DEFAULT_BEAM_SAMPLE,
} from './room.js';
export type { Box, Room, RayHit, BeamSampleOptions } from './room.js';

export { simulateScan, horizontalSweep, rasterSweep } from './scan.js';
export type { ScanPose, SimulatedPing, SimulateScanOptions } from './scan.js';

export {
  livingRoom,
  corridor,
  clutteredOffice,
  smallBathroom,
  safetyRoom,
  emptyHall,
  narrowNook,
  holdoutRooms,
  anchorRooms,
} from './scenes.js';
