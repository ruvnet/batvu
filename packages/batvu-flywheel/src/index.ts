// SPDX-License-Identifier: MIT
//
// @batvu/flywheel — freeze the physics, evolve the operating policy.
//
// The sonar's parameters are not obvious. Whether a wider sweep beats a longer
// pulse, whether ordered-statistic CFAR earns its sort in a cluttered room,
// where the occupied threshold belongs — these are empirical questions with
// answers that differ by room. Hand-tuning produces a configuration nobody can
// justify six months later; this produces a signed, replayable lineage in which
// every promotion cites the holdout it beat and the frozen anchor it did not
// regress.
//
// The promotion engine is `@metaharness/flywheel`, used unmodified with its
// default frozen gate. The sonar meaning lives entirely in `evaluator.ts` — the
// engine never learns what a chirp is, which is its design rule and the reason
// it can be trusted to be impartial.

export {
  LEVERS,
  LADDERS,
  badRootPolicy,
  defaultPolicy,
  encodeLever,
  decodeLever,
  resolvePolicy,
  ladderStep,
  describeStep,
} from './policy.js';
export type { SonarPolicy, Lever, ResolvedPolicy } from './policy.js';

export { evaluateRoom, aggregate, makeEvaluator } from './evaluator.js';
export type { Score, EvaluationDetail, EvaluatorOptions } from './evaluator.js';

export { runSonarFlywheel } from './run.js';
export type { SonarFlywheelOptions, SonarFlywheelReport } from './run.js';

// ADR-023 §3's second wheel: same engine, same signer, same frozen gate, but
// scored against a corpus of real captures rather than simulated rooms. It is
// exported here so its refusals are reachable from outside a test file — a
// refusal nothing can call is a refusal nobody has to pass.
export {
  DETECTOR_LEVERS,
  DETECTOR_LADDERS,
  badRootDetectorPolicy,
  decodeDetectorLever,
  describeDetectorStep,
  detectorLadderStep,
  resolveDetectorPolicy,
} from './detector-policy.js';
export type {
  DetectorPolicy,
  DetectorLever,
  ResolvedDetectorPolicy,
  ResolvedDwellOptions,
} from './detector-policy.js';

export {
  AttestedCorpus,
  DETECTOR_PROMOTION_RULE,
  MICROMOTION_ANALYZER,
  NoEvidenceError,
  aggregateDetectorDetails,
  captureFromPairedDwell,
  evaluateCapture,
  makeDetectorEvaluator,
  runDetectorFlywheel,
  splitCorpusByRoomAndSubject,
} from './detector-evaluator.js';
export type {
  AttestCorpusInput,
  CaptureEvaluation,
  CaptureOutcome,
  CaptureRecord,
  ComplexProfileDwell,
  ConsentReceipt,
  CorpusSplit,
  DetectorEvaluatorOptions,
  DetectorFlywheelOptions,
  DetectorFlywheelReport,
  DetectorSuiteScore,
  DwellAnalyzer,
  MicroMotionBin,
  MicroMotionDwell,
  TeacherLabel,
} from './detector-evaluator.js';
