// SPDX-License-Identifier: MIT
//
// The emission guard: what the phone is allowed to transmit.
//
// `@metaharness/horizon` ships a `CommandGuard` for shell commands. BatVu runs
// no shell commands, so copying it would be a veneer. But the SHAPE of that
// guard — classify every part of a request, take the maximum severity, and
// default an unknown to `gate` rather than `allow` — is exactly what is needed
// for the risk this project actually has, and the reason is the flywheel.
//
// `@batvu/flywheel` mutates the sonar's operating policy, and the levers it
// mutates include `amplitude`, `f0`, `f1`, `durationS` and the ping rate. Those
// are not abstract numbers: they are how loud the speaker is driven, in what
// band, and for what fraction of the time. An optimiser rewarded for detection
// quality will happily discover that louder and longer scores better, and will
// walk the transmit level up until the speaker clips — which folds harmonics
// down into the audible band, defeating the entire point of an ultrasonic
// sensor — or down into frequencies that children, dogs and cats hear perfectly
// well.
//
// So the guard is not decoration. It is the thing standing between a scoring
// function and a phone that shrieks. It is checked before any policy is used,
// and a `deny` sets the flywheel's `regressed` flag, which is a hard promotion
// stop no amount of measured lift can override.
//
// ## The severities
//
// `allow < gate < deny`, and the verdict is the MAX across every check — the
// same rule CommandGuard uses so a dangerous parameter cannot hide behind
// several benign ones.

import type { SonarConfig } from '@batvu/core';

export type EmissionVerdict = 'allow' | 'gate' | 'deny';

export interface EmissionFinding {
  check: string;
  verdict: EmissionVerdict;
  detail: string;
}

export interface EmissionClassification {
  verdict: EmissionVerdict;
  findings: EmissionFinding[];
  /** Only the findings at the overall verdict's severity. */
  reasons: string[];
}

export interface EmissionPolicy {
  /** Hardest the speaker may be driven, 0..1 of full scale. Above this the
   *  ultrasonic chirp clips and its harmonics land in the audible band. */
  maxAmplitude: number;
  /** Lowest frequency that may be emitted at full level. Below this a young
   *  listener hears it directly. */
  minFrequencyHz: number;
  /** Frequencies above this are inaudible to everyone but also unusable — the
   *  phone's speaker and mic have both rolled off, so a config that reaches
   *  here is not being quiet, it is being broken. */
  maxFrequencyHz: number;
  /** Fraction of wall-clock the transmitter may be active. The number that
   *  actually governs exposure and battery, and the one a per-ping amplitude
   *  limit alone does not constrain at all. */
  maxDutyCycle: number;
  /** Longest single pulse. */
  maxPulseSeconds: number;
  /** Pings per second above which a session is emitting near-continuously. */
  maxPingRateHz: number;
}

/**
 * Conservative by construction: it prefers to gate a workable config over
 * allowing an unpleasant one, because the cost of a false gate is one flywheel
 * candidate rejected and the cost of a false allow is a device that hurts to
 * be near.
 */
export const DEFAULT_EMISSION_POLICY: EmissionPolicy = {
  maxAmplitude: 0.8,
  minFrequencyHz: 17_500,
  maxFrequencyHz: 23_000,
  maxDutyCycle: 0.35,
  maxPulseSeconds: 0.05,
  maxPingRateHz: 25,
};

const ORDER: Record<EmissionVerdict, number> = { allow: 0, gate: 1, deny: 2 };

