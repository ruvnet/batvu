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
