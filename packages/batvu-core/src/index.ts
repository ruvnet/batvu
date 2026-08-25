// SPDX-License-Identifier: MIT
//
// @batvu/core — the portable half of BatVu.
//
// One speaker, one microphone, an ultrasonic chirp, and enough signal processing
// to turn the echo into a room. This package binds the Rust/WASM sonar core
// (`crates/batvu-dsp`), fuses each ping with the phone's attitude, and folds the
// result into a log-odds occupancy map through a sonar inverse sensor model.
//
// It runs unchanged in Node and in iOS Safari — the same wasm, the same
// arithmetic, the same answers. That is what lets CI, the flywheel and the phone
// argue about the same numbers.
//
// ## The honest bound, stated once
//
// A single transducer pair measures RANGE. Not bearing, not shape. Direction
// comes entirely from where the phone was pointing, and the map is a fusion of
// many wide, overlapping cones. Nothing here is a depth camera, and any view
// that looks like one is the renderer's editorial choice, not a measurement.

export { BatVuCore, SonarPlan } from './wasm.js';
export type { WasmSource, Detection, PingResult } from './wasm.js';

export {
  DEFAULT_SONAR_CONFIG,
  speedOfSound,
  recordLenFor,
  minPriSeconds,
  mainlobeWidening,
  mainlobeHalfWidth,
  recommendedCfarWindows,
  priSamplesFor,
  DEFAULT_PING_RATE_HZ,
} from './config.js';
export type { SonarConfig, DesignReport } from './config.js';

export {
  TRANSDUCER_AXIS_DEVICE,
  vec3,
  normalize,
  dot,
  cross,
  scale,
  add,
  sub,
  distance,
  angleBetween,
  deviceToWorld,
  beamDirection,
  toSpherical,
  fromSpherical,
  coneRays,
  angularCoverage,
  sphericalBin,
} from './geometry.js';
export type { Vec3, DeviceOrientation, Spherical } from './geometry.js';

export {
  OccupancyGrid,
  DEFAULT_OCCUPANCY_CONFIG,
  occupancyIoU,
} from './occupancy.js';
export type { OccupancyConfig, IntegrateOptions, IntegrationStats } from './occupancy.js';

export { ScanSession } from './scan.js';
export type { ScanSessionOptions, ScanPing, ScanState } from './scan.js';

export { scoreRanges, chamferDistance } from './metrics.js';
export type { RangeScore, RangeLike } from './metrics.js';

export { WINDOW_NAMES } from './types.js';
export type { WindowName, SimTarget, SimScene } from './types.js';
