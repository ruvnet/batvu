// SPDX-License-Identifier: MIT
//
// The guard that was guarding nothing.
//
// `classifyEmission` has been tested since it was written, and every one of
// those tests passed. What none of them checked was whether anything called it
// on the path to the speaker. A security review of the integration work went
// looking for the call sites and found exactly one: the flywheel's simulated
// scorer. `AudioSession.start()` copied a waveform into an `AudioBuffer` and
// played it on a timer, and nothing in between asked whether it should.
//
// So these tests are not about the classifier's logic. They are about the wire.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SONAR_CONFIG, type SonarConfig } from '@batvu/core';
import { AudioSession } from '../src/audio.js';

const waveform = new Float32Array(64);

function options(sonar: Partial<SonarConfig> = {}, pingRateHz = 15) {
  return {
    waveform,
    config: { ...DEFAULT_SONAR_CONFIG, ...sonar },
    recordLen: 4096,
    pingRateHz,
  };
}

describe('the transmit path consults the emission guard', () => {
  it('refuses a band a child would hear, before it needs an audio context', () => {
    // `start()` on a session that was never opened normally fails with "open()
    // first". This asserts the emission check runs BEFORE that, which is what
    // makes it unbypassable: there is no ordering of calls that reaches the
    // speaker without passing it.
    const session = new AudioSession();
    expect(() => session.start(options({ f0: 12_000, f1: 15_000 }), () => {})).toThrow(
      /refusing to transmit/,
    );
  });

  it('refuses a level that would clip the speaker into the audible band', () => {
    const session = new AudioSession();
    expect(() => session.start(options({ amplitude: 0.97 }), () => {})).toThrow(
      /refusing to transmit/,
    );
  });

  it('refuses a duty cycle that is effectively continuous emission', () => {
    // 40 ms at 20 pings/s is 80% of wall clock with the speaker on.
    const session = new AudioSession();
    expect(() => session.start(options({ durationS: 0.04 }, 20), () => {})).toThrow(
      /refusing to transmit/,
    );
  });

  it('refuses a config carrying a NaN rather than classifying it as fine', () => {
    const session = new AudioSession();
    // Before the fix this returned `allow`: every comparison against NaN is
    // false, so a NaN did not fail the band check — it deleted it.
    expect(() => session.start(options({ f0: Number.NaN }), () => {})).toThrow(
      /refusing to transmit/,
    );
    expect(() => session.start(options({ fs: Number.NaN }), () => {})).toThrow(
      /refusing to transmit/,
    );
    expect(() => session.start(options({ durationS: Number.POSITIVE_INFINITY }), () => {})).toThrow(
      /refusing to transmit/,
    );
  });

  it('lets the shipping config through, and then fails for the ordinary reason', () => {
    // The gate must not be a blanket refusal. A default config reaches the
    // NEXT error, which is the one about not having opened a session — proof
    // the guard passed rather than that everything throws.
    const session = new AudioSession();
    expect(() => session.start(options(), () => {})).toThrow(/open\(\) the audio session first/);
  });
});
