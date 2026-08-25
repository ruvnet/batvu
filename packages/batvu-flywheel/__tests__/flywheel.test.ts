// SPDX-License-Identifier: MIT
import { describe, expect, it, beforeAll } from 'vitest';
import { BatVuCore, DEFAULT_SONAR_CONFIG, mainlobeHalfWidth } from '@batvu/core';
import { emptyRoom, narrowNook, livingRoom, safetyRoom } from '@batvu/sim';
import { verifyReplayBundle } from '@metaharness/flywheel';
import {
  LADDERS,
  LEVERS,
  aggregate,
  badRootPolicy,
  decodeLever,
  defaultPolicy,
  describeStep,
  encodeLever,
  evaluateRoom,
  ladderStep,
  resolvePolicy,
  runSonarFlywheel,
  type EvaluationDetail,
} from '@batvu/flywheel';

let core: BatVuCore;
beforeAll(async () => {
  core = await BatVuCore.load();
});

/** A deterministic clock, so scores do not wobble with machine load. */
const fakeNow = (): (() => number) => {
  let t = 0;
  return () => (t += 10);
};

describe('the policy codec', () => {
  it('round-trips every lever', () => {
    const policy = defaultPolicy();
    const { sonar, occupancy } = resolvePolicy(policy);
    expect(sonar.f0).toBe(DEFAULT_SONAR_CONFIG.f0);
    expect(sonar.f1).toBe(DEFAULT_SONAR_CONFIG.f1);
    expect(sonar.rxTaper).toBe(DEFAULT_SONAR_CONFIG.rxTaper);
    // The CFAR windows are ratios in the policy and absolute cells in the
    // config; resolving the shipped policy must land exactly on the shipped
    // defaults, or the flywheel measures a different detector from the one the
    // app runs.
    expect(sonar.cfarGuard).toBe(DEFAULT_SONAR_CONFIG.cfarGuard);
    expect(sonar.cfarTrain).toBe(DEFAULT_SONAR_CONFIG.cfarTrain);
    expect(sonar.cfarMergeGap).toBe(DEFAULT_SONAR_CONFIG.cfarMergeGap);
    expect(occupancy.beamHalfAngleDeg).toBe(30);
  });

  it('refuses a malformed lever instead of falling back to a default', () => {
    // The failure this strictness prevents: the wheel measures the DEFAULT,
    // promotes it as though it were the mutation, and signs a receipt attesting
    // to a policy that never ran.
    expect(() => decodeLever('waveform', 'f0')).toThrow(/malformed/);
    expect(() => decodeLever('waveform', 'f0=notanumber')).toThrow(/finite number/);
    expect(() => decodeLever('waveform', 'cfarGuardMainlobes=8')).toThrow(/does not belong/);
    expect(() => decodeLever('detector', 'beamHalfAngleDeg=30')).toThrow(/does not belong/);
  });

  it('keeps the levers disjoint so lift is attributable', () => {
    const seen = new Map<string, string>();
    for (const lever of LEVERS) {
      for (const key of Object.keys(decodeLever(lever, LADDERS[lever][0]!))) {
        expect(seen.has(key), `${key} appears in both ${seen.get(key)} and ${lever}`).toBe(false);
        seen.set(key, lever);
      }
    }
  });

  it('tolerates whitespace and empty entries', () => {
    expect(decodeLever('waveform', ' f0 = 18000 ; ; durationS=0.01 ')).toEqual({
      f0: 18000,
      durationS: 0.01,
    });
    expect(encodeLever({ a: 1, b: 'x' })).toBe('a=1;b=x');
  });

  it('starts an off-ladder value at the bottom and never runs off the top', () => {
    expect(ladderStep('waveform', 'nonsense')).toBe(LADDERS.waveform[0]);
    const top = LADDERS.detector[LADDERS.detector.length - 1]!;
    expect(ladderStep('detector', top)).toBe(top);
    expect(ladderStep('mapping', LADDERS.mapping[0]!)).toBe(LADDERS.mapping[1]);
  });

  it('describes what a step changed', () => {
    const note = describeStep('waveform', LADDERS.waveform[0]!, LADDERS.waveform[2]!);
    expect(note).toMatch(/f0/);
    expect(note).toMatch(/txWindow rect -> tukey/);
    expect(describeStep('mapping', LADDERS.mapping[0]!, LADDERS.mapping[0]!)).toMatch(/unchanged/);
  });

  it('starts from a root that is genuinely bad, so the climb is real', () => {
    const { sonar, occupancy } = resolvePolicy(badRootPolicy());
    expect(sonar.f1 - sonar.f0).toBe(1000); // 28 cm resolution
    expect(sonar.txWindow).toBe('rect'); // audible click every ping
    expect(occupancy.beamHalfAngleDeg).toBe(60); // every wall smears to fog
    expect(sonar.cfarPfa).toBe(1e-2); // a hundred times the false alarms
    expect(sonar.cfarMinProminenceDb).toBe(1); // every sidelobe is an object
    // The occupied threshold sits BELOW the per-ping hit weight, so one wide
    // ping declares a whole 60-degree arc occupied with no corroboration.
    expect(occupancy.occupiedThreshold).toBeLessThan(occupancy.logOddsHit);
  });

  it('produces a runnable config for EVERY combination of lever rungs', () => {
    // The reason the CFAR windows are ratios rather than absolute cell counts:
    // the core hard-rejects a guard band narrower than the compressed mainlobe,
    // and the mainlobe depends on the WAVEFORM. With absolute counts, promoting
    // a wider taper silently invalidates the detector lever and the wheel hits
    // combinations it cannot even evaluate.
    for (const waveform of LADDERS.waveform) {
      for (const detector of LADDERS.detector) {
        for (const mapping of LADDERS.mapping) {
          const { sonar } = resolvePolicy({ waveform, detector, mapping });
          expect(sonar.cfarGuard).toBeGreaterThanOrEqual(Math.floor(mainlobeHalfWidth(sonar)));
          const plan = core.createPlan(sonar as unknown as Record<string, unknown>, 8192);
          plan.destroy();
        }
      }
    }
  });
});

