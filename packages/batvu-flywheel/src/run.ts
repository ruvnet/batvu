// SPDX-License-Identifier: MIT
//
// Wiring BatVu into `@metaharness/flywheel`'s promotion loop.
//
// Freeze the physics. Evolve the operating policy. Promote only what proves lift.
//
// The engine is used UNMODIFIED, including its default gate. That is deliberate:
// `meetsPromotionRule` is conjunctive and frozen, and its second clause — the
// no-op rate must strictly improve — is the strictest thing in it. A domain that
// cannot honestly satisfy that clause is a domain whose `noopRate` has been
// mapped badly, and the temptation is to relax the gate rather than fix the
// mapping. See `evaluator.ts` for the mapping this project defends: `noopRate`
// is the MISS rate, so "make the executor commit more" reads, correctly, as
// "stop dropping echoes the room actually returned".
//
// One consequence worth stating plainly: once the miss rate bottoms out, nothing
// can be promoted, and the lift curve goes flat. That is the wheel telling you
// it has converged — not a bug to gate around.

import { BatVuCore } from '@batvu/core';
import { anchorRooms, holdoutRooms, type Room } from '@batvu/sim';
import {
  gateFingerprint,
  makeSigner,
  meetsPromotionRule,
  runFlywheelGenerations,
  verifyReplayBundle,
  type FlywheelResult,
} from '@metaharness/flywheel';
import { makeEvaluator, type EvaluatorOptions } from './evaluator.js';
import { LEVERS, badRootPolicy, describeStep, ladderStep, type Lever, type SonarPolicy } from './policy.js';

export interface SonarFlywheelOptions extends EvaluatorOptions {
  core?: BatVuCore;
  rootPolicy?: SonarPolicy;
  holdout?: Room[];
  anchor?: Room[];
  maxGenerations?: number;
  /** Reuse a (policy, suite) score already measured this run. Safe here: the
   *  evaluator is deterministic given its seed, so a repeat measurement would
   *  return the identical number at full cost. */
  cacheEvaluations?: boolean;
}

export interface SonarFlywheelReport {
  result: FlywheelResult;
  /** Independent verification of the replay bundle — trust the signature, not us. */
  replayVerified: boolean;
  replaySummary: string;
  /** sha256 of the promotion rule's source: proof the gate never moved. */
  gateFingerprint: string;
  rootPolicy: SonarPolicy;
  finalPolicy: SonarPolicy;
  /** What each promotion actually changed, in English. */
  promotionNotes: string[];
}

/**
 * Run the wheel.
 *
 * The proposer is deterministic and model-free — one rung up a lever's ladder,
 * chosen purely from the current value. No network, no model call, so the whole
 * run reproduces in CI and its replay bundle verifies offline. The ladders
 * encode a physics hypothesis; the gate is what decides whether the hypothesis
 * was right on this suite.
 */
export async function runSonarFlywheel(
  options: SonarFlywheelOptions = {},
): Promise<SonarFlywheelReport> {
  const core = options.core ?? (await BatVuCore.load());
  const rootPolicy = options.rootPolicy ?? badRootPolicy();
  const holdout = options.holdout ?? holdoutRooms();
  const anchor = options.anchor ?? anchorRooms();

  const notes: string[] = [];
  const result = await runFlywheelGenerations({
    rootPolicy,
    proposer: async (base, target) => {
      const lever = target as Lever;
      const current = base.policy[lever] ?? '';
      const next = ladderStep(lever, current);
      const summary = describeStep(lever, current, next);
      return { value: next, summary };
    },
    evaluator: makeEvaluator(core, options),
    promotionRule: meetsPromotionRule,
    holdout: { id: 'holdout-rooms', items: holdout },
    anchor: { id: 'anchor-rooms', items: anchor },
    mutationTargets: [...LEVERS],
    maxGenerations: options.maxGenerations ?? 6,
    signer: makeSigner(),
    cacheEvaluations: options.cacheEvaluations ?? true,
    // No wall clock anywhere in the run: a generation is labelled by its index,
    // so two runs of the same configuration produce byte-identical lineage.
    now: (generation) => `gen-${generation}`,
    dataSource: 'SYNTHETIC',
  });

  for (const commit of result.promotions) {
    if (commit.mutation) {
      notes.push(`gen${commit.generation}: ${commit.mutation.summary}`);
    }
  }

  const verdict = verifyReplayBundle(result.replayBundle);
  return {
    result,
    replayVerified: verdict.pass,
    replaySummary: verdict.chainSummary,
    gateFingerprint: gateFingerprint(meetsPromotionRule),
    rootPolicy,
    finalPolicy: result.finalPolicy,
    promotionNotes: notes,
  };
}
