// SPDX-License-Identifier: MIT
//
// @batvu/micromotion — ADR-023 Decision 3, the classical detector.
//
// A second instrument sharing a transducer. The scanner turns on the spot at
// fifteen pings a second and builds a map; this one stares at ONE bearing for
// tens of seconds and asks whether anything in that direction is moving by
// millimetres, periodically. ADR-023 §3 is explicit that these are mutually
// exclusive modes — micro-motion sensing is not a feature bolted onto the
// sweep, and nothing in this package should be run inside one.
//
// ## Why classical, and why first
//
// Breathing is a narrowband periodic phase modulation in a known band. That is
// signal processing, and signal processing yields a number with a false-alarm
// rate attached — `detector.ts` derives its own, from a null distribution
// written down in full rather than measured against the code that produced it.
// A learned classifier would forfeit that for nothing on a binary problem, and
// ADR-023 defers it to the genuinely multi-way question: person against pet
// against fan against a curtain in a draught.
//
// The flywheel searches this detector's PARAMETERS — band edges, dwell, SNR
// gate — against captures it did not produce. `meetsPromotionRule` stays frozen
// and conjunctive, and the simulator is barred from scoring any of it: a
// detector tuned against a simulated breather is a detector tuned against
// arithmetic that was written to make it fire.
//
// ## What it will not do
//
// - **It does not say a person is there.** `micromotion_band` and nothing else.
//   See the refusal at the top of `detector.ts`, and ADR-023 §5.
// - **It has never met a room.** Everything here is unit-tested against phase
//   modulations synthesised in the test file, which proves the arithmetic and
//   proves nothing about people. BatVu has measured zero real rooms.
// - **It assumes the transmit path stays coherent across the dwell.** ADR-007's
//   latency argument covers RANGING, where the unknown delay hits the blast
//   too and subtracts out. Phase coherence over tens of seconds is a strictly
//   stronger requirement and has not been demonstrated on a phone.
//   TODO(ADR-023): the one-afternoon experiment — phone flat on a table, a
//   person seated at two metres — answers this before any of it is worth
//   tuning.

export {
  analyzeDwell,
  micromotionFeature,
  estimateNoiseFloor,
  wavelengthM,
  phaseNoiseStdRad,
  unwrapInPlace,
  fisherGPValue,
  fisherGThreshold,
} from './detector.js';
export type {
  ComplexProfileDwell,
  DwellOptions,
  MicroMotionBin,
  MicroMotionDwell,
} from './detector.js';