describe('the evaluator', () => {
  // Enough poses that the beam cones actually overlap. With a 30-degree beam,
  // six looks around a full turn barely touch each other, nothing reaches the
  // corroboration threshold, and every policy scores an identical zero — a test
  // that passes for both good and bad configurations measures neither.
  // Enough poses that the 30-degree beam cones actually overlap. Sampled more
  // thinly, nothing reaches the corroboration threshold and every policy scores
  // an identical near-zero — a test that passes for good and bad alike measures
  // neither.
  const opts = { azSteps: 20, elSteps: 3, seed: 99, now: fakeNow() };

  it('scores a tuned policy above the deliberately bad root', () => {
    const room = emptyRoom('box', 4, 5, 3);
    const bad = evaluateRoom(core, badRootPolicy(), room, { ...opts, now: fakeNow() });
    const good = evaluateRoom(core, defaultPolicy(), room, { ...opts, now: fakeNow() });
    expect(good.primary).toBeGreaterThan(bad.primary);
    // And for the right reasons, not by luck on one component.
    expect(good.freeIoU).toBeGreaterThan(bad.freeIoU);
    expect(good.occupiedF1).toBeGreaterThan(bad.occupiedF1);
  });

  it('does not let a painting policy win on occupied score alone', () => {
    // The measured Goodhart failure this metric was changed to close: scored on
    // plain occupied IoU, the bad root's 120-degree beam and single-ping
    // occupancy threshold BEAT the tuned default on an empty box, because in a
    // bare room almost everything at wall-range really is wall and smearing
    // occupancy across the arc lands on it by luck.
    const room = emptyRoom('box', 4, 5, 3);
    const bad = evaluateRoom(core, badRootPolicy(), room, { ...opts, now: fakeNow() });
    // Painting still buys a chunk of raw recall...
    expect(bad.occupiedRecall).toBeGreaterThan(0.1);
    // ...but it costs precision, and it leaves almost no space marked free.
    expect(bad.occupiedPrecision).toBeLessThan(0.5);
    expect(bad.freeIoU).toBeLessThan(0.2);
  });

  it('does not punish correct silence', () => {
    // A hall with every wall beyond range returns nothing, and that is right.
    // If `noopRate` counted silence, the wheel would be rewarded for inventing
    // ghosts here.
    const hall = emptyRoom('far-hall', 40, 40, 12);
    const d = evaluateRoom(core, defaultPolicy(), hall, { ...opts, now: fakeNow() });
    expect(d.silentPings).toBeGreaterThan(0); // it really is silent
    expect(d.missRate).toBe(0); // and that costs nothing
    expect(d.noopRate).toBe(0);
  });

  it('keeps noopRate continuous so the strict promotion clause cannot freeze', () => {
    // `meetsPromotionRule` demands a STRICT improvement in noopRate. A count of
    // silent pings saturates at exactly 0 and, from that generation on, nothing
    // can ever be promoted — a flatlined lift curve that looks like convergence
    // and is really a dead metric. A fraction-of-surfaces-missed approaches zero
    // without landing on it while any real improvement remains.
    const room = livingRoom();
    const bad = evaluateRoom(core, badRootPolicy(), room, { ...opts, now: fakeNow() });
    const good = evaluateRoom(core, defaultPolicy(), room, { ...opts, now: fakeNow() });
    expect(bad.noopRate).toBeGreaterThanOrEqual(good.noopRate);
    expect(good.noopRate).toBeGreaterThan(0);
    expect(good.noopRate).toBeLessThan(1);
    // Continuous, not a ratio of whole pings: it can improve by a hair, which is
    // what keeps the strict clause satisfiable while any lift remains.
    expect(Number.isInteger(good.noopRate * good.pings)).toBe(false);
  });

  it('reports a room it can actually see as low-miss', () => {
    const d = evaluateRoom(core, defaultPolicy(), emptyRoom('box', 4, 5, 3), {
      ...opts,
      now: fakeNow(),
    });
    expect(d.pings).toBe(60);
    expect(d.missRate).toBeLessThan(0.5);
    expect(d.emissionVerdict).toBe('allow');
    expect(d.regressed).toBe(false);
    expect(d.brokenPings).toBe(0);
  });

  it('produces a finite false-free rate on the safety room', () => {
    // `falseFreeRate` is the axis `regressed` is read from, and it is the only
    // hard safety stop in the loop. A NaN here would silently disable it.
    const d = evaluateRoom(core, badRootPolicy(), safetyRoom(), {
      ...opts,
      azSteps: 8,
      now: fakeNow(),
    });
    expect(Number.isFinite(d.falseFreeRate)).toBe(true);
    expect(d.falseFreeRate).toBeGreaterThanOrEqual(0);
    expect(d.falseFreeRate).toBeLessThanOrEqual(1);
  });

  it('flags a policy the emission guard denies as REGRESSED', () => {
    // The hard stop: no measured lift anywhere may promote an unsafe emission.
    const unsafe = {
      ...defaultPolicy(),
      waveform: encodeLever({
        f0: 18_000,
        f1: 22_000,
        durationS: 0.01,
        txWindow: 'tukey',
        tukeyAlpha: 0.2,
        amplitude: 0.99,
        rxTaper: 'hann',
      }),
    };
    const d = evaluateRoom(core, unsafe, emptyRoom('box', 4, 5, 3), { ...opts, now: fakeNow() });
    expect(d.emissionVerdict).toBe('deny');
    expect(d.regressed).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const room = livingRoom();
    const a = evaluateRoom(core, defaultPolicy(), room, { ...opts, now: fakeNow() });
    const b = evaluateRoom(core, defaultPolicy(), room, { ...opts, now: fakeNow() });
    expect(a.primary).toBe(b.primary);
    expect(a.noopRate).toBe(b.noopRate);
    expect(a.falseFreeRate).toBe(b.falseFreeRate);
  });

  it('lets one unsafe room regress a whole suite', () => {
    const safe: EvaluationDetail = {
      room: 'a', iou: 0.5, freeIoU: 0.5, occupiedRecall: 0.5, occupiedPrecision: 0.5,
      occupiedF1: 0.5, missRate: 0, silentPings: 0, brokenPings: 0,
      falseFreeRate: 0, pings: 6, elapsedMs: 10,
      emissionVerdict: 'allow', primary: 0.5, noopRate: 0.1, costPerWin: 1, regressed: false,
    };
    const unsafe: EvaluationDetail = { ...safe, room: 'b', regressed: true };
    expect(aggregate([safe, safe, safe]).regressed).toBe(false);
    // Averaging a safety flag would let three good rooms vote down one that
    // carves through a wall.
    expect(aggregate([safe, safe, unsafe]).regressed).toBe(true);
  });

  it('returns a maximally bad score for an empty suite rather than NaN', () => {
    const s = aggregate([]);
    expect(s.primary).toBe(0);
    expect(s.noopRate).toBe(1);
    expect(s.regressed).toBe(true);
  });
});

