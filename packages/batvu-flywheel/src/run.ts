// SPDX-License-Identifier: MIT
//
// Wiring BatVu into `@metaharness/flywheel`'s promotion loop.
//
// Freeze the physics. Evolve the operating policy. Promote only what proves lift.
//
// The engine is used UNMODIFIED, including its default gate. That is deliberate,
// and it was tested: `meetsPromotionRule` is conjunctive and frozen, and its
// second clause — the no-op rate must strictly improve — is the strictest thing
// in it. Twice during development the gate refused to promote anything, and both
// times the honest fix was the projection, not the gate.
//
// The second of those is the instructive one. With `noopRate` defined as the
// MISS rate, tightening the detector improved `primary` from 0.056 to 0.107 and
// cut `costPerWin` by two thirds — and the gate rejected it, because a stricter
// detector misses more. The single most useful class of change was structurally
// unpromotable. Relaxing the gate would have hidden that; fixing the axis
// exposed it. A miss is an ERROR and belongs to `primary`; a no-op is an
// ABSTENTION, which for a scan means map volume left undecided. See
// `evaluator.ts`.
//
// One consequence worth stating plainly: once the wheel has nothing left to
// commit, the lift curve goes flat. That is convergence, not a bug to gate
// around.

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
 * The proposer is deterministic and model-free — a step up a lever's ladder. No
 * network, no model call, so the whole run reproduces in CI and its replay
 * bundle verifies offline. The ladders encode a physics hypothesis; the gate is
 * what decides whether the hypothesis held on this suite.
 *
 * The `waveform` lever used to be the one the gate never promoted, and that
 * turned out to be a fact about the SIMULATOR rather than about the waveform.
 * With the near-field dynamic range corrected (ADR-022) the link budget is
 * roughly 26 dB tighter, far returns are genuinely marginal, and bandwidth and
 * taper start to pay for themselves. The wheel now walks the waveform ladder to
 * 17.5-20.5 kHz, 5 ms, full Hann — which is the operating point ADR-003 and
 * ADR-004 argued for by hand, arrived at independently from a deliberately bad
 * root. That agreement is worth more than either result alone, and it was
 * invisible while the physics was wrong.
 */
export async function runSonarFlywheel(
  options: SonarFlywheelOptions = {},
): Promise<SonarFlywheelReport> {
  const core = options.core ?? (await BatVuCore.load());
  const rootPolicy = options.rootPolicy ?? badRootPolicy();
  const holdout = options.holdout ?? holdoutRooms();
  const anchor = options.anchor ?? anchorRooms();

  const notes: string[] = [];

  // How many times each lever has been proposed without being promoted. Stateful
  // on purpose (see `ladderStep`): a stride-1 proposer re-offers a rejected rung
  // forever. It stays fully DETERMINISTIC — the counter advances identically in
  // every run of the same configuration — and replay verification re-runs the
  // GATE over sealed scores, never the proposer, so nothing about the audit
  // trail depends on the proposer being stateless.
  const attempts = new Map<Lever, number>();
  const result = await runFlywheelGenerations({
    rootPolicy,
    proposer: async (base, target) => {
      const lever = target as Lever;
      const current = base.policy[lever] ?? '';
      const stride = (attempts.get(lever) ?? 0) + 1;
      attempts.set(lever, stride);
      const next = ladderStep(lever, current, stride);
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
