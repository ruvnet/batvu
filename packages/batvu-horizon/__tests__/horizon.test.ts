// SPDX-License-Identifier: MIT
import { describe, expect, it, beforeAll } from 'vitest';
import { BatVuCore, DEFAULT_SONAR_CONFIG, ScanSession, type SonarConfig } from '@batvu/core';
import { emptyRoom, horizontalSweep, simulateScan } from '@batvu/sim';
import {
  DEFAULT_EMISSION_POLICY,
  DEFAULT_SCAN_DRIVER_CONFIG,
  ScanDriver,
  classifyEmission,
  interpret,
  isEmissionAllowed,
  loadHorizonCore,
} from '@batvu/horizon';
import type { HorizonCore } from '@metaharness/horizon';

let core: BatVuCore;
let hz: HorizonCore;

beforeAll(async () => {
  core = await BatVuCore.load();
  hz = await loadHorizonCore();
});

describe('the emission guard', () => {
  const cfg = (over: Partial<SonarConfig> = {}): SonarConfig => ({ ...DEFAULT_SONAR_CONFIG, ...over });

  it('allows the shipped operating point at its natural ping rate', () => {
    const c = classifyEmission(cfg(), 17);
    expect(c.verdict, JSON.stringify(c.findings)).toBe('allow');
    expect(isEmissionAllowed(cfg(), 17)).toBe(true);
  });

  it('denies a level that would clip and fold harmonics into the audible band', () => {
    const c = classifyEmission(cfg({ amplitude: 0.95 }), 17);
    expect(c.verdict).toBe('deny');
    expect(c.reasons.join(' ')).toMatch(/audible|clip/i);
  });

  it('denies a sweep that drops into the range children and pets hear', () => {
    const c = classifyEmission(cfg({ f0: 14_000, f1: 18_000 }), 17);
    expect(c.verdict).toBe('deny');
    expect(c.reasons.join(' ')).toMatch(/children|pets|floor/i);
  });

  it('denies aliasing outright', () => {
    const c = classifyEmission(cfg({ f1: 30_000 }), 17);
    expect(c.verdict).toBe('deny');
    expect(c.findings.some((f) => f.check === 'nyquist')).toBe(true);
  });

  it('catches a duty cycle that a per-ping level limit cannot see', () => {
    // Every individual parameter is fine. Together they mean the speaker is on
    // 40% of the time — which is the thing that actually governs exposure, and
    // exactly what an amplitude-only check misses.
    const c = classifyEmission(cfg({ amplitude: 0.6, durationS: 0.02 }), 20);
    expect(c.verdict).toBe('deny');
    expect(c.findings.some((f) => f.check === 'duty-cycle')).toBe(true);
  });

  it('gates an untapered pulse rather than denying it', () => {
    // A rectangular pulse clicks audibly on every ping. Unpleasant, not unsafe —
    // so it needs a decision, not a refusal.
    const c = classifyEmission(cfg({ txWindow: 'rect' }), 17);
    expect(c.verdict).toBe('gate');
  });

  it('takes the MAXIMUM severity, so a deny cannot hide behind a gate', () => {
    const c = classifyEmission(cfg({ txWindow: 'rect', amplitude: 0.99 }), 17);
    expect(c.verdict).toBe('deny');
    expect(c.findings.length).toBeGreaterThan(1);
    // `reasons` reports only the findings at the decisive severity.
    expect(c.reasons.every((r) => !r.includes('splatters'))).toBe(true);
  });

  it('rejects nonsense inputs instead of computing with them', () => {
    expect(classifyEmission(cfg({ amplitude: NaN }), 17).verdict).toBe('deny');
    expect(classifyEmission(cfg(), NaN).verdict).toBe('deny');
    expect(classifyEmission(cfg({ durationS: 0 }), 17).verdict).toBe('deny');
  });

  it('exposes a policy a deployment can tighten', () => {
    const strict = { ...DEFAULT_EMISSION_POLICY, maxAmplitude: 0.3 };
    expect(classifyEmission(cfg(), 17, strict).verdict).toBe('deny');
    expect(classifyEmission(cfg(), 17).verdict).toBe('allow');
  });
});

describe('halt reasons carry scan meaning', () => {
  it('reads no-progress as SUCCESS, not failure', () => {
    // The whole reason this layer exists: horizon treats a stalled loop as a bad
    // outcome, and for a scan it is the good one.
    expect(interpret('no-progress')).toBe('complete');
    expect(interpret('iteration-budget')).toBe('budget-exhausted');
    expect(interpret('repeated-failure')).toBe('capture-failed');
  });
});

