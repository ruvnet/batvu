// SPDX-License-Identifier: MIT
//
// @batvu/capture — ADR-023 Decisions 2 and 6, the paired-capture corpus.
//
// One phone, two instruments, one record. The sonar contributes a dwell of
// complex range profiles down one bearing; ARKit's scene depth contributes the
// true range along that same bearing and whether it saw a body. Neither sensor
// could produce this corpus alone — LiDAR cannot hear breathing and the sonar
// cannot see a person — and that is the whole of ADR-023 §2's argument for why
// this package exists before any hardware campaign rather than after one.
//
// ## The three things this package refuses to do
//
// **It does not label anything `presence`.** The label in a record is
// `body_in_scene`: the depth camera's report, sealed, opened by name. BatVu
// still populates `range_m` and `micromotion_band` and nothing else, the gates
// in `ultrasonic_gates.rs` are untouched, and the vocabulary check in
// `corpus.ts` makes a record that invents a `presence` field a parse error.
//
// **It does not half-load.** A missing consent receipt refuses the FILE, not the
// record. See the header of `corpus.ts` for why a corpus that quietly shrank is
// worse than one that would not open.
//
// **It does not hand the label to the detector.** `record.measurement` is what a
// detector reads and `record.label` has no readable members — the payload lives
// behind `openTeacherLabel`, in the type system and in a `WeakMap` at runtime,
// because a brand is erased at build time and the leaks that matter go through
// code that lost its types.
//
// ## What it has never done
//
// Met a room. There is no capture in this repository, real or otherwise, and
// this package has never parsed one. Everything below is a format and its
// refusals, unit-tested against records the tests construct — which proves the
// bounds and proves nothing about people. ADR-023's own consequences section
// says it plainly: most of that ADR describes a system that cannot be validated
// here.
//
// TODO(ADR-023): the fixture loop `@batvu/field` closes — an artefact this repo
// writes and the Rust adapter's own test suite reads, so a schema divergence
// fails a build — has no counterpart here, because nothing downstream parses
// `.presence.jsonl` yet. The corpus never leaves the device (§6), so the
// consumer will be on the phone, and the conformance test will be an end-to-end
// one against a real capture or it will not exist.

export {
  SCHEMA_TYPE,
  LIDAR_FRAME_TYPE,
  CONSENT_SCOPE,
  CONSENT_PRIVACY_CLASS,
  MAX_LINE_BYTES,
  MAX_RECORDS,
  MAX_DWELL_PINGS,
  MAX_PROFILE_BINS,
  MAX_DWELL_SAMPLES,
  MAX_ID_BYTES,
  MAX_RANGE_M,
  MIN_PRF_HZ,
  MAX_PRF_HZ,
  MAX_CLOCK_SKEW_S,
  MAX_CONSENT_WINDOW_S,
  MAX_TEACHER_SAMPLES,
  POSE_VALUES,
  MAX_DEPTH_CONFIDENCE,
  sealTeacherLabel,
  openTeacherLabel,
} from './schema.js';
export type {
  CorpusSource,
  ConsentReceiptLine,
  CorpusClockLine,
  CorpusProvenanceLine,
  DwellMeasurementLine,
  TeacherLabelLine,
  PresencePairLine,
  DwellMeasurement,
  TeacherLabel,
  SealedTeacherLabel,
  ReconciledClock,
  ConsentReceipt,
  PairedDwell,
} from './schema.js';

export {
  CorpusError,
  parseCorpus,
  validateLine,
  encodeRecord,
  encodeLine,
  encodeCorpus,
} from './corpus.js';
export type { CorpusErrorCode, ParseOptions, EncodeRecordOptions } from './corpus.js';