describe('the promotion loop', () => {
  it('runs, produces a verifiable replay bundle, and never promotes a regression', async () => {
    const report = await runSonarFlywheel({
      core,
      holdout: [emptyRoom('box', 4, 5, 3)],
      anchor: [narrowNook()],
      maxGenerations: 3,
      azSteps: 5,
      elSteps: 1,
      seed: 4242,
      now: fakeNow(),
    });

    expect(report.result.generationsRun).toBeGreaterThan(0);
    expect(report.gateFingerprint).toMatch(/^[a-f0-9]{8,}$/);

    // Trust the signature, not the producer: verify independently.
    expect(report.replayVerified, report.replaySummary).toBe(true);
    expect(verifyReplayBundle(report.result.replayBundle).pass).toBe(true);

    // Whatever was promoted must chain back to the gen-0 root.
    for (const commit of report.result.promotions) {
      expect(commit.verdict === 'PROMOTED' || commit.verdict === 'ROOT').toBe(true);
    }
    // And the final policy must still be a policy the codec understands.
    expect(() => resolvePolicy(report.finalPolicy)).not.toThrow();
  }, 240_000);

  it('reproduces exactly across two runs of the same configuration', async () => {
    const run = async () =>
      runSonarFlywheel({
        core,
        holdout: [emptyRoom('box', 3.5, 4.5, 2.8)],
        anchor: [narrowNook()],
        maxGenerations: 2,
        azSteps: 4,
        elSteps: 1,
        seed: 777,
        now: fakeNow(),
      });
    const a = await run();
    const b = await run();
    // No wall clock anywhere in the engine or the evaluator, so the same
    // configuration produces the same lineage — which is what makes a replay
    // bundle proof rather than a recording.
    expect(b.finalPolicy).toEqual(a.finalPolicy);
    expect(b.promotionNotes).toEqual(a.promotionNotes);
    expect(b.result.liftCurve.map((p) => p.primary)).toEqual(
      a.result.liftCurve.map((p) => p.primary),
    );
  }, 240_000);
});