describe('the scan driver', () => {
  function session(): ScanSession {
    return new ScanSession(core, { occupancy: { extentM: 4, voxelM: 0.15 } });
  }

  it('stops with `complete` when a sweep stops changing the map', () => {
    const s = session();
    const driver = new ScanDriver(hz, { ...DEFAULT_SCAN_DRIVER_CONFIG, noProgressLimit: 3 });
    const room = emptyRoom('box', 4, 5, 3);
    const poses = horizontalSweep(1, 0, 0, 0); // one fixed direction, forever
    const pings = simulateScan(core, room, poses, { seed: 7 });
    const samples = pings[0]!.samples;

    let outcome = driver.beforeSweep();
    expect(outcome.done).toBe(false);

    // Ping the same direction until the map saturates and stops changing.
    for (let i = 0; i < 40 && !outcome.done; i++) {
      const ping = s.pingWithBeam(samples, poses[0]!.beam);
      driver.observe(s, ping);
      outcome = driver.beforeSweep();
    }

    expect(outcome.done).toBe(true);
    if (outcome.done) {
      expect(outcome.reason).toBe('no-progress');
      expect(outcome.interpretation).toBe('complete');
    }
    s.destroy();
  });

  it('stops with `budget-exhausted` when the ping budget runs out first', () => {
    const s = session();
    const driver = new ScanDriver(hz, {
      ...DEFAULT_SCAN_DRIVER_CONFIG,
      maxIterations: 6,
      noProgressLimit: 99,
    });
    const room = emptyRoom('box', 4, 5, 3);
    const poses = horizontalSweep(30);
    const pings = simulateScan(core, room, poses, { seed: 11 });

    let outcome = driver.beforeSweep();
    for (let i = 0; i < pings.length && !outcome.done; i++) {
      const p = pings[i]!;
      driver.observe(s, s.pingWithBeam(p.samples, p.pose.beam));
      outcome = driver.beforeSweep();
    }
    expect(outcome.done).toBe(true);
    if (outcome.done) expect(outcome.interpretation).toBe('budget-exhausted');
    s.destroy();
  });

  it('does not treat one silent ping as a failure', () => {
    // Pointing at an open doorway returns nothing, and that silence is the
    // evidence that carves the doorway. Calling it a failure would abort every
    // scan of a room with a door in it.
    const s = session();
    const hall = emptyRoom('hall', 40, 40, 12); // every wall out of range
    const poses = horizontalSweep(3);
    const pings = simulateScan(core, hall, poses, { seed: 3 });

    const first = s.pingWithBeam(pings[0]!.samples, pings[0]!.pose.beam);
    expect(first.result.detections).toHaveLength(0);
    expect(s.failureSignature(first)).toBeNull();
    s.destroy();
  });

  it('quantises coverage so a hand-held sweep can ever repeat a signature', () => {
    const s = session();
    const driver = new ScanDriver(hz);
    const room = emptyRoom('box', 4, 5, 3);
    const pings = simulateScan(core, room, horizontalSweep(2), { seed: 5 });

    const a = s.pingWithBeam(pings[0]!.samples, pings[0]!.pose.beam);
    void a;
    const state = s.state();
    const sig1 = driver.progressSignature(state);
    // A hair of extra coverage inside the same bucket must not read as progress.
    const nudged = { ...state, coverage: state.coverage + 1e-6 };
    expect(driver.progressSignature(nudged)).toBe(sig1);
    // A real move to a new bearing does.
    const moved = { ...state, coverage: state.coverage + 0.2 };
    expect(driver.progressSignature(moved)).not.toBe(sig1);
    s.destroy();
  });
});

describe('checkpoints', () => {
  it('round-trips a scan and refuses a tampered one', () => {
    const s = new ScanSession(core, { occupancy: { extentM: 4, voxelM: 0.2 } });
    const driver = new ScanDriver(hz);
    const room = emptyRoom('box', 4, 5, 3);
    const pings = simulateScan(core, room, horizontalSweep(5), { seed: 42 });
    for (const p of pings) driver.observe(s, s.pingWithBeam(p.samples, p.pose.beam));

    const checkpoint = driver.checkpoint(s.state());
    expect(ScanDriver.verify(checkpoint)).toBe(true);
    expect(checkpoint.actionCount).toBe(5);
    expect(checkpoint.memoryCursor).toBe(s.state().signature);
    expect(checkpoint.budget.pingsUsed).toBe(5);

    const resumed = ScanDriver.restore(hz, checkpoint);
    expect(resumed.pingCount).toBe(5);

    // Hashed with horizon's own canonical hash, so an edit anywhere is caught.
    const tampered = { ...checkpoint, actionCount: 999 };
    expect(ScanDriver.verify(tampered)).toBe(false);
    expect(() => ScanDriver.restore(hz, tampered)).toThrow(/integrity/);
    s.destroy();
  });

  it('resumes the SAME run rather than starting a new one', () => {
    // The point of a checkpoint: the halt counters survive, so a scan that was
    // two pings from its budget is still two pings from its budget.
    const s = new ScanSession(core, { occupancy: { extentM: 4, voxelM: 0.2 } });
    const config = { ...DEFAULT_SCAN_DRIVER_CONFIG, maxIterations: 6, noProgressLimit: 99 };
    const driver = new ScanDriver(hz, config);
    const room = emptyRoom('box', 4, 5, 3);
    const pings = simulateScan(core, room, horizontalSweep(10), { seed: 8 });

    for (let i = 0; i < 4; i++) {
      driver.observe(s, s.pingWithBeam(pings[i]!.samples, pings[i]!.pose.beam));
    }
    expect(driver.beforeSweep().done).toBe(false);

    const resumed = ScanDriver.restore(hz, driver.checkpoint(s.state()), config);
    for (let i = 4; i < 8; i++) {
      resumed.observe(s, s.pingWithBeam(pings[i]!.samples, pings[i]!.pose.beam));
    }
    const outcome = resumed.beforeSweep();
    expect(outcome.done).toBe(true);
    if (outcome.done) expect(outcome.interpretation).toBe('budget-exhausted');
    s.destroy();
  });
});