function worst(a: EmissionVerdict, b: EmissionVerdict): EmissionVerdict {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/**
 * Classify a complete emission plan.
 *
 * `pingRateHz` matters as much as the per-ping parameters and is a separate
 * argument on purpose: amplitude and duration are properties of the config, but
 * duty cycle is a property of the SESSION, and a guard that only ever sees the
 * config cannot see the risk.
 */
export function classifyEmission(
  config: SonarConfig,
  pingRateHz: number,
  policy: EmissionPolicy = DEFAULT_EMISSION_POLICY,
): EmissionClassification {
  const findings: EmissionFinding[] = [];
  const add = (check: string, verdict: EmissionVerdict, detail: string): void => {
    findings.push({ check, verdict, detail });
  };

  // ── finiteness, first, before any comparison ─────────────────────────────
  //
  // Every check below is a comparison, and every comparison against NaN is
  // FALSE — including the negated ones. So a single NaN does not fail a check,
  // it DELETES it, and the guard returns `allow` having examined nothing. A
  // security review found four of these at once: `f0: NaN` erased both band
  // checks (`Math.min(NaN, f1)` is NaN), `fs: NaN` erased the aliasing check by
  // making Nyquist NaN, `tukeyAlpha: NaN` erased the taper gate, and
  // `durationS: Infinity` — a transmitter that never stops — came back `gate`
  // because the duty-cycle check skipped a non-finite duty.
  //
  // These are not hypothetical inputs. The flywheel mutates exactly these
  // fields, and a division inside a proposer is all it takes.
  const numbers: Array<[string, number]> = [
    ['fs', config.fs],
    ['f0', config.f0],
    ['f1', config.f1],
    ['durationS', config.durationS],
    ['amplitude', config.amplitude],
    ['pingRateHz', pingRateHz],
  ];
  if (config.txWindow === 'tukey') numbers.push(['tukeyAlpha', config.tukeyAlpha]);
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value)) {
      add('finite', 'deny', `${name} is ${value}; a guard cannot classify what it cannot compare`);
    }
  }

  // ── level ────────────────────────────────────────────────────────────────
  if (!Number.isFinite(config.amplitude) || config.amplitude < 0) {
    add('amplitude', 'deny', `amplitude ${config.amplitude} is not a usable level`);
  } else if (config.amplitude > 1) {
    add('amplitude', 'deny', `amplitude ${config.amplitude.toFixed(2)} clips outright`);
  } else if (config.amplitude > policy.maxAmplitude) {
    add(
      'amplitude',
      'deny',
      `amplitude ${config.amplitude.toFixed(2)} exceeds the ${policy.maxAmplitude} ceiling; ` +
        'a clipped ultrasonic chirp folds harmonics into the audible band',
    );
  }

  // ── band ─────────────────────────────────────────────────────────────────
  const lo = Math.min(config.f0, config.f1);
  const hi = Math.max(config.f0, config.f1);
  if (lo < policy.minFrequencyHz) {
    add(
      'band',
      'deny',
      `sweep starts at ${lo.toFixed(0)} Hz, below the ${policy.minFrequencyHz} Hz floor; ` +
        'children and pets hear well above where adults stop',
    );
  }
  if (hi > policy.maxFrequencyHz) {
    add('band', 'gate', `sweep reaches ${hi.toFixed(0)} Hz, past usable speaker and mic response`);
  }
  const nyquist = config.fs / 2;
  if (hi >= nyquist) {
    add('nyquist', 'deny', `sweep reaches ${hi.toFixed(0)} Hz but Nyquist is ${nyquist} Hz — it aliases`);
  }

  // ── time ─────────────────────────────────────────────────────────────────
  if (!(config.durationS > 0)) {
    add('duration', 'deny', 'pulse duration must be positive');
  } else if (config.durationS > policy.maxPulseSeconds) {
    add('duration', 'gate', `pulse of ${(config.durationS * 1000).toFixed(0)} ms is unusually long`);
  }

  if (!(pingRateHz >= 0) || !Number.isFinite(pingRateHz)) {
    add('ping-rate', 'deny', `ping rate ${pingRateHz} is not a rate`);
  } else if (pingRateHz > policy.maxPingRateHz) {
    add('ping-rate', 'gate', `${pingRateHz.toFixed(1)} pings/s is close to continuous emission`);
  }

  const duty = Math.max(0, config.durationS) * Math.max(0, pingRateHz);
  if (!Number.isFinite(duty)) {
    // Deny, not skip. A non-finite duty cycle is an unbounded transmitter, and
    // "we could not compute it" is the worst possible reason to allow one.
    add('duty-cycle', 'deny', `duty cycle is ${duty}, which is not a fraction of anything`);
  } else if (duty > policy.maxDutyCycle) {
    add(
      'duty-cycle',
      'deny',
      `duty cycle ${(duty * 100).toFixed(0)}% exceeds ${(policy.maxDutyCycle * 100).toFixed(0)}%; ` +
        'per-ping level says nothing about how much of the time the speaker is on',
    );
  }

  // ── taper ────────────────────────────────────────────────────────────────
  // A hard-edged pulse splatters energy far outside the sweep, and the part
  // below ~17 kHz is an audible click on every single ping.
  if (config.txWindow === 'rect') {
    add('taper', 'gate', 'an untapered pulse splatters audible energy on every ping');
  } else if (config.txWindow === 'tukey' && config.tukeyAlpha < 0.05) {
    add('taper', 'gate', `tukeyAlpha ${config.tukeyAlpha} is barely a taper at all`);
  }

  const verdict = findings.reduce<EmissionVerdict>((acc, f) => worst(acc, f.verdict), 'allow');
  return {
    verdict,
    findings,
    reasons: findings.filter((f) => f.verdict === verdict).map((f) => f.detail),
  };
}

/** Convenience: is this config safe to transmit without a human deciding? */
export function isEmissionAllowed(
  config: SonarConfig,
  pingRateHz: number,
  policy?: EmissionPolicy,
): boolean {
  return classifyEmission(config, pingRateHz, policy).verdict === 'allow';
}
